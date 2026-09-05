import { randomUUID } from "node:crypto";

import type { ApiAccountView, ReportLifecycleEvent } from "@nreport/contracts";
import { Pool, type QueryResultRow } from "pg";

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
  encrypted_request text,
  dm_channel_id text,
  dm_message_id text,
  dm_claimed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS bot_report_links_owner_idx ON bot_report_links(discord_user_id, created_at DESC);
ALTER TABLE bot_report_links ADD COLUMN IF NOT EXISTS dm_claimed_at timestamptz;

CREATE TABLE IF NOT EXISTS lifecycle_inbox (
  event_id bigint PRIMARY KEY,
  account_id uuid NOT NULL,
  report_id uuid NOT NULL,
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
CREATE INDEX IF NOT EXISTS lifecycle_inbox_claim_idx ON lifecycle_inbox(state, run_at, event_id);

CREATE TABLE IF NOT EXISTS notification_preferences (
  discord_user_id text PRIMARY KEY,
  lifecycle_enabled boolean NOT NULL DEFAULT true,
  daily_digest boolean NOT NULL DEFAULT false,
  weekly_digest boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS digest_deliveries (
  discord_user_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('daily', 'weekly')),
  period_start timestamptz NOT NULL,
  period_end timestamptz NOT NULL,
  state text NOT NULL DEFAULT 'sending' CHECK (state IN ('sending', 'sent', 'skipped', 'failed')),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (discord_user_id, kind, period_start)
);
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
  account_id: string;
  report_id: string;
  event_type: string;
  occurred_at: Date;
  lifecycle_attempt: number;
  discord_user_id: string;
  encrypted_api_key: string;
  dm_channel_id: string | null;
  dm_message_id: string | null;
}

export interface PendingReportLink extends QueryResultRow {
  id: string;
  discord_user_id: string;
  account_id: string;
  idempotency_key: string;
  encrypted_request: string;
  encrypted_api_key: string;
}

export type EventIngestionResult = "accepted" | "duplicate" | "not_tracked_yet" | "disconnected";

export class AccountBotDatabase {
  public readonly pool: Pick<Pool, "query" | "connect" | "end">;

  public constructor(database: string | Pick<Pool, "query" | "connect" | "end">) {
    this.pool = typeof database === "string" ? new Pool({ connectionString: database, max: 8 }) : database;
  }

  public async migrate(): Promise<void> { await this.pool.query(BOT_ACCOUNT_SCHEMA_SQL); }
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
    encryptedRequest: string
  ): Promise<string> {
    const id = randomUUID();
    const result = await this.pool.query<{ id: string }>(
      `INSERT INTO bot_report_links
         (id, discord_user_id, account_id, idempotency_key, encrypted_request)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (idempotency_key) DO UPDATE SET updated_at = now()
       WHERE bot_report_links.discord_user_id = EXCLUDED.discord_user_id
         AND bot_report_links.account_id = EXCLUDED.account_id
       RETURNING id`,
      [id, discordUserId, accountId, idempotencyKey, encryptedRequest]
    );
    const linkId = result.rows[0]?.id;
    if (linkId === undefined) throw new Error("Idempotency key belongs to a different account mapping.");
    return linkId;
  }

  public async completeReportLink(linkId: string, reportId: string): Promise<void> {
    await this.pool.query(
      `UPDATE bot_report_links SET report_id = $2, encrypted_request = NULL,
         updated_at = now() WHERE id = $1`,
      [linkId, reportId]
    );
  }

  public async abandonReportLink(linkId: string): Promise<void> {
    await this.pool.query("DELETE FROM bot_report_links WHERE id = $1 AND report_id IS NULL", [linkId]);
  }

  public async pendingReportLinks(discordUserId: string): Promise<PendingReportLink[]> {
    const result = await this.pool.query<PendingReportLink>(
      `SELECT link.id, link.discord_user_id, link.account_id, link.idempotency_key,
              link.encrypted_request, connection.encrypted_api_key
       FROM bot_report_links AS link
       JOIN api_connections AS connection ON connection.account_id = link.account_id
       WHERE link.discord_user_id = $1 AND link.report_id IS NULL
       ORDER BY link.created_at LIMIT 20`,
      [discordUserId]
    );
    return result.rows;
  }

  public async setDmMapping(reportId: string, channelId: string, messageId: string): Promise<void> {
    await this.pool.query(
      `UPDATE bot_report_links SET dm_channel_id = $2, dm_message_id = $3,
         dm_claimed_at = NULL, updated_at = now() WHERE report_id = $1`,
      [reportId, channelId, messageId]
    );
  }

  public async claimDmCard(reportId: string): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE bot_report_links SET dm_claimed_at = now(), updated_at = now()
       WHERE report_id = $1 AND dm_message_id IS NULL
         AND (dm_claimed_at IS NULL OR dm_claimed_at < now() - interval '2 minutes')
       RETURNING id`,
      [reportId]
    );
    return result.rowCount === 1;
  }

  public async releaseDmCard(reportId: string): Promise<void> {
    await this.pool.query(
      `UPDATE bot_report_links SET dm_claimed_at = NULL, updated_at = now()
       WHERE report_id = $1 AND dm_message_id IS NULL`,
      [reportId]
    );
  }

  public async cleanupExpiredForms(): Promise<void> {
    await this.pool.query("DELETE FROM pending_report_forms WHERE expires_at <= now()");
  }

  public async ingestEvent(event: ReportLifecycleEvent): Promise<EventIngestionResult> {
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
        const pending = await client.query<{ id: string }>(
          `SELECT id FROM bot_report_links WHERE account_id = $1 AND report_id IS NULL
           ORDER BY created_at DESC LIMIT 1`,
          [event.accountId]
        );
        if (pending.rows[0] !== undefined) {
          await client.query("COMMIT");
          return "not_tracked_yet";
        }
        await client.query(
          `INSERT INTO bot_report_links (id, discord_user_id, account_id, idempotency_key, report_id)
           VALUES ($1, $2, $3, $4, $5) ON CONFLICT (report_id) DO NOTHING`,
          [randomUUID(), owner.discord_user_id, event.accountId, `external:${event.reportId}`, event.reportId]
        );
      }
      const inserted = await client.query(
        `INSERT INTO lifecycle_inbox
           (event_id, account_id, report_id, event_type, occurred_at, lifecycle_attempt)
         VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (event_id) DO NOTHING
         RETURNING event_id`,
        [event.eventId, event.accountId, event.reportId, event.type, event.occurredAt, event.lifecycleAttempt]
      );
      if (inserted.rowCount === 1) {
        await client.query(
          `UPDATE lifecycle_inbox SET state = 'ignored', locked_at = NULL
           WHERE account_id = $1 AND report_id = $2 AND event_id < $3::bigint
             AND state = 'pending'`,
          [event.accountId, event.reportId, event.eventId]
        );
        await client.query(
          `UPDATE lifecycle_inbox AS current SET state = 'ignored', locked_at = NULL
           WHERE current.event_id = $3::bigint
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
       SELECT event_id FROM lifecycle_inbox
         WHERE (state = 'pending' AND run_at <= now())
            OR (state = 'sending' AND locked_at < now() - interval '2 minutes')
         ORDER BY event_id FOR UPDATE SKIP LOCKED LIMIT 1
       ), claimed AS (
         UPDATE lifecycle_inbox AS inbox SET state = 'sending', attempts = attempts + 1,
           locked_at = now() FROM candidate WHERE inbox.event_id = candidate.event_id
         RETURNING inbox.*
       )
       SELECT claimed.*, connection.discord_user_id, connection.encrypted_api_key,
              link.dm_channel_id, link.dm_message_id
       FROM claimed
       JOIN api_connections AS connection ON connection.account_id = claimed.account_id
       JOIN bot_report_links AS link ON link.report_id = claimed.report_id`
    );
    return result.rows[0] ?? null;
  }

  public async completeNotification(eventId: string): Promise<void> {
    await this.pool.query("UPDATE lifecycle_inbox SET state = 'sent', locked_at = NULL WHERE event_id = $1", [eventId]);
  }

  public async retryNotification(eventId: string, error: string): Promise<void> {
    await this.pool.query(
      `UPDATE lifecycle_inbox SET state = 'pending', locked_at = NULL, last_error = $2,
         run_at = now() + interval '30 seconds' WHERE event_id = $1`,
      [eventId, error.slice(0, 300)]
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
    lifecycleEnabled: boolean; dailyDigest: boolean; weeklyDigest: boolean;
  }> {
    const result = await this.pool.query<{
      lifecycle_enabled: boolean; daily_digest: boolean; weekly_digest: boolean;
    }>("SELECT lifecycle_enabled, daily_digest, weekly_digest FROM notification_preferences WHERE discord_user_id = $1", [discordUserId]);
    const row = result.rows[0];
    return row === undefined
      ? { lifecycleEnabled: true, dailyDigest: false, weeklyDigest: false }
      : { lifecycleEnabled: row.lifecycle_enabled, dailyDigest: row.daily_digest, weeklyDigest: row.weekly_digest };
  }

  public async updateNotificationPreferences(
    discordUserId: string,
    input: { lifecycleEnabled?: boolean; dailyDigest?: boolean; weeklyDigest?: boolean }
  ): Promise<{ lifecycleEnabled: boolean; dailyDigest: boolean; weeklyDigest: boolean }> {
    await this.pool.query(
      `INSERT INTO notification_preferences
         (discord_user_id, lifecycle_enabled, daily_digest, weekly_digest)
       VALUES ($1, COALESCE($2, true), COALESCE($3, false), COALESCE($4, false))
       ON CONFLICT (discord_user_id) DO UPDATE
       SET lifecycle_enabled = COALESCE($2, notification_preferences.lifecycle_enabled),
           daily_digest = COALESCE($3, notification_preferences.daily_digest),
           weekly_digest = COALESCE($4, notification_preferences.weekly_digest),
           updated_at = now()`,
      [discordUserId, input.lifecycleEnabled ?? null, input.dailyDigest ?? null, input.weeklyDigest ?? null]
    );
    return this.notificationPreferences(discordUserId);
  }

  public async claimDigest(discordUserId: string, kind: "daily" | "weekly", startAt: string, endAt: string): Promise<boolean> {
    const result = await this.pool.query(
      `INSERT INTO digest_deliveries (discord_user_id, kind, period_start, period_end)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (discord_user_id, kind, period_start) DO UPDATE
       SET state = 'sending', updated_at = now()
       WHERE digest_deliveries.updated_at < now() - interval '1 hour'
         AND digest_deliveries.state IN ('failed', 'sending')
       RETURNING discord_user_id`,
      [discordUserId, kind, startAt, endAt]
    );
    return result.rowCount === 1;
  }

  public async completeDigest(discordUserId: string, kind: "daily" | "weekly", startAt: string, state: "sent" | "skipped" | "failed"): Promise<void> {
    await this.pool.query(
      `UPDATE digest_deliveries SET state = $4, updated_at = now()
       WHERE discord_user_id = $1 AND kind = $2 AND period_start = $3`,
      [discordUserId, kind, startAt, state]
    );
  }
}
