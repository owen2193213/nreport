import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { Pool, PoolClient, QueryResultRow } from "pg";
import type { AdminAccountView, AdminCreateAccountInput, ApiAccountView } from "@nreport/contracts";

const API_KEY_PATTERN = /^dsa_live_([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})_([A-Za-z0-9_-]{43})$/;
const USERNAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{2,31}$/;

export class ApiKeyError extends Error {
  public readonly code = "invalid_api_key_operation";
  public readonly statusCode = 409;

  public constructor(message: string) {
    super(message);
    this.name = "ApiKeyError";
  }
}

export class CreditError extends Error {
  public constructor(
    public readonly code: "account_not_found" | "credits_would_be_negative",
    message: string
  ) {
    super(message);
    this.name = "CreditError";
  }
}

export class AccountError extends Error {
  public constructor(
    public readonly code: "account_not_found" | "username_conflict",
    message: string
  ) {
    super(message);
    this.name = "AccountError";
  }
}

export interface IssuedApiKey {
  keyId: string;
  prefix: string;
  secret: string;
  plaintext: string;
}

export function createApiKey(): IssuedApiKey {
  const keyId = randomUUID();
  const secret = randomBytes(32).toString("base64url");
  const prefix = `dsa_live_${keyId}`;
  return { keyId, prefix, secret, plaintext: `${prefix}_${secret}` };
}

export function parseApiKey(value: string): { keyId: string; prefix: string } {
  const match = API_KEY_PATTERN.exec(value);
  if (match?.[1] === undefined) throw new ApiKeyError("API key format is invalid.");
  return { keyId: match[1], prefix: `dsa_live_${match[1]}` };
}

export function hashApiKey(value: string, pepper: string): string {
  return createHmac("sha256", pepper).update(value).digest("hex");
}

export function verifyApiKeyHash(value: string, expectedHash: string, pepper: string): boolean {
  const actual = Buffer.from(hashApiKey(value, pepper), "hex");
  const expected = Buffer.from(expectedHash, "hex");
  return expected.length === actual.length && timingSafeEqual(actual, expected);
}

export function normalizeUsername(value: string): { username: string; normalized: string } {
  const username = value.trim();
  if (!USERNAME_PATTERN.test(username)) {
    throw new ApiKeyError(
      "Username must be 3-32 characters and use only letters, numbers, dot, underscore, or hyphen."
    );
  }
  return { username, normalized: username.toLocaleLowerCase("en-US") };
}

export const ACCOUNT_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS webhook_destinations (
  id uuid PRIMARY KEY,
  name text NOT NULL UNIQUE,
  url text NOT NULL,
  encrypted_signing_secret text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS api_accounts (
  id uuid PRIMARY KEY,
  username text NOT NULL,
  username_normalized text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  available_credits integer NOT NULL DEFAULT 0 CHECK (available_credits >= 0),
  reserved_credits integer NOT NULL DEFAULT 0 CHECK (reserved_credits >= 0),
  webhook_destination_id uuid REFERENCES webhook_destinations(id) ON DELETE SET NULL,
  ai_requests bigint NOT NULL DEFAULT 0 CHECK (ai_requests >= 0),
  input_tokens bigint NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
  output_tokens bigint NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
  search_requests bigint NOT NULL DEFAULT 0 CHECK (search_requests >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS api_keys (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES api_accounts(id) ON DELETE CASCADE,
  prefix text NOT NULL UNIQUE,
  key_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  overlap_expires_at timestamptz,
  revoked_at timestamptz
);

CREATE INDEX IF NOT EXISTS api_keys_account_idx ON api_keys(account_id, created_at DESC);

CREATE TABLE IF NOT EXISTS credit_ledger (
  id bigserial PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES api_accounts(id) ON DELETE RESTRICT,
  credit_chain_id uuid,
  kind text NOT NULL CHECK (kind IN ('grant', 'reservation', 'release', 'consumption', 'retry_chain_reuse', 'adjustment')),
  available_delta integer NOT NULL,
  reserved_delta integer NOT NULL,
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS admin_audit_log (
  id bigserial PRIMARY KEY,
  action text NOT NULL,
  account_id uuid REFERENCES api_accounts(id) ON DELETE SET NULL,
  reason text NOT NULL,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
`;

interface ApiKeyLookupRow extends QueryResultRow {
  key_hash: string;
  revoked_at: Date | null;
  overlap_expires_at: Date | null;
  account_id: string;
  username: string;
  status: "active" | "suspended";
  available_credits: number;
  reserved_credits: number;
  prefix: string;
}

export interface AccountPrincipal {
  accountId: string;
  username: string;
  status: "active" | "suspended";
  availableCredits: number;
  reservedCredits: number;
  keyPrefix: string;
}

export class AccountRepository {
  public constructor(
    private readonly pool: Pick<Pool, "query" | "connect">,
    private readonly apiKeyPepper: string,
    private readonly managedDefaultDestinationId?: string
  ) {}

  public async createAccount(input: AdminCreateAccountInput): Promise<AdminAccountView> {
    const { username, normalized } = normalizeUsername(input.username);
    const initialCredits = input.initialCredits ?? 0;
    if (!Number.isSafeInteger(initialCredits) || initialCredits < 0) {
      throw new CreditError("credits_would_be_negative", "Initial credits must be a non-negative integer.");
    }
    const accountId = randomUUID();
    const webhookDestinationId = input.webhookDestinationId ?? this.managedDefaultDestinationId ?? null;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query<{ created_at: Date }>(
        `INSERT INTO api_accounts
           (id, username, username_normalized, available_credits, webhook_destination_id)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING created_at`,
        [accountId, username, normalized, initialCredits, webhookDestinationId]
      );
      if (initialCredits > 0) {
        await client.query(
          `INSERT INTO credit_ledger
             (account_id, kind, available_delta, reserved_delta, reason)
           VALUES ($1, 'grant', $2, 0, 'Initial account grant')`,
          [accountId, initialCredits]
        );
      }
      await client.query(
        `INSERT INTO admin_audit_log (action, account_id, reason)
         VALUES ('account_created', $1, 'Administrator-created account')`,
        [accountId]
      );
      await client.query("COMMIT");
      return {
        accountId,
        username,
        status: "active",
        availableCredits: initialCredits,
        reservedCredits: 0,
        webhookDestinationId,
        createdAt: result.rows[0]?.created_at.toISOString() ?? new Date().toISOString()
      };
    } catch (error) {
      await client.query("ROLLBACK");
      if (isUniqueViolation(error)) {
        throw new AccountError("username_conflict", "Username is already in use.");
      }
      throw error;
    } finally {
      (client).release();
    }
  }

  public async issueKey(accountId: string): Promise<IssuedApiKey> {
    const issued = createApiKey();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const account = await client.query("SELECT 1 FROM api_accounts WHERE id = $1 FOR UPDATE", [accountId]);
      if (account.rowCount !== 1) throw new AccountError("account_not_found", "Account was not found.");
      const existing = await client.query(
        `SELECT 1 FROM api_keys
         WHERE account_id = $1 AND revoked_at IS NULL
           AND (overlap_expires_at IS NULL OR overlap_expires_at > now())
         LIMIT 1`,
        [accountId]
      );
      if (existing.rowCount !== 0) {
        throw new ApiKeyError("This account already has an active API key. Rotate it instead.");
      }
      await client.query(
        `INSERT INTO api_keys (id, account_id, prefix, key_hash)
         VALUES ($1, $2, $3, $4)`,
        [issued.keyId, accountId, issued.prefix, hashApiKey(issued.plaintext, this.apiKeyPepper)]
      );
      await client.query(
        `INSERT INTO admin_audit_log (action, account_id, reason, details)
         VALUES ('key_issued', $1, 'Administrator issued API key', $2)`,
        [accountId, { keyPrefix: issued.prefix }]
      );
      await client.query("COMMIT");
      return issued;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  public async consumeReadRateLimit(accountId: string): Promise<void> {
    const result = await this.pool.query(
      `INSERT INTO account_rate_limit_windows (account_id, kind, window_start, request_count)
       VALUES ($1, 'account_read', date_trunc('minute', now()), 1)
       ON CONFLICT (account_id, kind, window_start)
       DO UPDATE SET request_count = account_rate_limit_windows.request_count + 1
       WHERE account_rate_limit_windows.request_count < 120
       RETURNING request_count`,
      [accountId]
    );
    if (result.rowCount !== 1) throw new AccountReadRateLimitError();
  }

  public async authenticate(value: string, now = new Date()): Promise<AccountPrincipal | null> {
    let parsed: { keyId: string; prefix: string };
    try {
      parsed = parseApiKey(value);
    } catch {
      return null;
    }
    const result = await this.pool.query<ApiKeyLookupRow>(
      `SELECT key.key_hash, key.revoked_at, key.overlap_expires_at, key.prefix,
              account.id AS account_id, account.username, account.status,
              account.available_credits, account.reserved_credits
       FROM api_keys AS key
       JOIN api_accounts AS account ON account.id = key.account_id
       WHERE key.id = $1 AND key.prefix = $2`,
      [parsed.keyId, parsed.prefix]
    );
    const row = result.rows[0];
    if (
      row === undefined ||
      row.revoked_at !== null ||
      (row.overlap_expires_at !== null && row.overlap_expires_at <= now) ||
      !verifyApiKeyHash(value, row.key_hash, this.apiKeyPepper)
    ) {
      return null;
    }
    await this.pool.query("UPDATE api_keys SET last_used_at = $2 WHERE id = $1", [parsed.keyId, now]);
    return {
      accountId: row.account_id,
      username: row.username,
      status: row.status,
      availableCredits: row.available_credits,
      reservedCredits: row.reserved_credits,
      keyPrefix: row.prefix
    };
  }

  public async accountView(principal: AccountPrincipal): Promise<ApiAccountView> {
    const result = await this.pool.query<{
      ai_requests: string;
      input_tokens: string;
      output_tokens: string;
      search_requests: string;
    }>(
      `SELECT ai_requests, input_tokens, output_tokens, search_requests
       FROM api_accounts WHERE id = $1`,
      [principal.accountId]
    );
    const usage = result.rows[0];
    if (usage === undefined) throw new AccountError("account_not_found", "Account was not found.");
    return {
      ...principal,
      usage: {
        aiRequests: Number(usage.ai_requests),
        inputTokens: Number(usage.input_tokens),
        outputTokens: Number(usage.output_tokens),
        searchRequests: Number(usage.search_requests)
      }
    };
  }

  public async adjustCredits(accountId: string, delta: number, reason: string): Promise<number> {
    if (!Number.isSafeInteger(delta) || delta === 0) {
      throw new CreditError("credits_would_be_negative", "Credit adjustment must be a non-zero integer.");
    }
    if (reason.trim().length < 3 || reason.length > 500) {
      throw new CreditError("credits_would_be_negative", "An audit reason is required.");
    }
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const current = await client.query<{ available_credits: number }>(
        "SELECT available_credits FROM api_accounts WHERE id = $1 FOR UPDATE",
        [accountId]
      );
      const row = current.rows[0];
      if (row === undefined) throw new CreditError("account_not_found", "Account was not found.");
      const next = row.available_credits + delta;
      if (next < 0) {
        throw new CreditError("credits_would_be_negative", "Credit balance cannot be negative.");
      }
      await client.query(
        "UPDATE api_accounts SET available_credits = $2, updated_at = now() WHERE id = $1",
        [accountId, next]
      );
      await client.query(
        `INSERT INTO credit_ledger
           (account_id, kind, available_delta, reserved_delta, reason)
         VALUES ($1, $2, $3, 0, $4)`,
        [accountId, delta > 0 ? "grant" : "adjustment", delta, reason.trim()]
      );
      await client.query(
        `INSERT INTO admin_audit_log (action, account_id, reason, details)
         VALUES ('credits_adjusted', $1, $2, $3)`,
        [accountId, reason.trim(), { delta }]
      );
      await client.query("COMMIT");
      return next;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      (client).release();
    }
  }

  public async adminAccount(accountId: string): Promise<AdminAccountView | null> {
    const result = await this.pool.query<{
      id: string;
      username: string;
      status: "active" | "suspended";
      available_credits: number;
      reserved_credits: number;
      webhook_destination_id: string | null;
      created_at: Date;
    }>(
      `SELECT id, username, status, available_credits, reserved_credits,
              webhook_destination_id, created_at
       FROM api_accounts WHERE id = $1`,
      [accountId]
    );
    const row = result.rows[0];
    return row === undefined ? null : adminAccountView(row);
  }

  public async listAccounts(): Promise<AdminAccountView[]> {
    const result = await this.pool.query<{
      id: string;
      username: string;
      status: "active" | "suspended";
      available_credits: number;
      reserved_credits: number;
      webhook_destination_id: string | null;
      created_at: Date;
    }>(
      `SELECT id, username, status, available_credits, reserved_credits,
              webhook_destination_id, created_at
       FROM api_accounts ORDER BY created_at, id`
    );
    return result.rows.map(adminAccountView);
  }

  public async globalUsage(): Promise<{
    accounts: number; availableCredits: number; reservedCredits: number;
    aiRequests: number; inputTokens: number; outputTokens: number; searchRequests: number;
  }> {
    const result = await this.pool.query<{
      accounts: string; available_credits: string; reserved_credits: string;
      ai_requests: string; input_tokens: string; output_tokens: string; search_requests: string;
    }>(
      `SELECT count(*)::text AS accounts,
              COALESCE(sum(available_credits), 0)::text AS available_credits,
              COALESCE(sum(reserved_credits), 0)::text AS reserved_credits,
              COALESCE(sum(ai_requests), 0)::text AS ai_requests,
              COALESCE(sum(input_tokens), 0)::text AS input_tokens,
              COALESCE(sum(output_tokens), 0)::text AS output_tokens,
              COALESCE(sum(search_requests), 0)::text AS search_requests
       FROM api_accounts`
    );
    const row = result.rows[0];
    return {
      accounts: Number(row?.accounts ?? 0),
      availableCredits: Number(row?.available_credits ?? 0),
      reservedCredits: Number(row?.reserved_credits ?? 0),
      aiRequests: Number(row?.ai_requests ?? 0),
      inputTokens: Number(row?.input_tokens ?? 0),
      outputTokens: Number(row?.output_tokens ?? 0),
      searchRequests: Number(row?.search_requests ?? 0)
    };
  }

  public async listKeys(accountId: string): Promise<Array<{
    keyId: string;
    prefix: string;
    createdAt: string;
    lastUsedAt: string | null;
    overlapExpiresAt: string | null;
    revokedAt: string | null;
  }>> {
    const result = await this.pool.query<{
      id: string;
      prefix: string;
      created_at: Date;
      last_used_at: Date | null;
      overlap_expires_at: Date | null;
      revoked_at: Date | null;
    }>(
      `SELECT id, prefix, created_at, last_used_at, overlap_expires_at, revoked_at
       FROM api_keys WHERE account_id = $1 ORDER BY created_at DESC`,
      [accountId]
    );
    return result.rows.map((row) => ({
      keyId: row.id,
      prefix: row.prefix,
      createdAt: row.created_at.toISOString(),
      lastUsedAt: row.last_used_at?.toISOString() ?? null,
      overlapExpiresAt: row.overlap_expires_at?.toISOString() ?? null,
      revokedAt: row.revoked_at?.toISOString() ?? null
    }));
  }

  public async rotateKey(accountId: string, overlapSeconds = 600): Promise<IssuedApiKey> {
    if (!Number.isSafeInteger(overlapSeconds) || overlapSeconds < 0 || overlapSeconds > 86_400) {
      throw new ApiKeyError("Key overlap must be between zero and 86400 seconds.");
    }
    const issued = createApiKey();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const account = await client.query("SELECT 1 FROM api_accounts WHERE id = $1 FOR UPDATE", [accountId]);
      if (account.rowCount !== 1) throw new AccountError("account_not_found", "Account was not found.");
      await client.query(
        `UPDATE api_keys SET overlap_expires_at = now() + ($2 * interval '1 second')
         WHERE account_id = $1 AND revoked_at IS NULL
           AND (overlap_expires_at IS NULL OR overlap_expires_at > now() + ($2 * interval '1 second'))`,
        [accountId, overlapSeconds]
      );
      await client.query(
        `INSERT INTO api_keys (id, account_id, prefix, key_hash)
         VALUES ($1, $2, $3, $4)`,
        [issued.keyId, accountId, issued.prefix, hashApiKey(issued.plaintext, this.apiKeyPepper)]
      );
      await client.query(
        `INSERT INTO admin_audit_log (action, account_id, reason, details)
         VALUES ('key_rotated', $1, 'Administrator rotated API key', $2)`,
        [accountId, { overlapSeconds, keyPrefix: issued.prefix }]
      );
      await client.query("COMMIT");
      return issued;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      (client).release();
    }
  }

  public async revokeKey(accountId: string, keyId: string, reason: string): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE api_keys SET revoked_at = COALESCE(revoked_at, now())
       WHERE id = $1 AND account_id = $2 RETURNING id`,
      [keyId, accountId]
    );
    if (result.rowCount === 1) {
      await this.pool.query(
        `INSERT INTO admin_audit_log (action, account_id, reason, details)
         VALUES ('key_revoked', $1, $2, $3)`,
        [accountId, reason, { keyId }]
      );
    }
    return result.rowCount === 1;
  }

  public async setAccountStatus(
    accountId: string,
    status: "active" | "suspended",
    reason: string
  ): Promise<AdminAccountView> {
    if (reason.trim().length < 3 || reason.length > 500) throw new ApiKeyError("An audit reason is required.");
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const updated = await client.query<{
        id: string; username: string; status: "active" | "suspended";
        available_credits: number; reserved_credits: number;
        webhook_destination_id: string | null; created_at: Date;
      }>(
        `UPDATE api_accounts SET status = $2, updated_at = now()
         WHERE id = $1 RETURNING id, username, status, available_credits,
           reserved_credits, webhook_destination_id, created_at`,
        [accountId, status]
      );
      const account = updated.rows[0];
      if (account === undefined) throw new AccountError("account_not_found", "Account was not found.");
      if (status === "suspended") await releaseSuspendedReservations(client, accountId);
      await client.query(
        `INSERT INTO admin_audit_log (action, account_id, reason)
         VALUES ($1, $2, $3)`,
        [status === "suspended" ? "account_suspended" : "account_reinstated", accountId, reason.trim()]
      );
      await client.query("COMMIT");
      const fresh = await this.adminAccount(accountId);
      if (fresh === null) throw new AccountError("account_not_found", "Account was not found.");
      return fresh;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      (client).release();
    }
  }
}

export class AccountReadRateLimitError extends Error {
  public readonly code = "rate_limited";
  public readonly statusCode = 429;

  public constructor() {
    super("Account read rate limit exceeded.");
    this.name = "AccountReadRateLimitError";
  }
}

async function releaseSuspendedReservations(client: PoolClient, accountId: string): Promise<void> {
  const reports = await client.query<{
    id: string; credit_chain_id: string; credit_state: "reserved" | "consumed"; lifecycle_attempt: number;
  }>(
    `SELECT report.id, report.credit_chain_id, chain.state AS credit_state,
            report.lifecycle_attempt
     FROM account_reports AS report
     JOIN report_credit_chains AS chain ON chain.id = report.credit_chain_id
     WHERE report.account_id = $1 AND chain.state IN ('reserved', 'consumed')
       AND report.submission_started_at IS NULL AND report.status <> 'failed'
     FOR UPDATE OF report, chain`,
    [accountId]
  );
  for (const report of reports.rows) {
    if (report.credit_state === "reserved") {
      await client.query(
        `UPDATE report_credit_chains SET state = 'released', updated_at = now()
         WHERE id = $1 AND state = 'reserved'`,
        [report.credit_chain_id]
      );
      await client.query(
        `UPDATE api_accounts SET available_credits = available_credits + 1,
           reserved_credits = reserved_credits - 1, updated_at = now()
         WHERE id = $1 AND reserved_credits > 0`,
        [accountId]
      );
      await client.query(
        `INSERT INTO credit_ledger
           (account_id, credit_chain_id, kind, available_delta, reserved_delta, reason)
         VALUES ($1, $2, 'release', 1, -1, 'Account suspended before Discord submission')`,
        [accountId, report.credit_chain_id]
      );
    }
    await client.query(
      `UPDATE account_reports SET status = 'failed', failure_stage = status,
         error_code = 'account_suspended', error_message = 'Account was suspended before submission.',
         updated_at = now() WHERE id = $1`,
      [report.id]
    );
    await client.query(
      `UPDATE account_report_jobs SET state = 'failed', locked_at = NULL,
         last_error = 'account_suspended', updated_at = now()
       WHERE report_id = $1 AND state IN ('pending', 'running')`,
      [report.id]
    );
    const event = await client.query<{ id: string }>(
      `INSERT INTO account_report_events
         (account_id, report_id, event_type, lifecycle_attempt, metadata)
       VALUES ($1, $2, 'report_failed', $3, $4) RETURNING id`,
      [accountId, report.id, report.lifecycle_attempt, { errorCode: "account_suspended" }]
    );
    await client.query(
      `INSERT INTO event_destination_deliveries (event_id, destination_id)
       SELECT $2, webhook_destination_id FROM api_accounts
       WHERE id = $1 AND webhook_destination_id IS NOT NULL ON CONFLICT DO NOTHING`,
      [accountId, event.rows[0]?.id]
    );
  }
}

function adminAccountView(row: {
  id: string;
  username: string;
  status: "active" | "suspended";
  available_credits: number;
  reserved_credits: number;
  webhook_destination_id: string | null;
  created_at: Date;
}): AdminAccountView {
  return {
    accountId: row.id,
    username: row.username,
    status: row.status,
    availableCredits: row.available_credits,
    reservedCredits: row.reserved_credits,
    webhookDestinationId: row.webhook_destination_id,
    createdAt: row.created_at.toISOString()
  };
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "23505";
}
