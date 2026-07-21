import { randomUUID } from "node:crypto";

import type {
  DiscordReportStatus,
  ReportLifecycleEvent,
  ReportStatus,
  ReportView
} from "@discord-dsa/contracts";
import { Pool } from "pg";
import type { PoolClient, QueryResultRow } from "pg";

import type {
  AccessView,
  NotificationPayload,
  PollingTracking,
  SubmissionTracking,
  ServerSnapshot
} from "./types.js";

export const ACTIVE_REPORT_POLL_SECONDS = 30;
export const REPORT_TRACKING_RETENTION_DAYS = 60;

export type ReportEventIngestionResult = "accepted" | "expired" | "not_tracked_yet";

export function reportEventTrackingResult(
  tracking: { tracking_expired: boolean } | undefined
): ReportEventIngestionResult {
  if (!tracking) return "not_tracked_yet";
  return tracking.tracking_expired ? "expired" : "accepted";
}

export function nextReportPollDelaySeconds(
  report: Pick<ReportView, "status" | "discordStatus">
): number | null {
  const terminalDiscordStatus =
    report.discordStatus === "actioned" ||
    report.discordStatus === "closed_no_action" ||
    report.discordStatus === "review_not_approved";
  return report.status === "submitted" || report.status === "failed" || terminalDiscordStatus
    ? null
    : ACTIVE_REPORT_POLL_SECONDS;
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS bot_users (
  discord_user_id text PRIMARY KEY,
  default_country char(2),
  credits integer NOT NULL DEFAULT 0 CHECK (credits >= 0),
  suspended boolean NOT NULL DEFAULT false,
  suspension_reason text,
  suspended_at timestamptz,
  suspended_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS access_keys (
  id uuid PRIMARY KEY,
  code_hash char(64) NOT NULL UNIQUE,
  code_prefix text NOT NULL,
  credits_total integer NOT NULL CHECK (credits_total >= 1),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'redeemed', 'revoked')),
  expires_at timestamptz,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  redeemed_by text REFERENCES bot_users(discord_user_id),
  redeemed_at timestamptz,
  revoked_by text,
  revoked_at timestamptz,
  revoke_reason text
);

CREATE TABLE IF NOT EXISTS credit_ledger (
  id bigserial PRIMARY KEY,
  discord_user_id text NOT NULL REFERENCES bot_users(discord_user_id),
  delta integer NOT NULL,
  balance_after integer NOT NULL CHECK (balance_after >= 0),
  reason text NOT NULL,
  key_id uuid REFERENCES access_keys(id),
  tracking_id uuid,
  actor_discord_user_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS admin_audit (
  id bigserial PRIMARY KEY,
  actor_discord_user_id text NOT NULL,
  action text NOT NULL,
  target text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS report_drafts (
  id uuid PRIMARY KEY,
  discord_user_id text NOT NULL REFERENCES bot_users(discord_user_id) ON DELETE CASCADE,
  encrypted_payload text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS report_tracking (
  id uuid PRIMARY KEY,
  draft_id uuid UNIQUE,
  discord_user_id text NOT NULL REFERENCES bot_users(discord_user_id),
  interaction_id text NOT NULL UNIQUE,
  idempotency_key text NOT NULL UNIQUE,
  internal_report_id text UNIQUE,
  flow text NOT NULL,
  country char(2) NOT NULL,
  report_type text NOT NULL,
  encrypted_request text NOT NULL,
  credit_state text NOT NULL CHECK (credit_state IN ('none', 'reserved', 'consumed', 'released')),
  last_status text,
  last_discord_status text,
  poll_at timestamptz,
  locked_at timestamptz,
  dm_blocked boolean NOT NULL DEFAULT false,
  tracking_expires_at timestamptz NOT NULL DEFAULT
    (now() + interval '${REPORT_TRACKING_RETENTION_DAYS} days'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS notification_outbox (
  id bigserial PRIMARY KEY,
  tracking_id uuid NOT NULL REFERENCES report_tracking(id) ON DELETE CASCADE,
  discord_user_id text NOT NULL,
  event_key text NOT NULL,
  payload jsonb NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'sending', 'sent', 'failed')),
  attempts integer NOT NULL DEFAULT 0,
  run_at timestamptz NOT NULL DEFAULT now(),
  locked_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tracking_id, event_key)
);

CREATE TABLE IF NOT EXISTS api_event_inbox (
  event_id bigint PRIMARY KEY,
  internal_report_id text NOT NULL,
  discord_user_id text NOT NULL,
  event_type text NOT NULL,
  occurred_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS bot_state (
  key text PRIMARY KEY,
  value text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS access_keys_status_idx ON access_keys(status, created_at DESC);
ALTER TABLE access_keys DROP CONSTRAINT IF EXISTS access_keys_credits_total_check;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'access_keys_credits_positive'
       AND conrelid = 'access_keys'::regclass
  ) THEN
    ALTER TABLE access_keys
      ADD CONSTRAINT access_keys_credits_positive CHECK (credits_total >= 1);
  END IF;
END
$$;
ALTER TABLE report_tracking ADD COLUMN IF NOT EXISTS draft_id uuid;
ALTER TABLE report_tracking ADD COLUMN IF NOT EXISTS server_snapshot jsonb;
ALTER TABLE report_tracking ADD COLUMN IF NOT EXISTS tracking_expires_at timestamptz;
UPDATE report_tracking
   SET tracking_expires_at = created_at + interval '${REPORT_TRACKING_RETENTION_DAYS} days'
 WHERE tracking_expires_at IS NULL;
ALTER TABLE report_tracking ALTER COLUMN tracking_expires_at SET DEFAULT
  (now() + interval '${REPORT_TRACKING_RETENTION_DAYS} days');
ALTER TABLE report_tracking ALTER COLUMN tracking_expires_at SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS report_tracking_draft_idx
  ON report_tracking(draft_id) WHERE draft_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS report_drafts_expiry_idx ON report_drafts(expires_at);
CREATE INDEX IF NOT EXISTS report_tracking_poll_idx ON report_tracking(poll_at, locked_at);
CREATE INDEX IF NOT EXISTS report_tracking_expiry_idx
  ON report_tracking(tracking_expires_at);
CREATE INDEX IF NOT EXISTS notification_outbox_claim_idx
  ON notification_outbox(state, run_at, locked_at);
`;

interface UserRow extends QueryResultRow {
  credits: number;
  default_country: string | null;
  suspended: boolean;
  suspension_reason: string | null;
}

interface DraftRow extends QueryResultRow {
  encrypted_payload: string;
}

export interface TrackingRow extends QueryResultRow {
  id: string;
  discord_user_id: string;
  interaction_id: string;
  internal_report_id: string | null;
  credit_state: SubmissionTracking["creditState"];
  encrypted_request: string;
  last_status: PollingTracking["lastStatus"];
  last_discord_status: PollingTracking["lastDiscordStatus"];
  server_snapshot: ServerSnapshot | null;
  flow: string;
  country: string;
  report_type: string;
  tracking_expires_at: Date;
}

export interface AccessKeyView extends QueryResultRow {
  id: string;
  code_prefix: string;
  credits_total: number;
  status: "active" | "redeemed" | "revoked";
  expires_at: Date | null;
  created_by: string;
  created_at: Date;
  redeemed_by: string | null;
  redeemed_at: Date | null;
  revoked_by: string | null;
  revoked_at: Date | null;
  revoke_reason: string | null;
}

export interface NotificationJob extends QueryResultRow {
  id: string;
  tracking_id: string;
  discord_user_id: string;
  payload: NotificationPayload;
  attempts: number;
}

const STATE_NOTIFICATION_TYPES = new Set([
  "report_submitted",
  "report_failed",
  "discord:received",
  "discord:actioned",
  "discord:closed_no_action",
  "discord:review_not_approved"
]);

export function notificationStateKey(eventType: string, lifecycleAttempt: number): string {
  return `lifecycle:${eventType}:attempt:${lifecycleAttempt}`;
}

export function notificationEventKey(event: ReportLifecycleEvent): string {
  return STATE_NOTIFICATION_TYPES.has(event.type)
    ? notificationStateKey(event.type, event.lifecycleAttempt)
    : `api:${event.eventId}`;
}

export function shouldNotifyLifecycleType(eventType: string): boolean {
  return eventType !== "discord:received";
}

export function observedNotificationTypes(
  lastStatus: ReportStatus | null,
  lastDiscordStatus: DiscordReportStatus | null,
  report: ReportView
): string[] {
  const types: string[] = [];
  if (lastStatus !== report.status && report.status === "submitted") {
    types.push("report_submitted");
  } else if (lastStatus !== report.status && report.status === "failed") {
    types.push("report_failed");
  }
  if (
    report.discordStatus !== null &&
    lastDiscordStatus !== report.discordStatus &&
    shouldNotifyLifecycleType(`discord:${report.discordStatus}`)
  ) {
    types.push(`discord:${report.discordStatus}`);
  }
  return types;
}

export class AccessError extends Error {
  public constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "AccessError";
  }
}

function accessView(row: UserRow): AccessView {
  return {
    credits: row.credits,
    defaultCountry: row.default_country,
    suspended: row.suspended,
    suspensionReason: row.suspension_reason
  };
}

export class BotDatabase {
  private readonly pool: Pool;

  public constructor(databaseUrl: string) {
    this.pool = new Pool({ connectionString: databaseUrl, max: 10 });
  }

  public async migrate(): Promise<void> {
    await this.pool.query(SCHEMA_SQL);
  }

  public async healthcheck(): Promise<void> {
    await this.pool.query("SELECT 1");
  }

  public async close(): Promise<void> {
    await this.pool.end();
  }

  private async ensureUser(client: PoolClient, userId: string): Promise<void> {
    await client.query(
      "INSERT INTO bot_users (discord_user_id) VALUES ($1) ON CONFLICT DO NOTHING",
      [userId]
    );
  }

  public async getAccess(userId: string): Promise<AccessView> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await this.ensureUser(client, userId);
      const result = await client.query<UserRow>(
        "SELECT credits, default_country, suspended, suspension_reason FROM bot_users WHERE discord_user_id = $1",
        [userId]
      );
      await client.query("COMMIT");
      const row = result.rows[0];
      if (!row) throw new Error("User record was not created.");
      return accessView(row);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  public async setDefaultCountry(userId: string, country: string): Promise<AccessView> {
    await this.pool.query(
      `INSERT INTO bot_users (discord_user_id, default_country)
       VALUES ($1, $2)
       ON CONFLICT (discord_user_id) DO UPDATE
       SET default_country = EXCLUDED.default_country, updated_at = now()`,
      [userId, country]
    );
    return this.getAccess(userId);
  }

  public async insertAccessKey(input: {
    id: string;
    hash: string;
    prefix: string;
    credits: number;
    expiresAt: Date | null;
    actorId: string;
  }): Promise<void> {
    await this.pool.query(
      `INSERT INTO access_keys
         (id, code_hash, code_prefix, credits_total, expires_at, created_by)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [input.id, input.hash, input.prefix, input.credits, input.expiresAt, input.actorId]
    );
    await this.audit(input.actorId, "key_created", input.id, {
      credits: input.credits,
      expiresAt: input.expiresAt?.toISOString() ?? null
    });
  }

  public async listAccessKeys(limit = 20): Promise<AccessKeyView[]> {
    const result = await this.pool.query<AccessKeyView>(
      `SELECT id, code_prefix, credits_total, status, expires_at, created_by, created_at,
              redeemed_by, redeemed_at, revoked_by, revoked_at, revoke_reason
       FROM access_keys ORDER BY created_at DESC LIMIT $1`,
      [Math.min(Math.max(limit, 1), 100)]
    );
    return result.rows;
  }

  public async getAccessKey(keyId: string): Promise<AccessKeyView | null> {
    const result = await this.pool.query<AccessKeyView>(
      `SELECT id, code_prefix, credits_total, status, expires_at, created_by, created_at,
              redeemed_by, redeemed_at, revoked_by, revoked_at, revoke_reason
       FROM access_keys WHERE id = $1`,
      [keyId]
    );
    return result.rows[0] ?? null;
  }

  public async redeemAccessKey(userId: string, codeHash: string): Promise<AccessView> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await this.ensureUser(client, userId);
      const userResult = await client.query<UserRow>(
        `SELECT credits, default_country, suspended, suspension_reason
         FROM bot_users WHERE discord_user_id = $1 FOR UPDATE`,
        [userId]
      );
      const user = userResult.rows[0];
      if (!user) throw new Error("User record was not created.");
      if (user.suspended) {
        throw new AccessError("user_suspended", "This account is suspended. An admin must reinstate it.");
      }
      const keyResult = await client.query<AccessKeyView & { code_hash: string }>(
        "SELECT * FROM access_keys WHERE code_hash = $1 FOR UPDATE",
        [codeHash]
      );
      const key = keyResult.rows[0];
      if (!key) throw new AccessError("invalid_key", "That access key is invalid.");
      if (key.status !== "active") {
        throw new AccessError("key_unavailable", "That access key has already been used or revoked.");
      }
      if (key.expires_at !== null && key.expires_at.getTime() <= Date.now()) {
        throw new AccessError("key_expired", "That access key has expired.");
      }
      const balance = user.credits + key.credits_total;
      await client.query(
        `UPDATE access_keys SET status = 'redeemed', redeemed_by = $2, redeemed_at = now()
         WHERE id = $1`,
        [key.id, userId]
      );
      await client.query(
        "UPDATE bot_users SET credits = $2, updated_at = now() WHERE discord_user_id = $1",
        [userId, balance]
      );
      await client.query(
        `INSERT INTO credit_ledger
           (discord_user_id, delta, balance_after, reason, key_id)
         VALUES ($1, $2, $3, 'key_redeemed', $4)`,
        [userId, key.credits_total, balance, key.id]
      );
      await client.query("COMMIT");
      return { ...accessView(user), credits: balance };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  public async revokeAccessKey(keyId: string, actorId: string, reason: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const keyResult = await client.query<AccessKeyView>(
        "SELECT * FROM access_keys WHERE id = $1 FOR UPDATE",
        [keyId]
      );
      const key = keyResult.rows[0];
      if (!key) throw new AccessError("key_not_found", "Access key was not found.");
      if (key.status === "revoked") throw new AccessError("key_revoked", "Access key is already revoked.");
      await client.query(
        `UPDATE access_keys SET status = 'revoked', revoked_by = $2, revoked_at = now(),
          revoke_reason = $3 WHERE id = $1`,
        [keyId, actorId, reason]
      );
      if (key.redeemed_by !== null) {
        await this.suspendUserInTransaction(client, key.redeemed_by, actorId, reason);
      }
      await client.query(
        `INSERT INTO admin_audit (actor_discord_user_id, action, target, metadata)
         VALUES ($1, 'key_revoked', $2, $3)`,
        [actorId, keyId, { reason, redeemedBy: key.redeemed_by }]
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  private async suspendUserInTransaction(
    client: PoolClient,
    userId: string,
    actorId: string,
    reason: string
  ): Promise<void> {
    await this.ensureUser(client, userId);
    const result = await client.query<UserRow>(
      "SELECT credits, default_country, suspended, suspension_reason FROM bot_users WHERE discord_user_id = $1 FOR UPDATE",
      [userId]
    );
    const user = result.rows[0];
    if (!user) throw new Error("User record was not created.");
    await client.query(
      `UPDATE bot_users SET credits = 0, suspended = true, suspension_reason = $2,
         suspended_at = now(), suspended_by = $3, updated_at = now()
       WHERE discord_user_id = $1`,
      [userId, reason, actorId]
    );
    if (user.credits > 0) {
      await client.query(
        `INSERT INTO credit_ledger
           (discord_user_id, delta, balance_after, reason, actor_discord_user_id)
         VALUES ($1, $2, 0, 'user_suspended', $3)`,
        [userId, -user.credits, actorId]
      );
    }
    await client.query("DELETE FROM report_drafts WHERE discord_user_id = $1", [userId]);
  }

  public async suspendUser(userId: string, actorId: string, reason: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await this.suspendUserInTransaction(client, userId, actorId, reason);
      await client.query(
        `INSERT INTO admin_audit (actor_discord_user_id, action, target, metadata)
         VALUES ($1, 'user_suspended', $2, $3)`,
        [actorId, userId, { reason }]
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  public async reinstateUser(userId: string, actorId: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO bot_users (discord_user_id) VALUES ($1)
       ON CONFLICT (discord_user_id) DO UPDATE SET suspended = false,
         suspension_reason = NULL, suspended_at = NULL, suspended_by = NULL,
         credits = 0, updated_at = now()`,
      [userId]
    );
    await this.audit(actorId, "user_reinstated", userId, {});
  }

  private async audit(
    actorId: string,
    action: string,
    target: string,
    metadata: Record<string, unknown>
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO admin_audit (actor_discord_user_id, action, target, metadata)
       VALUES ($1, $2, $3, $4)`,
      [actorId, action, target, metadata]
    );
  }

  public async saveDraft(userId: string, encryptedPayload: string): Promise<string> {
    const id = randomUUID();
    await this.pool.query(
      `INSERT INTO report_drafts (id, discord_user_id, encrypted_payload, expires_at)
       VALUES ($1, $2, $3, now() + interval '30 minutes')`,
      [id, userId, encryptedPayload]
    );
    return id;
  }

  public async getDraft(userId: string, draftId: string): Promise<string> {
    const result = await this.pool.query<DraftRow>(
      `SELECT encrypted_payload FROM report_drafts
       WHERE id = $1 AND discord_user_id = $2 AND expires_at > now()`,
      [draftId, userId]
    );
    const draft = result.rows[0];
    if (!draft) throw new AccessError("draft_expired", "This report draft expired. Start again.");
    return draft.encrypted_payload;
  }

  public async updateDraft(userId: string, draftId: string, encryptedPayload: string): Promise<void> {
    const result = await this.pool.query(
      `UPDATE report_drafts SET encrypted_payload = $3, updated_at = now()
       WHERE id = $1 AND discord_user_id = $2 AND expires_at > now()`,
      [draftId, userId, encryptedPayload]
    );
    if (result.rowCount !== 1) throw new AccessError("draft_expired", "This report draft expired. Start again.");
  }

  public async deleteDraft(userId: string, draftId: string): Promise<void> {
    await this.pool.query(
      "DELETE FROM report_drafts WHERE id = $1 AND discord_user_id = $2",
      [draftId, userId]
    );
  }

  public async reserveSubmission(input: {
    draftId: string;
    userId: string;
    interactionId: string;
    flow: string;
    country: string;
    reportType: string;
    encryptedRequest: string;
    serverSnapshot?: ServerSnapshot;
    adminBypass: boolean;
  }): Promise<{
    id: string;
    interactionId: string;
    creditState: SubmissionTracking["creditState"];
  }> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const existing = await client.query<TrackingRow>(
        `SELECT * FROM report_tracking
         WHERE interaction_id = $1 OR draft_id = $2 FOR UPDATE`,
        [input.interactionId, input.draftId]
      );
      const replay = existing.rows[0];
      if (replay) {
        await client.query("COMMIT");
        return {
          id: replay.id,
          interactionId: replay.interaction_id,
          creditState: replay.credit_state
        };
      }
      await this.ensureUser(client, input.userId);
      const userResult = await client.query<UserRow>(
        "SELECT credits, default_country, suspended, suspension_reason FROM bot_users WHERE discord_user_id = $1 FOR UPDATE",
        [input.userId]
      );
      const user = userResult.rows[0];
      if (!user) throw new Error("User record was not created.");
      if (!input.adminBypass && user.suspended) {
        throw new AccessError("user_suspended", "This account is suspended.");
      }
      if (!input.adminBypass && user.credits < 1) {
        throw new AccessError("no_credits", "You do not have a report credit.");
      }
      const id = randomUUID();
      const creditState = input.adminBypass ? "none" : "reserved";
      if (!input.adminBypass) {
        const balance = user.credits - 1;
        await client.query(
          "UPDATE bot_users SET credits = $2, updated_at = now() WHERE discord_user_id = $1",
          [input.userId, balance]
        );
        await client.query(
          `INSERT INTO credit_ledger
             (discord_user_id, delta, balance_after, reason, tracking_id)
           VALUES ($1, -1, $2, 'report_reserved', $3)`,
          [input.userId, balance, id]
        );
      }
      await client.query(
        `INSERT INTO report_tracking
           (id, draft_id, discord_user_id, interaction_id, idempotency_key, flow, country,
            report_type, encrypted_request, credit_state, server_snapshot, poll_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
           now() + interval '1 minute')`,
        [
          id,
          input.draftId,
          input.userId,
          input.interactionId,
          `create:${input.interactionId}`,
          input.flow,
          input.country,
          input.reportType,
          input.encryptedRequest,
          creditState,
          input.serverSnapshot ?? null
        ]
      );
      await client.query("COMMIT");
      return { id, interactionId: input.interactionId, creditState };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  public async markSubmissionCreated(trackingId: string, report: ReportView): Promise<void> {
    await this.pool.query(
      `UPDATE report_tracking SET internal_report_id = $2,
         credit_state = CASE WHEN credit_state = 'reserved' THEN 'consumed' ELSE credit_state END,
         poll_at = now() + interval '30 seconds',
         locked_at = NULL, updated_at = now()
       WHERE id = $1`,
      [trackingId, report.internalReportId]
    );
  }

  public async releaseReservation(trackingId: string, reason: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const trackingResult = await client.query<TrackingRow>(
        "SELECT * FROM report_tracking WHERE id = $1 FOR UPDATE",
        [trackingId]
      );
      const tracking = trackingResult.rows[0];
      if (!tracking || tracking.credit_state !== "reserved") {
        await client.query("COMMIT");
        return;
      }
      const userResult = await client.query<UserRow>(
        "SELECT credits, default_country, suspended, suspension_reason FROM bot_users WHERE discord_user_id = $1 FOR UPDATE",
        [tracking.discord_user_id]
      );
      const user = userResult.rows[0];
      if (!user) throw new Error("Tracked user was not found.");
      const balance = user.credits + 1;
      await client.query(
        "UPDATE bot_users SET credits = $2, updated_at = now() WHERE discord_user_id = $1",
        [tracking.discord_user_id, balance]
      );
      await client.query(
        `UPDATE report_tracking SET credit_state = 'released', poll_at = NULL,
           locked_at = NULL, updated_at = now() WHERE id = $1`,
        [trackingId]
      );
      await client.query(
        `INSERT INTO credit_ledger
           (discord_user_id, delta, balance_after, reason, tracking_id)
         VALUES ($1, 1, $2, $3, $4)`,
        [tracking.discord_user_id, balance, reason, trackingId]
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  public async claimDueTrackings(limit = 20): Promise<TrackingRow[]> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `UPDATE report_tracking SET poll_at = NULL, locked_at = NULL, updated_at = now()
         WHERE tracking_expires_at <= now() AND poll_at IS NOT NULL`
      );
      const result = await client.query<TrackingRow>(
        `SELECT * FROM report_tracking
         WHERE poll_at <= now()
           AND tracking_expires_at > now()
           AND (locked_at IS NULL OR locked_at < now() - interval '5 minutes')
           AND credit_state <> 'released'
         ORDER BY poll_at, created_at
         FOR UPDATE SKIP LOCKED LIMIT $1`,
        [Math.min(Math.max(limit, 1), 100)]
      );
      if (result.rows.length > 0) {
        await client.query(
          "UPDATE report_tracking SET locked_at = now() WHERE id = ANY($1::uuid[])",
          [result.rows.map((row) => row.id)]
        );
      }
      await client.query("COMMIT");
      return result.rows;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  public async rescheduleTracking(trackingId: string, seconds: number): Promise<void> {
    await this.pool.query(
      `UPDATE report_tracking SET poll_at = now() + ($2 * interval '1 second'),
         locked_at = NULL, updated_at = now() WHERE id = $1`,
      [trackingId, seconds]
    );
  }

  public async trackRetryReport(
    previousReportId: string,
    userId: string,
    interactionId: string,
    report: ReportView
  ): Promise<string> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const existing = await client.query<TrackingRow>(
        `SELECT * FROM report_tracking
         WHERE internal_report_id = $1 OR interaction_id = $2
         FOR UPDATE`,
        [report.internalReportId, interactionId]
      );
      const replay = existing.rows[0];
      if (replay) {
        await client.query("COMMIT");
        return replay.id;
      }
      const previousResult = await client.query<TrackingRow>(
        `SELECT * FROM report_tracking
         WHERE internal_report_id = $1 AND discord_user_id = $2
         FOR UPDATE`,
        [previousReportId, userId]
      );
      const previous = previousResult.rows[0];
      if (!previous) throw new Error("Previous report tracking was not found.");
      const trackingId = randomUUID();
      await client.query(
        `INSERT INTO report_tracking (
           id, discord_user_id, interaction_id, idempotency_key, internal_report_id,
           flow, country, report_type, encrypted_request, credit_state,
           last_status, last_discord_status, server_snapshot, poll_at
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8, $9, 'none', $10, $11, $12,
           now() + interval '30 seconds'
         )`,
        [
          trackingId,
          userId,
          interactionId,
          `retry:${interactionId}`,
          report.internalReportId,
          previous.flow,
          previous.country,
          previous.report_type,
          previous.encrypted_request,
          report.status,
          report.discordStatus,
          previous.server_snapshot
        ]
      );
      await client.query("COMMIT");
      return trackingId;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  public async observeReport(trackingId: string, report: ReportView): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query<TrackingRow>(
        "SELECT * FROM report_tracking WHERE id = $1 FOR UPDATE",
        [trackingId]
      );
      const tracking = result.rows[0];
      if (!tracking) throw new Error("Tracked report was not found.");

      const notificationTypes = observedNotificationTypes(
        tracking.last_status,
        tracking.last_discord_status,
        report
      );
      for (const eventType of notificationTypes) {
        const occurredAt = eventType.startsWith("discord:")
          ? report.discordStatusUpdatedAt ?? report.updatedAt
          : report.updatedAt;
        const payload: NotificationPayload = {
          eventId: `observed:${report.internalReportId}:${eventType}:${report.lifecycleAttempt}`,
          eventType,
          internalReportId: report.internalReportId,
          occurredAt
        };
        await client.query(
          `INSERT INTO notification_outbox
             (tracking_id, discord_user_id, event_key, payload)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (tracking_id, event_key) DO NOTHING`,
          [
            tracking.id,
            tracking.discord_user_id,
            notificationStateKey(eventType, report.lifecycleAttempt),
            payload
          ]
        );
      }

      const pollDelaySeconds = nextReportPollDelaySeconds(report);
      await client.query(
        `UPDATE report_tracking SET internal_report_id = $2, last_status = $3,
           last_discord_status = $4, poll_at = CASE
             WHEN $5::integer IS NULL OR tracking_expires_at <= now() THEN NULL
             ELSE now() + ($5::integer * interval '1 second') END,
           locked_at = NULL, updated_at = now() WHERE id = $1`,
        [
          trackingId,
          report.internalReportId,
          report.status,
          report.discordStatus,
          pollDelaySeconds
        ]
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  public async serverSnapshot(
    internalReportId: string,
    userId: string
  ): Promise<ServerSnapshot | null> {
    const result = await this.pool.query<TrackingRow>(
      `SELECT * FROM report_tracking
       WHERE internal_report_id = $1 AND discord_user_id = $2`,
      [internalReportId, userId]
    );
    return result.rows[0]?.server_snapshot ?? null;
  }

  public async saveServerSnapshot(
    internalReportId: string,
    userId: string,
    snapshot: ServerSnapshot
  ): Promise<void> {
    await this.pool.query(
      `UPDATE report_tracking SET server_snapshot = $3, updated_at = now()
       WHERE internal_report_id = $1 AND discord_user_id = $2`,
      [internalReportId, userId, snapshot]
    );
  }

  public async ingestLifecycleEvent(
    event: ReportLifecycleEvent
  ): Promise<ReportEventIngestionResult> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const trackingResult = await client.query<TrackingRow & { tracking_expired: boolean }>(
        `SELECT *, tracking_expires_at <= now() AS tracking_expired
         FROM report_tracking
         WHERE internal_report_id = $1 AND discord_user_id = $2
         FOR UPDATE`,
        [event.internalReportId, event.submitterDiscordUserId]
      );
      const tracking = trackingResult.rows[0];
      const ingestionResult = reportEventTrackingResult(tracking);
      if (ingestionResult !== "accepted") {
        await client.query("COMMIT");
        return ingestionResult;
      }
      if (!tracking) throw new Error("Accepted lifecycle event has no tracking row.");
      const inserted = await client.query(
        `INSERT INTO api_event_inbox
           (event_id, internal_report_id, discord_user_id, event_type, occurred_at)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (event_id) DO NOTHING RETURNING event_id`,
        [
          event.eventId,
          event.internalReportId,
          event.submitterDiscordUserId,
          event.type,
          event.occurredAt
        ]
      );
      if ((inserted.rowCount ?? 0) > 0 && shouldNotifyLifecycleType(event.type)) {
        const payload: NotificationPayload = {
          eventId: event.eventId,
          eventType: event.type,
          internalReportId: event.internalReportId,
          occurredAt: event.occurredAt
        };
        await client.query(
          `INSERT INTO notification_outbox
             (tracking_id, discord_user_id, event_key, payload)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (tracking_id, event_key) DO NOTHING`,
          [tracking.id, tracking.discord_user_id, notificationEventKey(event), payload]
        );
      }
      await client.query(
        `UPDATE report_tracking SET poll_at = NULL, locked_at = NULL, updated_at = now()
         WHERE id = $1`,
        [tracking.id]
      );
      await client.query("COMMIT");
      return "accepted";
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  public async reconciliationCursor(): Promise<string | null> {
    const result = await this.pool.query<{ value: string }>(
      "SELECT value FROM bot_state WHERE key = 'report_event_cursor'"
    );
    return result.rows[0]?.value ?? null;
  }

  public async setReconciliationCursor(eventId: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO bot_state (key, value) VALUES ('report_event_cursor', $1)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [eventId]
    );
  }

  public async claimNotifications(limit = 20): Promise<NotificationJob[]> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `UPDATE notification_outbox AS outbox SET state = 'failed', locked_at = NULL,
           last_error = 'tracking_expired', updated_at = now()
         FROM report_tracking AS tracking
         WHERE tracking.id = outbox.tracking_id
           AND tracking.tracking_expires_at <= now()
           AND outbox.state IN ('pending', 'sending')`
      );
      const result = await client.query<NotificationJob>(
        `SELECT outbox.* FROM notification_outbox AS outbox
         JOIN report_tracking AS tracking ON tracking.id = outbox.tracking_id
         WHERE outbox.state IN ('pending', 'sending') AND outbox.run_at <= now()
           AND (outbox.locked_at IS NULL OR outbox.locked_at < now() - interval '5 minutes')
           AND tracking.dm_blocked = false
           AND tracking.tracking_expires_at > now()
         ORDER BY outbox.run_at, outbox.id
         FOR UPDATE OF outbox SKIP LOCKED LIMIT $1`,
        [Math.min(Math.max(limit, 1), 100)]
      );
      if (result.rows.length > 0) {
        await client.query(
          `UPDATE notification_outbox SET state = 'sending', locked_at = now(),
             attempts = attempts + 1, updated_at = now()
           WHERE id = ANY($1::bigint[])`,
          [result.rows.map((row) => row.id)]
        );
      }
      await client.query("COMMIT");
      return result.rows.map((row) => ({ ...row, attempts: row.attempts + 1 }));
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  public async completeNotification(id: string): Promise<void> {
    await this.pool.query(
      `UPDATE notification_outbox SET state = 'sent', locked_at = NULL,
         updated_at = now() WHERE id = $1`,
      [id]
    );
  }

  public async failNotification(
    job: NotificationJob,
    message: string,
    permanent: boolean
  ): Promise<void> {
    if (permanent) {
      await this.pool.query(
        `UPDATE notification_outbox SET state = 'failed', locked_at = NULL,
           last_error = $2, updated_at = now() WHERE id = $1`,
        [job.id, message.slice(0, 500)]
      );
      await this.pool.query(
        "UPDATE report_tracking SET dm_blocked = true, updated_at = now() WHERE id = $1",
        [job.tracking_id]
      );
      return;
    }
    const delaySeconds = Math.min(60 * 2 ** job.attempts, 3600);
    await this.pool.query(
      `UPDATE notification_outbox SET state = 'pending', locked_at = NULL,
         run_at = now() + ($2 * interval '1 second'), last_error = $3,
         updated_at = now() WHERE id = $1`,
      [job.id, delaySeconds, message.slice(0, 500)]
    );
  }
}
