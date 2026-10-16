import { createHash, randomUUID } from "node:crypto";

import type { ApiAccountView, ReportLifecycleEvent } from "@nreport/contracts";
import { boundedDiagnostic } from "@nreport/contracts";
import { Pool, type QueryResultRow } from "pg";

const IMMEDIATE_LIFECYCLE_EVENT_TYPES = [
  "verification_received",
  "report_submitted",
  "discord:received",
  "report_failed",
  "report_connection_retry",
  "report_connection_restarting",
  "report_receipt_timeout",
  "review_confirmation_timeout",
  "review_ineligible",
  "review_request_failed",
  "review_request_ambiguous",
  "discord:actioned",
  "discord:review_not_approved",
  "discord:closed_no_action"
] as const;
const immediateLifecycleEventSql = IMMEDIATE_LIFECYCLE_EVENT_TYPES.map((type) => `'${type}'`).join(", ");
const MAX_DM_CARD_MIGRATION_DEPTH = 256;

export function cardNonce(reportId: string): string {
  return `card-${createHash("sha256").update(reportId).digest("hex").slice(0, 16)}`;
}

export interface DmCardIdentity {
  nonce: string;
  originReportId: string;
  originClaimedAt: Date;
  relatedReportIds: string[];
  relatedReportIdsComplete: boolean;
}

export const BOT_ACCOUNT_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS api_connections (
  discord_user_id text PRIMARY KEY,
  account_id uuid NOT NULL UNIQUE,
  username text NOT NULL,
  key_prefix text NOT NULL,
  encrypted_api_key text NOT NULL,
  event_cursor bigint NOT NULL DEFAULT 0,
  connected_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS pending_report_forms (
  id uuid PRIMARY KEY,
  discord_user_id text NOT NULL,
  encrypted_payload text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS pending_report_forms_expiry_idx ON pending_report_forms(expires_at);

CREATE TABLE IF NOT EXISTS bot_report_links (
  id uuid PRIMARY KEY,
  discord_user_id text NOT NULL,
  account_id uuid NOT NULL,
  idempotency_key text NOT NULL UNIQUE,
  report_id uuid UNIQUE,
  superseded_by_report_id uuid,
  encrypted_request text,
  encrypted_target_context text,
  dm_channel_id text,
  dm_message_id text,
  dm_card_nonce text,
  dm_card_origin_report_id uuid,
  dm_card_origin_claimed_at timestamptz,
  dm_claimed_at timestamptz,
  recovery_attempts integer NOT NULL DEFAULT 0,
  recovery_run_at timestamptz NOT NULL DEFAULT now(),
  recovery_claimed_at timestamptz,
  recovery_error text,
  card_repair_attempts integer NOT NULL DEFAULT 0,
  card_repair_run_at timestamptz NOT NULL DEFAULT now(),
  card_repair_claimed_at timestamptz,
  visible_payload_hash text,
  last_card_edit_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS bot_report_links_owner_idx ON bot_report_links(discord_user_id, created_at DESC);
ALTER TABLE bot_report_links ADD COLUMN IF NOT EXISTS dm_claimed_at timestamptz;
ALTER TABLE bot_report_links ADD COLUMN IF NOT EXISTS dm_card_nonce text;
ALTER TABLE bot_report_links ADD COLUMN IF NOT EXISTS dm_card_origin_report_id uuid;
ALTER TABLE bot_report_links ADD COLUMN IF NOT EXISTS dm_card_origin_claimed_at timestamptz;
ALTER TABLE bot_report_links ADD COLUMN IF NOT EXISTS recovery_attempts integer NOT NULL DEFAULT 0;
ALTER TABLE bot_report_links ADD COLUMN IF NOT EXISTS recovery_run_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE bot_report_links ADD COLUMN IF NOT EXISTS recovery_claimed_at timestamptz;
ALTER TABLE bot_report_links ADD COLUMN IF NOT EXISTS recovery_error text;
ALTER TABLE bot_report_links ADD COLUMN IF NOT EXISTS card_repair_attempts integer NOT NULL DEFAULT 0;
ALTER TABLE bot_report_links ADD COLUMN IF NOT EXISTS card_repair_run_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE bot_report_links ADD COLUMN IF NOT EXISTS card_repair_claimed_at timestamptz;
ALTER TABLE bot_report_links ADD COLUMN IF NOT EXISTS card_repair_terminal_at timestamptz;
ALTER TABLE bot_report_links ADD COLUMN IF NOT EXISTS card_repair_error text;
ALTER TABLE bot_report_links ADD COLUMN IF NOT EXISTS encrypted_target_context text;
ALTER TABLE bot_report_links ADD COLUMN IF NOT EXISTS visible_payload_hash text;
ALTER TABLE bot_report_links ADD COLUMN IF NOT EXISTS last_card_edit_at timestamptz;
ALTER TABLE bot_report_links ADD COLUMN IF NOT EXISTS superseded_by_report_id uuid;
CREATE INDEX IF NOT EXISTS bot_report_links_card_identity_idx
  ON bot_report_links(account_id, dm_card_nonce, dm_card_origin_report_id, dm_card_origin_claimed_at, created_at, report_id)
  WHERE report_id IS NOT NULL AND dm_card_nonce IS NOT NULL;
CREATE INDEX IF NOT EXISTS bot_report_links_predecessor_idx
  ON bot_report_links(account_id, superseded_by_report_id)
  WHERE superseded_by_report_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS lifecycle_inbox (
  event_id bigint PRIMARY KEY,
  account_id uuid NOT NULL,
  report_id uuid NOT NULL,
  trace_id uuid NOT NULL,
  event_type text NOT NULL,
  occurred_at timestamptz NOT NULL,
  lifecycle_attempt integer NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'sending', 'sent', 'ignored')),
  attempts integer NOT NULL DEFAULT 0,
  run_at timestamptz NOT NULL DEFAULT now(),
  locked_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE lifecycle_inbox ADD COLUMN IF NOT EXISTS trace_id uuid;
CREATE INDEX IF NOT EXISTS lifecycle_inbox_claim_idx ON lifecycle_inbox(state, run_at, event_id);
CREATE INDEX IF NOT EXISTS lifecycle_inbox_account_report_event_idx ON lifecycle_inbox(account_id, report_id, event_id);
CREATE INDEX IF NOT EXISTS lifecycle_inbox_report_created_idx ON lifecycle_inbox(report_id, created_at DESC);

CREATE TABLE IF NOT EXISTS notification_preferences (
  discord_user_id text PRIMARY KEY,
  lifecycle_enabled boolean NOT NULL DEFAULT true,
  decision_enabled boolean NOT NULL DEFAULT true,
  report_denied_enabled boolean NOT NULL DEFAULT false,
  problem_enabled boolean NOT NULL DEFAULT true,
  daily_digest boolean NOT NULL DEFAULT false,
  weekly_digest boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE notification_preferences ADD COLUMN IF NOT EXISTS decision_enabled boolean NOT NULL DEFAULT true;
ALTER TABLE notification_preferences ADD COLUMN IF NOT EXISTS report_denied_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE notification_preferences ADD COLUMN IF NOT EXISTS problem_enabled boolean NOT NULL DEFAULT true;

CREATE TABLE IF NOT EXISTS digest_deliveries (
  discord_user_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('daily', 'weekly')),
  period_start timestamptz NOT NULL,
  period_end timestamptz NOT NULL,
  state text NOT NULL DEFAULT 'sending' CHECK (state IN ('sending', 'sent', 'skipped', 'failed')),
  attempts integer NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (discord_user_id, kind, period_start)
);
ALTER TABLE digest_deliveries ADD COLUMN IF NOT EXISTS attempts integer NOT NULL DEFAULT 1;

CREATE TABLE IF NOT EXISTS bot_report_diagnostics (
  id bigserial PRIMARY KEY,
  report_id uuid,
  trace_id uuid,
  service text NOT NULL,
  severity text NOT NULL,
  event text NOT NULL,
  stage text,
  outcome text,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS bot_report_diagnostics_report_idx ON bot_report_diagnostics(report_id, created_at DESC);
CREATE INDEX IF NOT EXISTS bot_report_diagnostics_trace_idx ON bot_report_diagnostics(trace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS bot_report_diagnostics_created_idx ON bot_report_diagnostics(created_at);
`;

export class ConnectionConflictError extends Error {
  public constructor() {
    super("This Discord user or API account is already connected elsewhere.");
    this.name = "ConnectionConflictError";
  }
}

export interface ApiConnection extends QueryResultRow {
  discord_user_id: string;
  account_id: string;
  username: string;
  key_prefix: string;
  encrypted_api_key: string;
  event_cursor: string;
  connected_at: Date;
}

export interface ClaimedNotification extends QueryResultRow {
  event_id: string;
  attempts: number;
  account_id: string;
  report_id: string;
  trace_id: string | null;
  event_type: string;
  occurred_at: Date;
  lifecycle_attempt: number;
  discord_user_id: string;
  encrypted_api_key: string;
  dm_channel_id: string | null;
  dm_message_id: string | null;
  encrypted_target_context: string | null;
  visible_payload_hash: string | null;
  last_card_edit_at: Date | null;
}

export interface PendingReportLink extends QueryResultRow {
  id: string;
  discord_user_id: string;
  account_id: string;
  idempotency_key: string;
  encrypted_request: string;
  encrypted_target_context: string | null;
  encrypted_api_key: string;
  recovery_attempts: number;
}

export interface PendingCardRepair extends QueryResultRow {
  report_id: string;
  trace_id: string | null;
  discord_user_id: string;
  encrypted_target_context: string | null;
  encrypted_api_key: string;
  card_repair_attempts: number;
}

export interface ReportCardState extends QueryResultRow {
  report_id: string;
  discord_user_id: string;
  account_id: string;
  superseded_by_report_id: string | null;
  dm_channel_id: string | null;
  dm_message_id: string | null;
  encrypted_target_context: string | null;
  visible_payload_hash: string | null;
  dm_card_nonce: string | null;
  dm_card_origin_report_id: string | null;
  dm_card_origin_claimed_at: Date | null;
}

export interface NotificationHealthSnapshot {
  pendingNotificationCount: number;
  oldestPendingNotificationAgeMs: number | null;
  pendingCardUpdateCount: number;
  oldestPendingCardUpdateAgeMs: number | null;
}

export type EventIngestionResult = "accepted" | "duplicate" | "not_tracked_yet" | "disconnected";

export class AccountBotDatabase {
  public readonly pool: Pick<Pool, "query" | "connect" | "end">;

  public constructor(database: string | Pick<Pool, "query" | "connect" | "end">) {
    this.pool = typeof database === "string" ? new Pool({ connectionString: database, max: 8 }) : database;
  }

  public async migrate(): Promise<void> {
    await this.pool.query(BOT_ACCOUNT_SCHEMA_SQL);
    const malformedSuccessor = await this.pool.query<{ id: string }>(
      `SELECT predecessor.id
       FROM bot_report_links AS predecessor
       JOIN bot_report_links AS successor
         ON successor.report_id = predecessor.superseded_by_report_id
       WHERE (successor.dm_card_nonce IS NULL
              OR successor.dm_card_origin_report_id IS NULL
              OR successor.dm_card_origin_claimed_at IS NULL)
         AND (predecessor.report_id IS NULL OR successor.account_id <> predecessor.account_id)
       LIMIT 1`
    );
    if (malformedSuccessor.rows.length > 0) {
      throw new Error("Cannot migrate DM card identities with malformed successor links.");
    }

    // Reject unresolved chains before writing any identities; pathological depth is kept bounded.
    const resolutions = await this.pool.query<{
      target_id: string | null;
      nonce: string | null;
      origin_report_id: string | null;
      origin_claimed_at: Date | null;
      target_count: string;
    }>(
      `WITH RECURSIVE targets AS (
         SELECT id, account_id, report_id
         FROM bot_report_links
         WHERE report_id IS NOT NULL
           AND (dm_card_nonce IS NULL OR dm_card_origin_report_id IS NULL OR dm_card_origin_claimed_at IS NULL)
       ), walk AS (
         SELECT target.id AS target_id, link.account_id, link.report_id AS current_report_id,
                link.dm_card_nonce, link.dm_card_origin_report_id, link.dm_card_origin_claimed_at,
                link.created_at, ARRAY[link.report_id]::uuid[] AS path, 0 AS depth,
                (SELECT count(*)::integer
                 FROM bot_report_links AS prior
                 WHERE prior.account_id = link.account_id
                   AND prior.superseded_by_report_id = link.report_id
                   AND prior.report_id IS NOT NULL) AS predecessor_count
         FROM targets AS target
         JOIN bot_report_links AS link ON link.id = target.id

         UNION ALL

         SELECT walk.target_id, prior.account_id, prior.report_id,
                prior.dm_card_nonce, prior.dm_card_origin_report_id, prior.dm_card_origin_claimed_at,
                prior.created_at, walk.path || prior.report_id, walk.depth + 1,
                (SELECT count(*)::integer
                 FROM bot_report_links AS previous
                 WHERE previous.account_id = prior.account_id
                   AND previous.superseded_by_report_id = prior.report_id
                   AND previous.report_id IS NOT NULL)
         FROM walk
         JOIN bot_report_links AS prior
           ON prior.account_id = walk.account_id
          AND prior.superseded_by_report_id = walk.current_report_id
          AND prior.report_id IS NOT NULL
         WHERE walk.dm_card_nonce IS NULL
           AND walk.dm_card_origin_report_id IS NULL
           AND walk.dm_card_origin_claimed_at IS NULL
           AND walk.predecessor_count = 1
           AND walk.depth < ${MAX_DM_CARD_MIGRATION_DEPTH}
           AND NOT (prior.report_id = ANY(walk.path))
       ), resolved AS (
         SELECT DISTINCT ON (target_id)
                target_id,
                dm_card_nonce AS nonce,
                CASE WHEN dm_card_nonce IS NULL THEN current_report_id ELSE dm_card_origin_report_id END
                  AS origin_report_id,
                CASE WHEN dm_card_nonce IS NULL THEN created_at ELSE dm_card_origin_claimed_at END
                  AS origin_claimed_at
         FROM walk
         WHERE (dm_card_nonce IS NOT NULL
                AND dm_card_origin_report_id IS NOT NULL
                AND dm_card_origin_claimed_at IS NOT NULL)
            OR (dm_card_nonce IS NULL
                AND dm_card_origin_report_id IS NULL
                AND dm_card_origin_claimed_at IS NULL
                AND predecessor_count = 0)
         ORDER BY target_id, depth DESC
       ), counts AS (
         SELECT (SELECT count(*)::text FROM targets) AS target_count
       )
       SELECT resolved.target_id, resolved.nonce, resolved.origin_report_id,
              resolved.origin_claimed_at, counts.target_count
       FROM counts LEFT JOIN resolved ON TRUE`
    );
    const resolutionCounts = resolutions.rows[0];
    const targetCount = Number(resolutionCounts?.target_count ?? "0");
    const resolved = resolutions.rows.filter((row) => row.target_id !== null);
    if (resolved.length !== targetCount) {
      throw new Error(`Cannot migrate unresolved DM card identities (${resolved.length}/${targetCount} resolved).`);
    }

    if (resolved.length === 0) return;

    const ids: string[] = [];
    const nonces: string[] = [];
    const originReportIds: string[] = [];
    const originClaimedAts: Date[] = [];
    for (const identity of resolved) {
      if (identity.target_id === null || identity.origin_report_id === null || identity.origin_claimed_at === null) {
        throw new Error("Cannot migrate an incomplete DM card identity resolution.");
      }
      ids.push(identity.target_id);
      nonces.push(identity.nonce ?? cardNonce(identity.origin_report_id));
      originReportIds.push(identity.origin_report_id);
      originClaimedAts.push(identity.origin_claimed_at);
    }

    const updated = await this.pool.query(
      `UPDATE bot_report_links AS link
       SET dm_card_nonce = resolved.nonce,
           dm_card_origin_report_id = resolved.origin_report_id,
           dm_card_origin_claimed_at = resolved.origin_claimed_at
       FROM unnest($1::uuid[], $2::text[], $3::uuid[], $4::timestamptz[])
         AS resolved(id, nonce, origin_report_id, origin_claimed_at)
       WHERE link.id = resolved.id
         AND link.dm_card_nonce IS NULL
         AND link.dm_card_origin_report_id IS NULL
         AND link.dm_card_origin_claimed_at IS NULL`,
      [ids, nonces, originReportIds, originClaimedAts]
    );
    if (updated.rowCount !== resolved.length) {
      throw new Error("Cannot migrate DM card identities after concurrent link changes.");
    }
  }

  public async recordDiagnostic(input: {
    reportId?: string; traceId?: string; service: string; severity: string; event: string;
    stage?: string; outcome?: string; details?: unknown;
  }): Promise<void> {
    const details = boundedDiagnostic(input.details ?? {});
    await this.pool.query(
      `INSERT INTO bot_report_diagnostics (report_id, trace_id, service, severity, event, stage, outcome, details)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [input.reportId ?? null, input.traceId ?? null, input.service, input.severity, input.event,
        input.stage ?? null, input.outcome ?? null, details]
    );
  }

  public async purgeDiagnostics(): Promise<void> {
    await this.pool.query("DELETE FROM bot_report_diagnostics WHERE created_at < now() - interval '30 days'");
  }

  /** Trims settled lifecycle_inbox rows so the claim and coalescing indexes stay small. */
  public async purgeLifecycleInbox(): Promise<void> {
    await this.pool.query(
      "DELETE FROM lifecycle_inbox WHERE state IN ('sent', 'ignored') AND created_at < now() - interval '30 days'"
    );
  }
  public async healthcheck(): Promise<void> { await this.pool.query("SELECT 1"); }
  public async close(): Promise<void> { await this.pool.end(); }

  public async connectAccount(discordUserId: string, account: ApiAccountView, encryptedApiKey: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const conflicts = await client.query<{ discord_user_id: string; account_id: string }>(
        `SELECT discord_user_id, account_id FROM api_connections
         WHERE discord_user_id = $1 OR account_id = $2 FOR UPDATE`,
        [discordUserId, account.accountId]
      );
      if (conflicts.rows.some((row) => row.discord_user_id !== discordUserId || row.account_id !== account.accountId)) {
        throw new ConnectionConflictError();
      }
      await client.query(
        `INSERT INTO api_connections
           (discord_user_id, account_id, username, key_prefix, encrypted_api_key)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (discord_user_id) DO UPDATE
         SET username = EXCLUDED.username, key_prefix = EXCLUDED.key_prefix,
             encrypted_api_key = EXCLUDED.encrypted_api_key, updated_at = now()
         WHERE api_connections.account_id = EXCLUDED.account_id`,
        [discordUserId, account.accountId, account.username, account.keyPrefix, encryptedApiKey]
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      if (typeof error === "object" && error !== null && (error as { code?: unknown }).code === "23505") {
        throw new ConnectionConflictError();
      }
      throw error;
    } finally {
      (client).release();
    }
  }

  public async connection(discordUserId: string): Promise<ApiConnection | null> {
    const result = await this.pool.query<ApiConnection>("SELECT * FROM api_connections WHERE discord_user_id = $1", [discordUserId]);
    return result.rows[0] ?? null;
  }

  public async connections(): Promise<ApiConnection[]> {
    const result = await this.pool.query<ApiConnection>("SELECT * FROM api_connections ORDER BY connected_at, discord_user_id");
    return result.rows;
  }

  public async disconnect(discordUserId: string): Promise<boolean> {
    const result = await this.pool.query("DELETE FROM api_connections WHERE discord_user_id = $1 RETURNING discord_user_id", [discordUserId]);
    await this.pool.query("DELETE FROM pending_report_forms WHERE discord_user_id = $1", [discordUserId]);
    return result.rowCount === 1;
  }

  public async savePendingForm(discordUserId: string, encryptedPayload: string): Promise<string> {
    const id = randomUUID();
    await this.pool.query(
      `INSERT INTO pending_report_forms (id, discord_user_id, encrypted_payload, expires_at)
       VALUES ($1, $2, $3, now() + interval '30 minutes')`,
      [id, discordUserId, encryptedPayload]
    );
    return id;
  }

  public async pendingForm(id: string, discordUserId: string): Promise<string | null> {
    const result = await this.pool.query<{ encrypted_payload: string }>(
      `SELECT encrypted_payload FROM pending_report_forms
       WHERE id = $1 AND discord_user_id = $2 AND expires_at > now()`,
      [id, discordUserId]
    );
    return result.rows[0]?.encrypted_payload ?? null;
  }

  public async deletePendingForm(id: string, discordUserId: string): Promise<void> {
    await this.pool.query("DELETE FROM pending_report_forms WHERE id = $1 AND discord_user_id = $2", [id, discordUserId]);
  }

  public async beginReportLink(
    discordUserId: string,
    accountId: string,
    idempotencyKey: string,
    encryptedRequest: string,
    encryptedTargetContext?: string
  ): Promise<string> {
    const id = randomUUID();
    const result = await this.pool.query<{ id: string }>(
      `INSERT INTO bot_report_links
         (id, discord_user_id, account_id, idempotency_key, encrypted_request, encrypted_target_context)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (idempotency_key) DO UPDATE SET updated_at = now()
       WHERE bot_report_links.discord_user_id = EXCLUDED.discord_user_id
         AND bot_report_links.account_id = EXCLUDED.account_id
       RETURNING id`,
      [id, discordUserId, accountId, idempotencyKey, encryptedRequest, encryptedTargetContext ?? null]
    );
    const linkId = result.rows[0]?.id;
    if (linkId === undefined) throw new Error("Idempotency key belongs to a different account mapping.");
    return linkId;
  }

  public async completeReportLink(linkId: string, reportId: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const external = await client.query<{ id: string }>(
        "SELECT id FROM bot_report_links WHERE report_id = $1 AND id <> $2 FOR UPDATE", [reportId, linkId]
      );
      if (external.rows[0] === undefined) {
        await client.query(
          `UPDATE bot_report_links SET report_id = $2, encrypted_request = NULL,
             recovery_claimed_at = NULL, updated_at = now() WHERE id = $1`,
          [linkId, reportId]
        );
      } else {
        await client.query(
          `WITH pending AS (
             DELETE FROM bot_report_links WHERE id = $1
             RETURNING idempotency_key, encrypted_target_context
           )
           UPDATE bot_report_links AS external SET idempotency_key = pending.idempotency_key,
             encrypted_request = NULL,
             encrypted_target_context = COALESCE(external.encrypted_target_context, pending.encrypted_target_context),
             updated_at = now()
           FROM pending WHERE external.id = $2`,
          [linkId, external.rows[0].id]
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }
  }

  public async completeReplacementLink(linkId: string, reportId: string, predecessorReportId: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const predecessor = await client.query<{
        report_id: string; created_at: Date; dm_channel_id: string | null; dm_message_id: string | null;
        dm_card_nonce: string | null; dm_card_origin_report_id: string | null; dm_card_origin_claimed_at: Date | null;
        encrypted_target_context: string | null; visible_payload_hash: string | null; last_card_edit_at: Date | null;
      }>(
        `SELECT report_id, created_at, dm_channel_id, dm_message_id, dm_card_nonce,
                dm_card_origin_report_id, dm_card_origin_claimed_at,
                encrypted_target_context, visible_payload_hash, last_card_edit_at
         FROM bot_report_links WHERE report_id = $1 FOR UPDATE`,
        [predecessorReportId]
      );
      const prior = predecessor.rows[0];
      const parentNonce = prior?.dm_card_nonce ?? cardNonce(predecessorReportId);
      const parentOriginReportId = prior?.dm_card_origin_report_id ?? predecessorReportId;
      const parentOriginClaimedAt = prior?.dm_card_origin_claimed_at ?? prior?.created_at ?? new Date();
      const external = await client.query<{ id: string }>(
        "SELECT id FROM bot_report_links WHERE report_id = $1 AND id <> $2 FOR UPDATE", [reportId, linkId]
      );
      if (external.rows[0] === undefined) {
        await client.query(
          `UPDATE bot_report_links SET report_id = $2, encrypted_request = NULL,
             dm_channel_id = COALESCE(dm_channel_id, $3), dm_message_id = COALESCE(dm_message_id, $4),
             encrypted_target_context = COALESCE(encrypted_target_context, $5),
             visible_payload_hash = $6, last_card_edit_at = $7,
             dm_card_nonce = CASE WHEN dm_message_id IS NULL
               THEN COALESCE($8, dm_card_nonce, $9) ELSE COALESCE(dm_card_nonce, $8, $9) END,
             dm_card_origin_report_id = CASE WHEN dm_message_id IS NULL
               THEN COALESCE($10, dm_card_origin_report_id, $11)
               ELSE COALESCE(dm_card_origin_report_id, $10, $11) END,
             dm_card_origin_claimed_at = CASE WHEN dm_message_id IS NULL
               THEN COALESCE($12, dm_card_origin_claimed_at, now())
               ELSE COALESCE(dm_card_origin_claimed_at, $12, now()) END,
             updated_at = now() WHERE id = $1`,
          [linkId, reportId, prior?.dm_channel_id ?? null, prior?.dm_message_id ?? null,
            prior?.encrypted_target_context ?? null, prior?.visible_payload_hash ?? null,
            prior?.last_card_edit_at ?? null, parentNonce, cardNonce(reportId),
            parentOriginReportId, reportId, parentOriginClaimedAt]
        );
      } else {
        await client.query(
          `WITH pending AS (
             DELETE FROM bot_report_links WHERE id = $1
             RETURNING idempotency_key, encrypted_target_context
           )
           UPDATE bot_report_links AS successor SET idempotency_key = pending.idempotency_key,
             encrypted_request = NULL,
             dm_channel_id = COALESCE(successor.dm_channel_id, $3),
             dm_message_id = COALESCE(successor.dm_message_id, $4),
             encrypted_target_context = COALESCE(successor.encrypted_target_context, pending.encrypted_target_context, $5),
             visible_payload_hash = $6, last_card_edit_at = $7,
             dm_card_nonce = CASE WHEN successor.dm_message_id IS NULL
               THEN COALESCE($8, successor.dm_card_nonce, $9)
               ELSE COALESCE(successor.dm_card_nonce, $8, $9) END,
             dm_card_origin_report_id = CASE WHEN successor.dm_message_id IS NULL
               THEN COALESCE($10, successor.dm_card_origin_report_id, $11)
               ELSE COALESCE(successor.dm_card_origin_report_id, $10, $11) END,
             dm_card_origin_claimed_at = CASE WHEN successor.dm_message_id IS NULL
               THEN COALESCE($12, successor.dm_card_origin_claimed_at, now())
               ELSE COALESCE(successor.dm_card_origin_claimed_at, $12, now()) END,
             updated_at = now()
           FROM pending WHERE successor.id = $2`,
          [linkId, external.rows[0].id, prior?.dm_channel_id ?? null, prior?.dm_message_id ?? null,
            prior?.encrypted_target_context ?? null, prior?.visible_payload_hash ?? null,
            prior?.last_card_edit_at ?? null, parentNonce, cardNonce(reportId),
            parentOriginReportId, reportId, parentOriginClaimedAt]
        );
      }
      await client.query(
        `UPDATE bot_report_links SET dm_channel_id = NULL, dm_message_id = NULL,
           superseded_by_report_id = $2, updated_at = now() WHERE report_id = $1`,
        [predecessorReportId, reportId]
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Move a private status card to an API-created automatic network-retry child. This deliberately
   * accepts only the exact predecessor/child pair supplied by the API and never follows a later
   * manual replacement.
   */
  public async adoptAutomaticNetworkRetry(
    accountId: string,
    predecessorReportId: string,
    successorReportId: string
  ): Promise<"adopted" | "busy" | "unavailable" | "conflict"> {
    if (predecessorReportId === successorReportId) return "conflict";
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      // Match event ingestion's account-first lock order so webhook and feed processing serialize.
      const connectionResult = await client.query<{ discord_user_id: string }>(
        "SELECT discord_user_id FROM api_connections WHERE account_id = $1 FOR UPDATE",
        [accountId]
      );
      const connection = connectionResult.rows[0];
      if (connection === undefined) {
        await client.query("COMMIT");
        return "unavailable";
      }

      const initialLinks = await client.query<{
        report_id: string; discord_user_id: string; account_id: string; id: string;
      }>(
        `SELECT report_id, discord_user_id, account_id, id FROM bot_report_links
         WHERE report_id = ANY($1::uuid[]) ORDER BY report_id FOR UPDATE`,
        [[predecessorReportId, successorReportId]]
      );
      const predecessor = initialLinks.rows.find((link) => link.report_id === predecessorReportId);
      const successor = initialLinks.rows.find((link) => link.report_id === successorReportId);
      if (predecessor === undefined || predecessor.account_id !== accountId ||
        predecessor.discord_user_id !== connection.discord_user_id) {
        await client.query("COMMIT");
        return "unavailable";
      }
      if (successor !== undefined && (successor.account_id !== accountId ||
        successor.discord_user_id !== connection.discord_user_id)) {
        await client.query("COMMIT");
        return "conflict";
      }
      if (successor === undefined) {
        await client.query(
          `INSERT INTO bot_report_links (id, discord_user_id, account_id, idempotency_key, report_id)
           VALUES ($1, $2, $3, $4, $5) ON CONFLICT (report_id) DO NOTHING`,
          [randomUUID(), connection.discord_user_id, accountId, `external:${successorReportId}`, successorReportId]
        );
      }

      // Re-read under locks after the optional insert. ORDER BY keeps the row-lock order stable.
      const lockedLinks = await client.query<{
        report_id: string; discord_user_id: string; account_id: string;
        superseded_by_report_id: string | null; dm_channel_id: string | null; dm_message_id: string | null;
        dm_claimed_at: Date | null; encrypted_target_context: string | null; visible_payload_hash: string | null;
      }>(
        `SELECT report_id, discord_user_id, account_id, superseded_by_report_id,
                dm_channel_id, dm_message_id, dm_claimed_at, encrypted_target_context, visible_payload_hash
         FROM bot_report_links WHERE report_id = ANY($1::uuid[]) ORDER BY report_id FOR UPDATE`,
        [[predecessorReportId, successorReportId]]
      );
      const lockedPredecessor = lockedLinks.rows.find((link) => link.report_id === predecessorReportId);
      const lockedSuccessor = lockedLinks.rows.find((link) => link.report_id === successorReportId);
      if (lockedPredecessor === undefined || lockedSuccessor === undefined ||
        lockedPredecessor.account_id !== accountId || lockedSuccessor.account_id !== accountId ||
        lockedPredecessor.discord_user_id !== connection.discord_user_id ||
        lockedSuccessor.discord_user_id !== connection.discord_user_id) {
        await client.query("COMMIT");
        return "conflict";
      }

      // A delayed parent event must not reactivate a child that a user has since replaced.
      if (lockedSuccessor.superseded_by_report_id !== null) {
        await client.query("COMMIT");
        return "conflict";
      }
      if (lockedPredecessor.superseded_by_report_id !== null) {
        const result = lockedPredecessor.superseded_by_report_id === successorReportId
          ? "adopted"
          : "conflict";
        await client.query("COMMIT");
        return result;
      }

      const hasLiveCardClaim = (link: typeof lockedPredecessor): boolean =>
        link.dm_message_id === null && link.dm_claimed_at !== null &&
        link.dm_claimed_at.getTime() > Date.now() - 2 * 60_000;
      if (hasLiveCardClaim(lockedPredecessor) || hasLiveCardClaim(lockedSuccessor)) {
        await client.query("COMMIT");
        return "busy";
      }
      if (lockedPredecessor.dm_message_id !== null && lockedSuccessor.dm_message_id !== null &&
        (lockedPredecessor.dm_channel_id !== lockedSuccessor.dm_channel_id ||
          lockedPredecessor.dm_message_id !== lockedSuccessor.dm_message_id)) {
        await client.query("COMMIT");
        return "conflict";
      }

      await client.query(
        `UPDATE bot_report_links AS child SET
           dm_channel_id = COALESCE(child.dm_channel_id, parent.dm_channel_id),
           dm_message_id = COALESCE(child.dm_message_id, parent.dm_message_id),
           dm_card_nonce = COALESCE(parent.dm_card_nonce, $3, child.dm_card_nonce),
           dm_card_origin_report_id = COALESCE(parent.dm_card_origin_report_id, parent.report_id, child.dm_card_origin_report_id),
           dm_card_origin_claimed_at = COALESCE(parent.dm_card_origin_claimed_at, parent.created_at, child.dm_card_origin_claimed_at),
           encrypted_target_context = COALESCE(parent.encrypted_target_context, child.encrypted_target_context),
           visible_payload_hash = CASE
             WHEN child.dm_message_id IS NULL AND parent.dm_message_id IS NOT NULL THEN NULL
             ELSE child.visible_payload_hash END,
           last_card_edit_at = CASE
             WHEN child.dm_message_id IS NULL AND parent.dm_message_id IS NOT NULL THEN NULL
             ELSE child.last_card_edit_at END,
           dm_claimed_at = NULL, card_repair_claimed_at = NULL,
           card_repair_terminal_at = NULL, card_repair_error = NULL,
           card_repair_run_at = now(), updated_at = now()
         FROM bot_report_links AS parent
         WHERE child.report_id = $2 AND parent.report_id = $1`,
        [predecessorReportId, successorReportId, cardNonce(predecessorReportId)]
      );
      await client.query(
        `UPDATE bot_report_links SET dm_channel_id = NULL, dm_message_id = NULL,
           dm_claimed_at = NULL, card_repair_claimed_at = NULL,
           superseded_by_report_id = $2, updated_at = now()
         WHERE report_id = $1 AND superseded_by_report_id IS NULL`,
        [predecessorReportId, successorReportId]
      );
      await client.query("COMMIT");
      return "adopted";
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  /** Returns card state only when the supplied API account still owns the bot-side link. */
  public async reportCardState(accountId: string, reportId: string): Promise<ReportCardState | null> {
    const result = await this.pool.query<ReportCardState>(
      `SELECT link.report_id, link.discord_user_id, link.account_id, link.superseded_by_report_id,
              link.dm_channel_id, link.dm_message_id, link.encrypted_target_context, link.visible_payload_hash,
              link.dm_card_nonce, link.dm_card_origin_report_id, link.dm_card_origin_claimed_at
       FROM bot_report_links AS link
       JOIN api_connections AS connection ON connection.account_id = link.account_id
       WHERE link.account_id = $1 AND link.report_id = $2`,
      [accountId, reportId]
    );
    return result.rows[0] ?? null;
  }

  public async abandonReportLink(linkId: string): Promise<void> {
    await this.pool.query("DELETE FROM bot_report_links WHERE id = $1 AND report_id IS NULL", [linkId]);
  }

  public async pendingReportLinks(discordUserId: string): Promise<PendingReportLink[]> {
    const result = await this.pool.query<PendingReportLink>(
      `WITH due AS (
         SELECT id FROM bot_report_links
         WHERE discord_user_id = $1 AND report_id IS NULL AND recovery_run_at <= now()
           AND (recovery_claimed_at IS NULL OR recovery_claimed_at < now() - interval '2 minutes')
         ORDER BY recovery_run_at, created_at FOR UPDATE SKIP LOCKED LIMIT 20
       ), claimed AS (
         UPDATE bot_report_links AS link SET recovery_claimed_at = now(),
           recovery_attempts = recovery_attempts + 1, updated_at = now()
         FROM due WHERE link.id = due.id RETURNING link.*
       )
       SELECT link.id, link.discord_user_id, link.account_id, link.idempotency_key,
              link.encrypted_request, link.encrypted_target_context, link.recovery_attempts,
              connection.encrypted_api_key
       FROM claimed AS link JOIN api_connections AS connection ON connection.account_id = link.account_id
       ORDER BY link.recovery_run_at, link.created_at`,
      [discordUserId]
    );
    return result.rows;
  }

  public async rescheduleReportLink(linkId: string, delaySeconds: number, error: string): Promise<void> {
    await this.pool.query(
      `UPDATE bot_report_links SET recovery_claimed_at = NULL, recovery_error = $3,
         recovery_run_at = now() + ($2::text || ' seconds')::interval,
         updated_at = now() WHERE id = $1 AND report_id IS NULL`,
      [linkId, Math.max(1, Math.floor(delaySeconds)), error.slice(0, 120)]
    );
  }

  public async setDmMapping(reportId: string, channelId: string, messageId: string): Promise<void> {
    await this.pool.query(
      `UPDATE bot_report_links SET dm_channel_id = $2, dm_message_id = $3,
         dm_card_nonce = COALESCE(dm_card_nonce, $4),
         dm_card_origin_report_id = COALESCE(dm_card_origin_report_id, report_id),
         dm_card_origin_claimed_at = COALESCE(dm_card_origin_claimed_at, now()),
         dm_claimed_at = NULL, card_repair_claimed_at = NULL, card_repair_error = NULL, updated_at = now()
       WHERE report_id = $1 AND superseded_by_report_id IS NULL`,
      [reportId, channelId, messageId, cardNonce(reportId)]
    );
  }

  /** Clear only the mapping that Discord has confirmed no longer exists. */
  public async clearStaleDmMapping(reportId: string, messageId: string): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE bot_report_links SET dm_channel_id = NULL, dm_message_id = NULL,
         dm_card_nonce = NULL, dm_card_origin_report_id = NULL, dm_card_origin_claimed_at = NULL,
         dm_claimed_at = NULL, visible_payload_hash = NULL, card_repair_error = NULL, updated_at = now()
       WHERE report_id = $1 AND dm_message_id = $2`,
      [reportId, messageId]
    );
    return result.rowCount === 1;
  }

  public async reportTargetContext(reportId: string): Promise<string | null> {
    const result = await this.pool.query<{ encrypted_target_context: string | null }>(
      "SELECT encrypted_target_context FROM bot_report_links WHERE report_id = $1",
      [reportId]
    );
    return result.rows[0]?.encrypted_target_context ?? null;
  }

  public async completeCardUpdate(reportId: string, visiblePayloadHash: string): Promise<void> {
    await this.pool.query(
      `UPDATE bot_report_links SET visible_payload_hash = $2, last_card_edit_at = now(),
         card_repair_error = NULL, updated_at = now() WHERE report_id = $1`,
      [reportId, visiblePayloadHash]
    );
  }

  public async claimDmCard(reportId: string): Promise<DmCardIdentity | null> {
    const result = await this.pool.query<DmCardIdentity>(
      `WITH claimed AS (
         UPDATE bot_report_links SET
           dm_card_nonce = COALESCE(dm_card_nonce, $2),
           dm_card_origin_report_id = COALESCE(dm_card_origin_report_id, report_id),
           dm_card_origin_claimed_at = COALESCE(dm_card_origin_claimed_at, now()),
           dm_claimed_at = now(), updated_at = now()
         WHERE report_id = $1 AND superseded_by_report_id IS NULL AND dm_message_id IS NULL
           AND (dm_claimed_at IS NULL OR dm_claimed_at < now() - interval '2 minutes')
         RETURNING account_id, report_id, created_at, dm_card_nonce,
                   dm_card_origin_report_id, dm_card_origin_claimed_at
       )
       SELECT claimed.dm_card_nonce AS nonce,
              claimed.dm_card_origin_report_id AS "originReportId",
              claimed.dm_card_origin_claimed_at AS "originClaimedAt",
              identity.related_report_ids AS "relatedReportIds",
              identity.related_report_ids_complete AS "relatedReportIdsComplete"
       FROM claimed
       CROSS JOIN LATERAL (
         SELECT array_agg(bounded.report_id ORDER BY bounded.created_at, bounded.report_id) AS related_report_ids,
                count(*) <= 20 AS related_report_ids_complete
         FROM (
           SELECT lineage.report_id, lineage.created_at
           FROM (
             SELECT link.report_id::text AS report_id, link.created_at
             FROM bot_report_links AS link
             WHERE link.account_id = claimed.account_id
               AND link.dm_card_nonce = claimed.dm_card_nonce
               AND link.dm_card_origin_report_id = claimed.dm_card_origin_report_id
               AND link.dm_card_origin_claimed_at = claimed.dm_card_origin_claimed_at
             UNION
             SELECT claimed.report_id::text, claimed.created_at
           ) AS lineage
           ORDER BY lineage.created_at, lineage.report_id
           LIMIT 21
         ) AS bounded
       ) AS identity`,
      [reportId, cardNonce(reportId)]
    );
    return result.rows[0] ?? null;
  }

  public async releaseDmCard(reportId: string): Promise<void> {
    await this.pool.query(
      `UPDATE bot_report_links SET dm_claimed_at = NULL, updated_at = now()
       WHERE report_id = $1 AND dm_message_id IS NULL`,
      [reportId]
    );
  }

  public async dueCardRepairs(discordUserId: string): Promise<PendingCardRepair[]> {
    const result = await this.pool.query<PendingCardRepair>(
      `WITH due AS (
         SELECT id FROM bot_report_links WHERE discord_user_id = $1 AND report_id IS NOT NULL
           AND superseded_by_report_id IS NULL AND dm_message_id IS NULL
           AND card_repair_terminal_at IS NULL
           AND card_repair_run_at <= now()
           AND (card_repair_claimed_at IS NULL OR card_repair_claimed_at < now() - interval '2 minutes')
         ORDER BY card_repair_run_at, created_at FOR UPDATE SKIP LOCKED LIMIT 20
       ), claimed AS (
         UPDATE bot_report_links AS link SET card_repair_claimed_at = now(),
           card_repair_attempts = card_repair_attempts + 1, updated_at = now()
         FROM due WHERE link.id = due.id RETURNING link.*
       )
       SELECT link.report_id, link.discord_user_id, link.encrypted_target_context, link.card_repair_attempts,
              connection.encrypted_api_key, inbox.trace_id
       FROM claimed AS link JOIN api_connections AS connection ON connection.account_id = link.account_id
        LEFT JOIN LATERAL (
          SELECT trace_id FROM lifecycle_inbox WHERE report_id = link.report_id
          ORDER BY created_at DESC LIMIT 1
        ) AS inbox ON TRUE`,
      [discordUserId]
    );
    return result.rows;
  }

  public async rescheduleCardRepair(reportId: string, delaySeconds: number, error?: string): Promise<void> {
    await this.pool.query(
      `UPDATE bot_report_links SET card_repair_claimed_at = NULL,
         card_repair_run_at = now() + ($2::text || ' seconds')::interval,
         card_repair_error = COALESCE($3, card_repair_error), updated_at = now()
       WHERE report_id = $1 AND dm_message_id IS NULL`,
      [reportId, Math.max(1, Math.floor(delaySeconds)), error?.slice(0, 300) ?? null]
    );
  }

  public async terminalCardRepair(reportId: string, error: string): Promise<void> {
    await this.pool.query(
      `UPDATE bot_report_links SET card_repair_claimed_at = NULL, card_repair_terminal_at = now(),
         card_repair_error = $2, updated_at = now() WHERE report_id = $1 AND dm_message_id IS NULL`,
      [reportId, error.slice(0, 300)]
    );
  }

  public async cleanupExpiredForms(): Promise<void> {
    await this.pool.query("DELETE FROM pending_report_forms WHERE expires_at <= now()");
  }

  /** Batch membership check so reconciliation can skip already-known events without a per-event round trip. */
  public async existingEventIds(eventIds: readonly string[]): Promise<Set<string>> {
    if (eventIds.length === 0) return new Set();
    const result = await this.pool.query<{ event_id: string }>(
      "SELECT event_id FROM lifecycle_inbox WHERE event_id = ANY($1::bigint[])",
      [eventIds]
    );
    return new Set(result.rows.map((row) => row.event_id));
  }

  public async ingestEvent(event: ReportLifecycleEvent): Promise<EventIngestionResult> {
    const known = await this.pool.query("SELECT 1 FROM lifecycle_inbox WHERE event_id = $1", [event.eventId]);
    if ((known.rowCount ?? 0) > 0) return "duplicate";
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const connection = await client.query<{ discord_user_id: string }>(
        "SELECT discord_user_id FROM api_connections WHERE account_id = $1 FOR UPDATE",
        [event.accountId]
      );
      const owner = connection.rows[0];
      if (owner === undefined) {
        await client.query("COMMIT");
        return "disconnected";
      }
      const link = await client.query<{ id: string }>(
        "SELECT id FROM bot_report_links WHERE account_id = $1 AND report_id = $2",
        [event.accountId, event.reportId]
      );
      if (link.rows[0] === undefined) {
        await client.query(
          `INSERT INTO bot_report_links (id, discord_user_id, account_id, idempotency_key, report_id)
           VALUES ($1, $2, $3, $4, $5) ON CONFLICT (report_id) DO NOTHING`,
          [randomUUID(), owner.discord_user_id, event.accountId, `external:${event.reportId}`, event.reportId]
        );
      }
      const inserted = await client.query(
        `INSERT INTO lifecycle_inbox
           (event_id, account_id, report_id, trace_id, event_type, occurred_at, lifecycle_attempt, run_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7,
           CASE WHEN $5 IN (${immediateLifecycleEventSql})
             THEN now() ELSE now() + interval '2 seconds' END)
         ON CONFLICT (event_id) DO NOTHING
         RETURNING event_id`,
        [event.eventId, event.accountId, event.reportId, event.traceId, event.type, event.occurredAt, event.lifecycleAttempt]
      );
      if (inserted.rowCount === 1) {
        await client.query(
          `UPDATE lifecycle_inbox SET state = 'ignored', locked_at = NULL
           WHERE account_id = $1 AND report_id = $2 AND event_id < $3::bigint
             AND state = 'pending'
             AND event_type NOT IN (${immediateLifecycleEventSql})`,
          [event.accountId, event.reportId, event.eventId]
        );
        await client.query(
          `UPDATE lifecycle_inbox AS current SET state = 'ignored', locked_at = NULL
           WHERE current.event_id = $3::bigint
             AND current.event_type NOT IN (${immediateLifecycleEventSql})
             AND EXISTS (
               SELECT 1 FROM lifecycle_inbox AS newer
               WHERE newer.account_id = $1 AND newer.report_id = $2
                 AND newer.event_id > current.event_id
             )`,
          [event.accountId, event.reportId, event.eventId]
        );
      }
      await client.query("COMMIT");
      return inserted.rowCount === 1 ? "accepted" : "duplicate";
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      (client).release();
    }
  }

  public async claimNotification(): Promise<ClaimedNotification | null> {
    const result = await this.pool.query<ClaimedNotification>(
      `WITH candidate AS (
       SELECT inbox.event_id FROM lifecycle_inbox AS inbox
       JOIN bot_report_links AS card_link ON card_link.report_id = inbox.report_id
         WHERE ((inbox.state = 'pending' AND inbox.run_at <= now())
            OR (inbox.state = 'sending' AND inbox.locked_at < now() - interval '2 minutes'))
           AND card_link.superseded_by_report_id IS NULL
           AND EXISTS (SELECT 1 FROM api_connections AS active_connection WHERE active_connection.account_id = inbox.account_id)
           AND (inbox.event_type IN (${immediateLifecycleEventSql})
             OR card_link.last_card_edit_at IS NULL OR card_link.last_card_edit_at <= now() - interval '5 seconds')
           AND NOT EXISTS (
             SELECT 1 FROM lifecycle_inbox AS other
             WHERE other.report_id = inbox.report_id AND other.event_id <> inbox.event_id
               AND other.state = 'sending' AND other.locked_at > now() - interval '2 minutes'
           )
         ORDER BY inbox.event_id FOR UPDATE OF inbox SKIP LOCKED LIMIT 1
       ), claimed AS (
         UPDATE lifecycle_inbox AS inbox SET state = 'sending', attempts = attempts + 1,
           locked_at = now() FROM candidate WHERE inbox.event_id = candidate.event_id
         RETURNING inbox.*
       )
       SELECT claimed.*, connection.discord_user_id, connection.encrypted_api_key,
              link.dm_channel_id, link.dm_message_id, link.encrypted_target_context,
              link.visible_payload_hash, link.last_card_edit_at
       FROM claimed
       JOIN api_connections AS connection ON connection.account_id = claimed.account_id
       JOIN bot_report_links AS link ON link.report_id = claimed.report_id`
    );
    return result.rows[0] ?? null;
  }

  public async notificationHealthSnapshot(): Promise<NotificationHealthSnapshot> {
    const result = await this.pool.query<{
      pending_notification_count: string | number;
      oldest_pending_notification_age_ms: string | number | null;
      pending_card_update_count: string | number;
      oldest_pending_card_update_age_ms: string | number | null;
    }>(
      `WITH notification_backlog AS (
         SELECT inbox.created_at, inbox.report_id
         FROM lifecycle_inbox AS inbox
         JOIN bot_report_links AS link ON link.report_id = inbox.report_id
         JOIN api_connections AS connection ON connection.account_id = inbox.account_id
         WHERE inbox.state IN ('pending', 'sending') AND link.superseded_by_report_id IS NULL
       ), card_updates AS (
         SELECT inbox.created_at AS queued_at
         FROM lifecycle_inbox AS inbox
         JOIN bot_report_links AS link ON link.report_id = inbox.report_id
         JOIN api_connections AS connection ON connection.account_id = inbox.account_id
         WHERE inbox.state IN ('pending', 'sending') AND link.superseded_by_report_id IS NULL
           AND link.dm_message_id IS NOT NULL
           AND (link.last_card_edit_at IS NULL OR inbox.created_at > link.last_card_edit_at)
         UNION ALL
         SELECT link.created_at AS queued_at
         FROM bot_report_links AS link
         JOIN api_connections AS connection ON connection.account_id = link.account_id
         WHERE link.report_id IS NOT NULL AND link.superseded_by_report_id IS NULL
           AND link.dm_message_id IS NULL AND link.card_repair_terminal_at IS NULL
       )
       SELECT
         (SELECT count(*) FROM notification_backlog)::text AS pending_notification_count,
         (SELECT floor(extract(epoch FROM (now() - min(created_at))) * 1000) FROM notification_backlog)::text AS oldest_pending_notification_age_ms,
         (SELECT count(*) FROM card_updates)::text AS pending_card_update_count,
         (SELECT floor(extract(epoch FROM (now() - min(queued_at))) * 1000) FROM card_updates)::text AS oldest_pending_card_update_age_ms`
    );
    const row = result.rows[0];
    const count = (value: string | number | null | undefined): number => {
      const parsed = Number(value ?? 0);
      return Number.isFinite(parsed) ? Math.max(0, Math.trunc(parsed)) : 0;
    };
    const age = (value: string | number | null | undefined): number | null => {
      if (value === null || value === undefined) return null;
      const parsed = Number(value);
      return Number.isFinite(parsed) ? Math.max(0, Math.trunc(parsed)) : null;
    };
    return {
      pendingNotificationCount: count(row?.pending_notification_count),
      oldestPendingNotificationAgeMs: age(row?.oldest_pending_notification_age_ms),
      pendingCardUpdateCount: count(row?.pending_card_update_count),
      oldestPendingCardUpdateAgeMs: age(row?.oldest_pending_card_update_age_ms)
    };
  }

  public async completeNotification(eventId: string, attempt: number): Promise<void> {
    await this.pool.query(
      "UPDATE lifecycle_inbox SET state = 'sent', locked_at = NULL WHERE event_id = $1 AND state = 'sending' AND attempts = $2",
      [eventId, attempt]
    );
  }

  public async retryNotification(eventId: string, error: string, attempt: number): Promise<void> {
    await this.pool.query(
      `UPDATE lifecycle_inbox SET state = 'pending', locked_at = NULL, last_error = $2,
         run_at = now() + interval '30 seconds' WHERE event_id = $1 AND state = 'sending' AND attempts = $3`,
      [eventId, error.slice(0, 300), attempt]
    );
  }

  public async ignoreNotification(eventId: string, error: string, attempt: number): Promise<void> {
    await this.pool.query(
      "UPDATE lifecycle_inbox SET state = 'ignored', locked_at = NULL, last_error = $2 WHERE event_id = $1 AND state = 'sending' AND attempts = $3",
      [eventId, error.slice(0, 300), attempt]
    );
  }

  public async advanceCursor(discordUserId: string, eventId: string): Promise<void> {
    await this.pool.query(
      `UPDATE api_connections SET event_cursor = GREATEST(event_cursor, $2::bigint),
         updated_at = now() WHERE discord_user_id = $1`,
      [discordUserId, eventId]
    );
  }

  public async notificationPreferences(discordUserId: string): Promise<{
    decisionEnabled: boolean; reportDeniedEnabled: boolean; problemEnabled: boolean; dailyDigest: boolean; weeklyDigest: boolean;
  }> {
    const result = await this.pool.query<{
      decision_enabled: boolean; report_denied_enabled: boolean; problem_enabled: boolean; daily_digest: boolean; weekly_digest: boolean;
    }>("SELECT decision_enabled, report_denied_enabled, problem_enabled, daily_digest, weekly_digest FROM notification_preferences WHERE discord_user_id = $1", [discordUserId]);
    const row = result.rows[0];
    return row === undefined
      ? { decisionEnabled: true, reportDeniedEnabled: false, problemEnabled: true, dailyDigest: false, weeklyDigest: false }
      : { decisionEnabled: row.decision_enabled, reportDeniedEnabled: row.report_denied_enabled, problemEnabled: row.problem_enabled, dailyDigest: row.daily_digest, weeklyDigest: row.weekly_digest };
  }

  public async updateNotificationPreferences(
    discordUserId: string,
    input: { decisionEnabled?: boolean; reportDeniedEnabled?: boolean; problemEnabled?: boolean; dailyDigest?: boolean; weeklyDigest?: boolean }
  ): Promise<{ decisionEnabled: boolean; reportDeniedEnabled: boolean; problemEnabled: boolean; dailyDigest: boolean; weeklyDigest: boolean }> {
    await this.pool.query(
      `INSERT INTO notification_preferences
         (discord_user_id, decision_enabled, report_denied_enabled, problem_enabled, daily_digest, weekly_digest)
       VALUES ($1, COALESCE($2, true), COALESCE($3, false), COALESCE($4, true), COALESCE($5, false), COALESCE($6, false))
       ON CONFLICT (discord_user_id) DO UPDATE
       SET decision_enabled = COALESCE($2, notification_preferences.decision_enabled),
           report_denied_enabled = COALESCE($3, notification_preferences.report_denied_enabled),
           problem_enabled = COALESCE($4, notification_preferences.problem_enabled),
           daily_digest = COALESCE($5, notification_preferences.daily_digest),
           weekly_digest = COALESCE($6, notification_preferences.weekly_digest),
           updated_at = now()`,
      [discordUserId, input.decisionEnabled ?? null, input.reportDeniedEnabled ?? null, input.problemEnabled ?? null, input.dailyDigest ?? null, input.weeklyDigest ?? null]
    );
    return this.notificationPreferences(discordUserId);
  }

  public async claimDigest(discordUserId: string, kind: "daily" | "weekly", startAt: string, endAt: string): Promise<number | null> {
    const result = await this.pool.query<{ attempts: number }>(
      `INSERT INTO digest_deliveries (discord_user_id, kind, period_start, period_end, attempts)
       VALUES ($1, $2, $3, $4, 1)
       ON CONFLICT (discord_user_id, kind, period_start) DO UPDATE
       SET state = 'sending', attempts = digest_deliveries.attempts + 1, updated_at = now()
       WHERE digest_deliveries.updated_at < now() - interval '1 hour'
         AND digest_deliveries.state IN ('failed', 'sending')
       RETURNING attempts`,
      [discordUserId, kind, startAt, endAt]
    );
    return result.rows[0]?.attempts ?? null;
  }

  public async completeDigest(discordUserId: string, kind: "daily" | "weekly", startAt: string, attempt: number, state: "sent" | "skipped" | "failed"): Promise<void> {
    await this.pool.query(
      `UPDATE digest_deliveries SET state = $5, updated_at = now()
       WHERE discord_user_id = $1 AND kind = $2 AND period_start = $3
         AND state = 'sending' AND attempts = $4`,
      [discordUserId, kind, startAt, attempt, state]
    );
  }
}
