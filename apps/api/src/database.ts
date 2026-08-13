import { Buffer } from "node:buffer";
import { Pool } from "pg";
import type { PoolClient, QueryResultRow } from "pg";

import type {
  ActionHistoryPage,
  AnalyticsInterval,
  AnalyticsPeriod,
  DigestActivity,
  DiscordReportStatus,
  DiscordReviewStatus,
  ReportAnalytics,
  ReportFlow
} from "@discord-dsa/contracts";
import {
  aggregateAnalyticsRows,
  digestEligible,
  resolveAnalyticsInterval,
  type AnalyticsSourceEvent,
  type AnalyticsSourceReport
} from "./analytics.js";
import type { CreateReportInput } from "./validation.js";

export type ReportStatus =
  | "queued"
  | "requesting_verification"
  | "awaiting_verification"
  | "verification_received"
  | "verifying"
  | "submitting"
  | "submitted"
  | "failed";

export const VERIFICATION_EMAIL_TIMEOUT_SECONDS = 60;
export const VERIFICATION_EMAIL_RESEND_DELAYS_SECONDS = [20, 40] as const;
export const DISCORD_RECEIPT_TIMEOUT_SECONDS = 120;
export const DISCORD_REVIEW_CONFIRMATION_TIMEOUT_SECONDS = 120;
export const REVIEW_RETRY_COOLDOWN_SECONDS = 30;

export function statusAfterSessionPersistence(current: ReportStatus): ReportStatus {
  return current === "verification_received" ? current : "awaiting_verification";
}

export function shouldResendVerification(
  report: Pick<ReportRow, "status" | "session_state" | "verification_deadline">,
  now = new Date()
): boolean {
  return (
    report.status === "awaiting_verification" &&
    report.session_state !== null &&
    report.verification_deadline !== null &&
    report.verification_deadline.getTime() > now.getTime()
  );
}

export function shouldExpireDiscordReceipt(
  report: Pick<ReportRow, "status" | "discord_status" | "receipt_deadline">,
  now = new Date()
): boolean {
  return (
    report.status === "submitted" &&
    report.discord_status === null &&
    report.receipt_deadline !== null &&
    report.receipt_deadline.getTime() <= now.getTime()
  );
}

export function shouldApplyDiscordStatus(
  current: DiscordReportStatus | null,
  incoming: DiscordReportStatus
): boolean {
  if (current === incoming) return false;
  if (current === null || current === "received") return true;
  if (current === "closed_no_action") {
    return incoming === "actioned" || incoming === "review_not_approved";
  }
  return false;
}

export interface ReportRow extends QueryResultRow {
  id: string;
  idempotency_key: string;
  request_hash: string;
  flow: ReportFlow;
  country: string;
  report_type: string;
  submitter_discord_user_id: string | null;
  reporter_legal_name: string;
  reporter_email: string;
  timezone: string;
  locale: string;
  language: string;
  proxy_session_id: string;
  status: ReportStatus;
  input: CreateReportInput;
  session_state: string | null;
  discord_report_id: string | null;
  discord_status: DiscordReportStatus | null;
  discord_status_updated_at: Date | null;
  review_status: DiscordReviewStatus | null;
  review_status_updated_at: Date | null;
  review_confirmation_deadline: Date | null;
  review_error_code: string | null;
  review_error_message: string | null;
  review_retry_requested_at: Date | null;
  error_code: string | null;
  error_message: string | null;
  lifecycle_attempt: number;
  retryable: boolean;
  failure_stage: ReportStatus | "pre_submission" | null;
  retry_of_report_id: string | null;
  retried_as_report_id: string | null;
  retry_sequence: number;
  verification_deadline: Date | null;
  receipt_deadline: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface JobRow extends QueryResultRow {
  id: string;
  report_id: string;
  kind: "request_code" | "verify_submit" | "submit_review";
  payload: Record<string, unknown>;
  attempts: number;
  max_attempts: number;
}

export interface ReportEventRow extends QueryResultRow {
  id: string;
  report_id: string;
  event_type: string;
  metadata: Record<string, unknown>;
  created_at: Date;
}

interface AnalyticsReportQueryRow extends QueryResultRow {
  id: string;
  root_id: string;
  retry_of_report_id: string | null;
  created_at: Date;
  status: ReportStatus;
  discord_report_id: string | null;
  flow: ReportFlow;
  report_type: string;
  country: string;
  submitter_discord_user_id: string | null;
  input: CreateReportInput;
  in_case_cohort: boolean;
  in_attempt_window: boolean;
}

interface ActionHistoryQueryRow extends QueryResultRow {
  id: string;
  discord_report_id: string | null;
  flow: ReportFlow;
  report_type: string;
  country: string;
  input: CreateReportInput;
  submitted_at: Date;
  discord_status_updated_at: Date;
  action_source: "direct" | "appeal";
}

export interface ActionHistoryCursor {
  actionedAt: string;
  id: string;
}

export function encodeActionHistoryCursor(cursor: ActionHistoryCursor): string {
  return Buffer.from(JSON.stringify([Date.parse(cursor.actionedAt), cursor.id])).toString("base64url");
}

export function decodeActionHistoryCursor(value: string): ActionHistoryCursor {
  try {
    const decoded: unknown = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (
      Array.isArray(decoded) && decoded.length === 2 &&
      typeof decoded[0] === "number" && Number.isFinite(decoded[0]) &&
      typeof decoded[1] === "string" && decoded[1].length > 0
    ) {
      return { actionedAt: new Date(decoded[0]).toISOString(), id: decoded[1] };
    }
    if (
      typeof decoded !== "object" || decoded === null ||
      typeof (decoded as { actionedAt?: unknown }).actionedAt !== "string" ||
      typeof (decoded as { id?: unknown }).id !== "string" ||
      (decoded as { id: string }).id.length === 0 ||
      !Number.isFinite(Date.parse((decoded as { actionedAt: string }).actionedAt))
    ) {
      throw new Error("invalid");
    }
    return decoded as ActionHistoryCursor;
  } catch {
    throw new Error("Invalid action history cursor.");
  }
}

export interface DeliveryEventRow extends ReportEventRow {
  submitter_discord_user_id: string;
  delivery_attempts: number;
}

export interface CreateReportRecord {
  id: string;
  idempotencyKey: string;
  requestHash: string;
  input: CreateReportInput;
  legalName: string;
  email: string;
  timezone: string;
  locale: string;
  language: string;
  proxySessionId: string;
}

export interface CreateReportResult {
  created: boolean;
  report: ReportRow;
}

export interface InboundEmailRegistration {
  status: "accepted" | "duplicate" | "unknown_recipient" | "pending_report";
  reportId: string | null;
}

export interface RetryReportRecord {
  reportId: string;
  idempotencyKey: string;
  submitterDiscordUserId: string;
  id: string;
  legalName: string;
  email: string;
  timezone: string;
  locale: string;
  language: string;
  proxySessionId: string;
  input: CreateReportInput;
  requestHash: string;
  hasOverrides: boolean;
  mode: "automatic" | "manual";
}

export interface RetryReportResult {
  replayed: boolean;
  report: ReportRow;
}

export interface RetryIneligibleReviewInput {
  reportId: string;
  submitterDiscordUserId: string;
  idempotencyKey: string;
}

export interface RetryIneligibleReviewResult {
  replayed: boolean;
  report: ReportRow;
}

export type ReportRetryErrorCode =
  | "report_not_found"
  | "report_owner_mismatch"
  | "report_not_failed"
  | "report_not_retryable";

export function isRetryableFailure(
  stage: ReportStatus,
  errorCode: string,
  retrySequence: number
): boolean {
  void retrySequence;
  return (
    stage !== "submitting" &&
    stage !== "submitted" &&
    errorCode !== "ambiguous_submission_state"
  );
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS reports (
  id text PRIMARY KEY,
  idempotency_key text NOT NULL UNIQUE,
  request_hash text NOT NULL,
  flow text NOT NULL CHECK (flow IN ('user_urf', 'message_urf', 'guild_urf')),
  country char(2) NOT NULL,
  report_type text NOT NULL,
  submitter_discord_user_id text,
  reporter_legal_name text NOT NULL,
  reporter_email text NOT NULL UNIQUE,
  timezone text NOT NULL,
  locale text NOT NULL,
  language text NOT NULL,
  proxy_session_id text NOT NULL,
  status text NOT NULL,
  input jsonb NOT NULL,
  session_state text,
  discord_report_id text,
  discord_status text,
  discord_status_updated_at timestamptz,
  review_status text,
  review_status_updated_at timestamptz,
  review_confirmation_deadline timestamptz,
  review_error_code text,
  review_error_message text,
  review_retry_requested_at timestamptz,
  error_code text,
  error_message text,
  lifecycle_attempt integer NOT NULL DEFAULT 1,
  retryable boolean NOT NULL DEFAULT false,
  failure_stage text,
  retry_of_report_id text REFERENCES reports(id),
  retried_as_report_id text REFERENCES reports(id),
  retry_sequence integer NOT NULL DEFAULT 0,
  verification_deadline timestamptz,
  receipt_deadline timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS report_events (
  id bigserial PRIMARY KEY,
  report_id text NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
  event_type text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS report_jobs (
  id bigserial PRIMARY KEY,
  report_id text NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('request_code', 'verify_submit', 'submit_review')),
  dedupe_key text NOT NULL UNIQUE,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'running', 'completed', 'failed')),
  attempts integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 1,
  run_at timestamptz NOT NULL DEFAULT now(),
  locked_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS inbound_messages (
  message_id text PRIMARY KEY,
  report_id text REFERENCES reports(id) ON DELETE SET NULL,
  recipient text NOT NULL,
  status text NOT NULL,
  external_report_id text,
  external_status text,
  received_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS report_retry_requests (
  report_id text NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
  idempotency_key text NOT NULL,
  lifecycle_attempt integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (report_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS review_retry_requests (
  report_id text NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
  idempotency_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (report_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS report_delivery_outbox (
  event_id bigint PRIMARY KEY REFERENCES report_events(id) ON DELETE CASCADE,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'sending', 'sent')),
  attempts integer NOT NULL DEFAULT 0,
  run_at timestamptz NOT NULL DEFAULT now(),
  locked_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS report_delivery_outbox_claim_idx
  ON report_delivery_outbox(state, run_at, locked_at);

ALTER TABLE reports ADD COLUMN IF NOT EXISTS discord_status text;
ALTER TABLE reports ADD COLUMN IF NOT EXISTS discord_status_updated_at timestamptz;
ALTER TABLE reports ADD COLUMN IF NOT EXISTS review_status text;
ALTER TABLE reports ADD COLUMN IF NOT EXISTS review_status_updated_at timestamptz;
ALTER TABLE reports ADD COLUMN IF NOT EXISTS review_confirmation_deadline timestamptz;
ALTER TABLE reports ADD COLUMN IF NOT EXISTS review_error_code text;
ALTER TABLE reports ADD COLUMN IF NOT EXISTS review_error_message text;
ALTER TABLE reports ADD COLUMN IF NOT EXISTS review_retry_requested_at timestamptz;
ALTER TABLE reports ADD COLUMN IF NOT EXISTS locale text NOT NULL DEFAULT 'en-US';
ALTER TABLE reports ADD COLUMN IF NOT EXISTS language text NOT NULL DEFAULT 'en';
ALTER TABLE reports ADD COLUMN IF NOT EXISTS submitter_discord_user_id text;
ALTER TABLE reports ADD COLUMN IF NOT EXISTS lifecycle_attempt integer NOT NULL DEFAULT 1;
ALTER TABLE reports ADD COLUMN IF NOT EXISTS retryable boolean NOT NULL DEFAULT false;
ALTER TABLE reports ADD COLUMN IF NOT EXISTS failure_stage text;
ALTER TABLE reports ADD COLUMN IF NOT EXISTS retry_of_report_id text REFERENCES reports(id);
ALTER TABLE reports ADD COLUMN IF NOT EXISTS retried_as_report_id text REFERENCES reports(id);
ALTER TABLE reports ADD COLUMN IF NOT EXISTS retry_sequence integer NOT NULL DEFAULT 0;
ALTER TABLE reports ADD COLUMN IF NOT EXISTS verification_deadline timestamptz;
ALTER TABLE reports ADD COLUMN IF NOT EXISTS receipt_deadline timestamptz;
ALTER TABLE inbound_messages ADD COLUMN IF NOT EXISTS external_report_id text;
ALTER TABLE inbound_messages ADD COLUMN IF NOT EXISTS external_status text;
ALTER TABLE report_jobs DROP CONSTRAINT IF EXISTS report_jobs_kind_check;
ALTER TABLE report_jobs
  ADD CONSTRAINT report_jobs_kind_check
  CHECK (kind IN ('request_code', 'verify_submit', 'submit_review'));

CREATE INDEX IF NOT EXISTS report_jobs_claim_idx ON report_jobs(state, run_at, id);
CREATE INDEX IF NOT EXISTS report_events_report_idx ON report_events(report_id, created_at);
CREATE INDEX IF NOT EXISTS reports_created_at_idx ON reports(created_at, id);
CREATE INDEX IF NOT EXISTS report_events_type_created_idx
  ON report_events(event_type, created_at, report_id);
CREATE INDEX IF NOT EXISTS reports_email_status_idx ON reports(reporter_email, status);
CREATE INDEX IF NOT EXISTS reports_submitter_idx
  ON reports(submitter_discord_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS reports_message_author_id_idx
  ON reports ((input #>> '{messageEvidence,snapshot,authorId}'))
  WHERE flow = 'message_urf'
    AND input #>> '{messageEvidence,status}' = 'captured';
CREATE INDEX IF NOT EXISTS reports_message_id_idx
  ON reports ((input #>> '{messageEvidence,snapshot,messageId}'))
  WHERE flow = 'message_urf'
    AND input #>> '{messageEvidence,status}' = 'captured';
CREATE INDEX IF NOT EXISTS reports_verification_deadline_idx
  ON reports(verification_deadline) WHERE status = 'awaiting_verification';
CREATE INDEX IF NOT EXISTS reports_receipt_deadline_idx
  ON reports(receipt_deadline) WHERE status = 'submitted' AND discord_status IS NULL;
CREATE INDEX IF NOT EXISTS reports_review_confirmation_deadline_idx
  ON reports(review_confirmation_deadline) WHERE review_status = 'requested';

UPDATE reports
SET retry_sequence = lifecycle_attempt - 1
WHERE retry_sequence = 0 AND lifecycle_attempt > 1;

UPDATE reports
SET verification_deadline = updated_at + interval '60 seconds'
WHERE status = 'awaiting_verification' AND verification_deadline IS NULL;

UPDATE reports
SET receipt_deadline = updated_at + interval '120 seconds'
WHERE status = 'submitted' AND discord_status IS NULL AND receipt_deadline IS NULL;

UPDATE reports
SET receipt_deadline = NULL
WHERE discord_status IS NOT NULL AND receipt_deadline IS NOT NULL;

UPDATE reports AS report
SET retryable = true,
    failure_stage = COALESCE(failure_stage, 'pre_submission')
WHERE report.status = 'failed'
  AND report.discord_report_id IS NULL
  AND report.error_code IS DISTINCT FROM 'ambiguous_submission_state'
  AND NOT EXISTS (
    SELECT 1 FROM report_events AS event
    WHERE event.report_id = report.id
      AND event.event_type IN ('submission_started', 'report_submitted')
  );
`;

export class Database {
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

  public async recoverInterruptedJobs(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `UPDATE report_jobs
         SET state = 'pending', locked_at = NULL, run_at = now(), updated_at = now()
         WHERE state = 'running' AND kind = 'request_code'`
      );
      const ambiguous = await client.query<{ report_id: string }>(
        `UPDATE report_jobs
         SET state = 'failed', last_error = 'Worker restarted during final lifecycle', updated_at = now()
         WHERE state = 'running' AND kind = 'verify_submit'
         RETURNING report_id`
      );
      for (const row of ambiguous.rows) {
        await client.query(
          `UPDATE reports
           SET status = 'failed', error_code = 'ambiguous_submission_state',
               error_message = 'Worker restarted during verification or submission; manual review required.',
               retryable = false, failure_stage = 'submitting',
               updated_at = now()
           WHERE id = $1 AND status <> 'submitted'`,
          [row.report_id]
        );
        await this.event(client, row.report_id, "report_failed", {
          errorCode: "ambiguous_submission_state"
        });
      }
      const ambiguousReviews = await client.query<{ report_id: string }>(
        `UPDATE report_jobs
         SET state = 'failed',
             last_error = 'Worker restarted during review submission',
             updated_at = now()
         WHERE state = 'running' AND kind = 'submit_review'
         RETURNING report_id`
      );
      for (const row of ambiguousReviews.rows) {
        const updated = await client.query(
          `UPDATE reports
           SET review_status = 'request_ambiguous',
               review_status_updated_at = now(),
               review_confirmation_deadline = NULL,
               review_error_code = 'review_request_ambiguous',
               review_error_message =
                 'The review request outcome is uncertain after a worker restart.',
               updated_at = now()
           WHERE id = $1 AND review_status = 'queued'`,
          [row.report_id]
        );
        if (updated.rowCount === 1) {
          await this.event(client, row.report_id, "review_request_ambiguous", {
            errorCode: "review_request_ambiguous"
          });
        }
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  public async close(): Promise<void> {
    await this.pool.end();
  }

  private async event(
    client: PoolClient,
    reportId: string,
    eventType: string,
    metadata: Record<string, unknown> = {}
  ): Promise<ReportEventRow> {
    const attemptResult = await client.query<{ lifecycle_attempt: number }>(
      "SELECT lifecycle_attempt FROM reports WHERE id = $1",
      [reportId]
    );
    const lifecycleAttempt = attemptResult.rows[0]?.lifecycle_attempt ?? 1;
    const result = await client.query<ReportEventRow>(
      `INSERT INTO report_events (report_id, event_type, metadata)
       VALUES ($1, $2, $3) RETURNING *`,
      [reportId, eventType, { ...metadata, lifecycleAttempt }]
    );
    const event = result.rows[0];
    if (!event) throw new Error("Report event insert returned no row.");
    if (
      eventType === "report_submitted" ||
      eventType === "report_failed" ||
      eventType === "discord_status_updated" ||
      eventType === "review_requested" ||
      eventType === "review_received" ||
      eventType === "review_confirmation_timeout" ||
      eventType === "review_request_failed" ||
      eventType === "review_ineligible" ||
      eventType === "review_request_ambiguous"
    ) {
      await client.query(
        `INSERT INTO report_delivery_outbox (event_id)
         SELECT $1 WHERE EXISTS (
           SELECT 1 FROM reports
           WHERE id = $2 AND submitter_discord_user_id IS NOT NULL
         ) ON CONFLICT (event_id) DO NOTHING`,
        [event.id, reportId]
      );
    }
    return event;
  }

  public async createReport(record: CreateReportRecord): Promise<CreateReportResult> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const existing = await client.query<ReportRow>(
        "SELECT * FROM reports WHERE idempotency_key = $1 FOR UPDATE",
        [record.idempotencyKey]
      );
      const existingReport = existing.rows[0];
      if (existingReport) {
        if (existingReport.request_hash !== record.requestHash) {
          throw new IdempotencyConflictError();
        }
        await client.query("COMMIT");
        return { created: false, report: existingReport };
      }

      const inserted = await client.query<ReportRow>(
        `INSERT INTO reports (
          id, idempotency_key, request_hash, flow, country, report_type,
          submitter_discord_user_id, reporter_legal_name, reporter_email,
          timezone, locale, language, proxy_session_id, status, input
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 'queued', $14)
        RETURNING *`,
        [
          record.id,
          record.idempotencyKey,
          record.requestHash,
          record.input.flow,
          record.input.country,
          record.input.reportType,
          record.input.submitterDiscordUserId ?? null,
          record.legalName,
          record.email,
          record.timezone,
          record.locale,
          record.language,
          record.proxySessionId,
          record.input
        ]
      );
      await client.query(
        `INSERT INTO report_jobs (report_id, kind, dedupe_key, max_attempts)
         VALUES ($1, 'request_code', $2, 3)`,
        [record.id, `${record.id}:request-code:1`]
      );
      await this.event(client, record.id, "report_api_request_sent");
      await this.event(client, record.id, "report_created");
      await client.query("COMMIT");
      const report = inserted.rows[0];
      if (!report) throw new Error("Report insert returned no row.");
      return { created: true, report };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  public async getReport(id: string): Promise<ReportRow | undefined> {
    const result = await this.pool.query<ReportRow>("SELECT * FROM reports WHERE id = $1", [id]);
    return result.rows[0];
  }

  public async getReportEvents(reportId: string): Promise<ReportEventRow[]> {
    const result = await this.pool.query<ReportEventRow>(
      "SELECT * FROM report_events WHERE report_id = $1 ORDER BY id ASC",
      [reportId]
    );
    return result.rows;
  }

  public async listLifecycleEvents(afterEventId: string, limit: number): Promise<DeliveryEventRow[]> {
    const result = await this.pool.query<DeliveryEventRow>(
      `SELECT events.*, reports.submitter_discord_user_id, outbox.attempts AS delivery_attempts
       FROM report_events AS events
       JOIN reports ON reports.id = events.report_id
       JOIN report_delivery_outbox AS outbox ON outbox.event_id = events.id
       WHERE events.id > $1 AND reports.submitter_discord_user_id IS NOT NULL
       ORDER BY events.id ASC LIMIT $2`,
      [afterEventId, Math.min(Math.max(limit, 1), 100)]
    );
    return result.rows;
  }

  public async claimDeliveryEvents(limit = 20): Promise<DeliveryEventRow[]> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query<DeliveryEventRow>(
        `SELECT events.*, reports.submitter_discord_user_id, outbox.attempts AS delivery_attempts
         FROM report_delivery_outbox AS outbox
         JOIN report_events AS events ON events.id = outbox.event_id
         JOIN reports ON reports.id = events.report_id
         WHERE outbox.state IN ('pending', 'sending') AND outbox.run_at <= now()
           AND (outbox.locked_at IS NULL OR outbox.locked_at < now() - interval '5 minutes')
           AND reports.submitter_discord_user_id IS NOT NULL
         ORDER BY outbox.run_at, outbox.event_id
         FOR UPDATE OF outbox SKIP LOCKED LIMIT $1`,
        [Math.min(Math.max(limit, 1), 100)]
      );
      if (result.rows.length > 0) {
        await client.query(
          `UPDATE report_delivery_outbox SET state = 'sending', locked_at = now(),
             attempts = attempts + 1, updated_at = now()
           WHERE event_id = ANY($1::bigint[])`,
          [result.rows.map((row) => row.id)]
        );
      }
      await client.query("COMMIT");
      return result.rows.map((row) => ({
        ...row,
        delivery_attempts: row.delivery_attempts + 1
      }));
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  public async completeDeliveryEvent(eventId: string): Promise<void> {
    await this.pool.query(
      `UPDATE report_delivery_outbox SET state = 'sent', locked_at = NULL,
         last_error = NULL, updated_at = now() WHERE event_id = $1`,
      [eventId]
    );
  }

  public async retryDeliveryEvent(
    eventId: string,
    attempts: number,
    message: string
  ): Promise<void> {
    const delaySeconds = Math.min(15 * 2 ** Math.max(attempts - 1, 0), 900);
    await this.pool.query(
      `UPDATE report_delivery_outbox SET state = 'pending', locked_at = NULL,
         run_at = now() + ($2 * interval '1 second'), last_error = $3,
         updated_at = now() WHERE event_id = $1`,
      [eventId, delaySeconds, message.slice(0, 500)]
    );
  }

  public async listReportsBySubmitter(discordUserId: string): Promise<ReportRow[]> {
    const result = await this.pool.query<ReportRow>(
      `SELECT * FROM reports
       WHERE submitter_discord_user_id = $1
       ORDER BY created_at DESC
       LIMIT 100`,
      [discordUserId]
    );
    return result.rows;
  }

  private async analyticsForScope(
    scope: "personal" | "community",
    interval: AnalyticsInterval,
    discordUserId: string | null
  ): Promise<ReportAnalytics> {
    const reportResult = await this.pool.query<AnalyticsReportQueryRow>(
      `WITH RECURSIVE rooted AS (
         SELECT reports.*, reports.id AS root_id, reports.created_at AS root_created_at
         FROM reports
         WHERE reports.retry_of_report_id IS NULL
         UNION ALL
         SELECT child.*, rooted.root_id, rooted.root_created_at
         FROM reports AS child
         JOIN rooted ON child.retry_of_report_id = rooted.id
       )
       SELECT id, root_id, retry_of_report_id, created_at, status, discord_report_id,
              flow, report_type, country, submitter_discord_user_id, input,
              (id = root_id
                AND ($1::timestamptz IS NULL OR root_created_at >= $1::timestamptz)
                AND root_created_at < $2::timestamptz) AS in_case_cohort,
              (($1::timestamptz IS NULL OR created_at >= $1::timestamptz)
                AND created_at < $2::timestamptz) AS in_attempt_window
       FROM rooted
       WHERE ($3::text IS NULL OR submitter_discord_user_id = $3)
         AND (
           (($1::timestamptz IS NULL OR root_created_at >= $1::timestamptz)
             AND root_created_at < $2::timestamptz)
           OR (($1::timestamptz IS NULL OR created_at >= $1::timestamptz)
             AND created_at < $2::timestamptz)
         )
       ORDER BY root_created_at, retry_sequence, created_at, id`,
      [interval.startAt, interval.endAt, discordUserId]
    );

    const reportIds = reportResult.rows.map((row) => row.id);
    const eventResult = reportIds.length === 0
      ? { rows: [] as ReportEventRow[] }
      : await this.pool.query<ReportEventRow>(
        `SELECT * FROM report_events
         WHERE report_id = ANY($1::text[]) AND created_at < $2::timestamptz
         ORDER BY created_at, id`,
        [reportIds, interval.endAt]
      );
    const reports: AnalyticsSourceReport[] = reportResult.rows.map((row) => ({
      id: row.id,
      rootId: row.root_id,
      retryOfReportId: row.retry_of_report_id,
      createdAt: row.created_at.toISOString(),
      status: row.status,
      discordReportId: row.discord_report_id,
      flow: row.flow,
      category: row.report_type,
      country: row.country,
      submitterDiscordUserId: row.submitter_discord_user_id,
      submittedText: row.input.context ?? row.input.reportReason,
      inCaseCohort: row.in_case_cohort,
      inAttemptWindow: row.in_attempt_window
    }));
    const events: AnalyticsSourceEvent[] = eventResult.rows.map((row) => ({
      reportId: row.report_id,
      type: row.event_type,
      occurredAt: row.created_at.toISOString(),
      discordStatus: typeof row.metadata.discordStatus === "string"
        ? row.metadata.discordStatus
        : null
    }));
    return aggregateAnalyticsRows({ reports, events, scope, interval });
  }

  public async reportAnalytics(
    discordUserId: string,
    period: AnalyticsPeriod
  ): Promise<ReportAnalytics> {
    return this.analyticsForScope("personal", resolveAnalyticsInterval(period), discordUserId);
  }

  public async communityAnalytics(period: AnalyticsPeriod): Promise<ReportAnalytics> {
    return this.analyticsForScope("community", resolveAnalyticsInterval(period), null);
  }

  public async reportAnalyticsForInterval(
    discordUserId: string,
    interval: AnalyticsInterval
  ): Promise<ReportAnalytics> {
    return this.analyticsForScope("personal", interval, discordUserId);
  }

  public async communityAnalyticsForInterval(interval: AnalyticsInterval): Promise<ReportAnalytics> {
    return this.analyticsForScope("community", interval, null);
  }

  public async digestActivity(
    discordUserId: string,
    startAt: Date,
    endAt: Date
  ): Promise<DigestActivity> {
    const [reportResult, eventResult] = await Promise.all([
      this.pool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM reports
         WHERE submitter_discord_user_id = $1
           AND retry_of_report_id IS NULL
           AND created_at >= $2 AND created_at < $3`,
        [discordUserId, startAt, endAt]
      ),
      this.pool.query<{
        actioned: string;
        closed_no_action: string;
        appeal_actioned: string;
        appeal_denied: string;
      }>(
        `SELECT
           count(*) FILTER (
             WHERE event.metadata->>'discordStatus' = 'actioned'
               AND NOT EXISTS (
                 SELECT 1 FROM report_events AS earlier
                 WHERE earlier.report_id = event.report_id
                   AND earlier.event_type = 'discord_status_updated'
                   AND earlier.metadata->>'discordStatus' = 'closed_no_action'
                   AND (earlier.created_at, earlier.id) < (event.created_at, event.id)
               )
           )::text AS actioned,
           count(*) FILTER (WHERE event.metadata->>'discordStatus' = 'closed_no_action')::text
             AS closed_no_action,
           count(*) FILTER (
             WHERE event.metadata->>'discordStatus' = 'actioned'
               AND EXISTS (
                 SELECT 1 FROM report_events AS earlier
                 WHERE earlier.report_id = event.report_id
                   AND earlier.event_type = 'discord_status_updated'
                   AND earlier.metadata->>'discordStatus' = 'closed_no_action'
                   AND (earlier.created_at, earlier.id) < (event.created_at, event.id)
               )
               AND EXISTS (
                 SELECT 1 FROM report_events AS review
                 WHERE review.report_id = event.report_id
                   AND review.event_type = 'review_requested'
                   AND (review.created_at, review.id) < (event.created_at, event.id)
               )
           )::text AS appeal_actioned,
           count(*) FILTER (WHERE event.metadata->>'discordStatus' = 'review_not_approved')::text
             AS appeal_denied
         FROM report_events AS event
         JOIN reports ON reports.id = event.report_id
         WHERE reports.submitter_discord_user_id = $1
           AND event.event_type = 'discord_status_updated'
           AND event.created_at >= $2 AND event.created_at < $3`,
        [discordUserId, startAt, endAt]
      )
    ]);
    const newReports = Number(reportResult.rows[0]?.count ?? 0);
    const row = eventResult.rows[0];
    const actioned = Number(row?.actioned ?? 0);
    const closedNoAction = Number(row?.closed_no_action ?? 0);
    const appealActioned = Number(row?.appeal_actioned ?? 0);
    const appealDenied = Number(row?.appeal_denied ?? 0);
    const total = actioned + closedNoAction + appealActioned + appealDenied;
    const interval: AnalyticsInterval = {
      period: "custom",
      startAt: startAt.toISOString(),
      endAt: endAt.toISOString(),
      asOf: new Date().toISOString(),
      timezone: "UTC"
    };
    return {
      interval,
      newReports,
      outcomeChanges: { total, actioned, closedNoAction, appealActioned, appealDenied },
      eligible: digestEligible(newReports, total)
    };
  }

  public async actionHistory(input: {
    discordUserId: string;
    interval: AnalyticsInterval;
    after: string | null;
    limit: number;
  }): Promise<ActionHistoryPage> {
    const cursor = input.after === null ? null : decodeActionHistoryCursor(input.after);
    const limit = Math.min(Math.max(input.limit, 1), 100);
    const result = await this.pool.query<ActionHistoryQueryRow>(
      `SELECT reports.id, reports.discord_report_id, reports.flow, reports.report_type,
              reports.country, reports.input,
              COALESCE(submitted.created_at, reports.created_at) AS submitted_at,
              reports.discord_status_updated_at,
              CASE WHEN reports.review_status = 'approved' THEN 'appeal' ELSE 'direct' END
                AS action_source
       FROM reports
       LEFT JOIN LATERAL (
         SELECT report_events.created_at
         FROM report_events
         WHERE report_events.report_id = reports.id
           AND report_events.event_type = 'report_submitted'
         ORDER BY report_events.created_at, report_events.id
         LIMIT 1
       ) AS submitted ON true
       WHERE reports.submitter_discord_user_id = $1
         AND reports.discord_status = 'actioned'
         AND reports.discord_status_updated_at IS NOT NULL
         AND ($2::timestamptz IS NULL OR reports.discord_status_updated_at >= $2::timestamptz)
         AND reports.discord_status_updated_at < $3::timestamptz
         AND ($4::timestamptz IS NULL OR
           (reports.discord_status_updated_at, reports.id) < ($4::timestamptz, $5::text))
       ORDER BY reports.discord_status_updated_at DESC, reports.id DESC
       LIMIT $6`,
      [
        input.discordUserId,
        input.interval.startAt,
        input.interval.endAt,
        cursor?.actionedAt ?? null,
        cursor?.id ?? null,
        limit + 1
      ]
    );
    const hasMore = result.rows.length > limit;
    const rows = result.rows.slice(0, limit);
    const last = rows.at(-1);
    return {
      interval: input.interval,
      items: rows.map((row) => ({
        internalReportId: row.id,
        discordReportId: row.discord_report_id,
        flow: row.flow,
        category: row.report_type,
        country: row.country,
        submittedText: row.input.context ?? row.input.reportReason,
        messageUrl: row.input.flow === "message_urf" ? row.input.messageUrl : null,
        submittedAt: row.submitted_at.toISOString(),
        actionedAt: row.discord_status_updated_at.toISOString(),
        actionSource: row.action_source
      })),
      nextCursor: hasMore && last !== undefined
        ? encodeActionHistoryCursor({
          actionedAt: last.discord_status_updated_at.toISOString(),
          id: last.id
        })
        : null
    };
  }

  public async getReportByEmail(email: string): Promise<ReportRow | undefined> {
    const result = await this.pool.query<ReportRow>(
      `SELECT * FROM reports
       WHERE reporter_email = $1
         AND status IN ('requesting_verification', 'awaiting_verification', 'verification_received')`,
      [email.toLowerCase()]
    );
    return result.rows[0];
  }

  public async setStatus(
    reportId: string,
    status: ReportStatus,
    eventType: string
  ): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `UPDATE reports
         SET status = $2, error_code = NULL, error_message = NULL,
             retryable = false, failure_stage = NULL, updated_at = now()
         WHERE id = $1`,
        [reportId, status]
      );
      await this.event(client, reportId, eventType);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  public async saveAwaitingVerification(
    reportId: string,
    encryptedSessionState: string,
    proxySessionId: string
  ): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const updated = await client.query<Pick<ReportRow, "status">>(
        `UPDATE reports
         SET status = CASE
               WHEN status = 'verification_received' THEN status
               ELSE 'awaiting_verification'
             END,
             session_state = $2,
             proxy_session_id = $3,
             verification_deadline = CASE
               WHEN status = 'verification_received' THEN NULL
               ELSE COALESCE(
                 verification_deadline,
                 now() + ($4 * interval '1 second')
               )
             END,
             updated_at = now()
         WHERE id = $1
           AND status IN ('requesting_verification', 'awaiting_verification', 'verification_received')
         RETURNING status`,
        [
          reportId,
          encryptedSessionState,
          proxySessionId,
          VERIFICATION_EMAIL_TIMEOUT_SECONDS
        ]
      );
      if (updated.rowCount === 0) {
        throw new Error("Report is no longer waiting for verification.");
      }
      for (const [index, delaySeconds] of VERIFICATION_EMAIL_RESEND_DELAYS_SECONDS.entries()) {
        await client.query(
          `INSERT INTO report_jobs
             (report_id, kind, dedupe_key, payload, max_attempts, run_at)
           VALUES
             ($1, 'request_code', $2, $3, 1, now() + ($4 * interval '1 second'))
           ON CONFLICT (dedupe_key) DO NOTHING`,
          [
            reportId,
            `${reportId}:request-code-resend:${index + 1}`,
            { resend: true, resendNumber: index + 1 },
            delaySeconds
          ]
        );
      }
      await this.event(client, reportId, "verification_requested");
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  private async cancelPendingVerificationResends(
    client: PoolClient,
    reportId: string
  ): Promise<void> {
    await client.query(
      `UPDATE report_jobs
       SET state = 'completed', last_error = 'verification no longer pending', updated_at = now()
       WHERE report_id = $1
         AND kind = 'request_code'
         AND state = 'pending'
         AND payload->>'resend' = 'true'`,
      [reportId]
    );
  }

  public async saveResentVerificationSession(
    reportId: string,
    encryptedSessionState: string,
    resendNumber: number
  ): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const updated = await client.query(
        `UPDATE reports
         SET session_state = $2, updated_at = now()
         WHERE id = $1
           AND status IN ('awaiting_verification', 'verification_received')
           AND (status = 'verification_received' OR verification_deadline > now())
         RETURNING id, status`,
        [reportId, encryptedSessionState]
      );
      if (updated.rowCount === 1) {
        await this.event(client, reportId, "verification_email_resent", { resendNumber });
      }
      await client.query("COMMIT");
      return updated.rowCount === 1;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  public async expireVerificationWaits(): Promise<string[]> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const expired = await client.query<ReportRow>(
        `SELECT * FROM reports
         WHERE status = 'awaiting_verification'
           AND verification_deadline IS NOT NULL
           AND verification_deadline <= now()
         ORDER BY verification_deadline
         FOR UPDATE SKIP LOCKED`
      );
      for (const report of expired.rows) {
        const retryable = true;
        await client.query(
          `UPDATE reports
           SET status = 'failed', error_code = 'verification_email_timeout',
               error_message = 'Discord verification email was not received within 60 seconds.',
               retryable = $2, failure_stage = 'awaiting_verification',
               verification_deadline = NULL, session_state = NULL, updated_at = now()
           WHERE id = $1`,
          [report.id, retryable]
        );
        await this.event(client, report.id, "report_failed", {
          errorCode: "verification_email_timeout",
          failureStage: "awaiting_verification",
          retryable
        });
        await this.cancelPendingVerificationResends(client, report.id);
      }
      await client.query("COMMIT");
      return expired.rows.map((report) => report.id);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  public async expireDiscordReceiptWaits(): Promise<string[]> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const expired = await client.query<ReportRow>(
        `SELECT * FROM reports
         WHERE status = 'submitted'
           AND discord_status IS NULL
           AND receipt_deadline IS NOT NULL
           AND receipt_deadline <= now()
         ORDER BY receipt_deadline
         FOR UPDATE SKIP LOCKED`
      );
      for (const report of expired.rows) {
        const retryable = true;
        await client.query(
          `UPDATE reports
           SET status = 'failed', error_code = 'discord_receipt_timeout',
               error_message = 'Discord did not confirm receipt within 2 minutes.',
               retryable = $2, failure_stage = 'submitted',
               receipt_deadline = NULL, updated_at = now()
           WHERE id = $1`,
          [report.id, retryable]
        );
        await this.event(client, report.id, "report_failed", {
          errorCode: "discord_receipt_timeout",
          failureStage: "submitted",
          retryable
        });
      }
      await client.query("COMMIT");
      return expired.rows.map((report) => report.id);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  public async expireReviewConfirmationWaits(): Promise<string[]> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const expired = await client.query<ReportRow>(
        `SELECT * FROM reports
         WHERE review_status = 'requested'
           AND review_confirmation_deadline IS NOT NULL
           AND review_confirmation_deadline <= now()
         ORDER BY review_confirmation_deadline
         FOR UPDATE SKIP LOCKED`
      );
      for (const report of expired.rows) {
        await client.query(
          `UPDATE reports
           SET review_status = 'confirmation_timeout',
               review_status_updated_at = now(),
               review_confirmation_deadline = NULL,
               review_error_code = 'review_confirmation_timeout',
               review_error_message =
                 'Discord accepted the review request but no confirmation email arrived within 2 minutes.',
               updated_at = now()
           WHERE id = $1`,
          [report.id]
        );
        await this.event(client, report.id, "review_confirmation_timeout", {
          errorCode: "review_confirmation_timeout"
        });
      }
      await client.query("COMMIT");
      return expired.rows.map((report) => report.id);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  public async registerVerificationEmail(input: {
    messageId: string;
    recipient: string;
    encryptedCode: string;
  }): Promise<InboundEmailRegistration> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const reportResult = await client.query<ReportRow>(
        `SELECT * FROM reports
         WHERE reporter_email = $1
           AND status IN ('requesting_verification', 'awaiting_verification', 'verification_received')
         FOR UPDATE`,
        [input.recipient.toLowerCase()]
      );
      const report = reportResult.rows[0];
      const inserted = await client.query(
        `INSERT INTO inbound_messages (message_id, report_id, recipient, status)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (message_id) DO NOTHING
         RETURNING message_id`,
        [
          input.messageId,
          report?.id ?? null,
          input.recipient.toLowerCase(),
          report ? "accepted" : "unknown_recipient"
        ]
      );
      if (inserted.rowCount === 0) {
        await client.query("COMMIT");
        return { status: "duplicate", reportId: report?.id ?? null };
      }
      if (!report) {
        await client.query("COMMIT");
        return { status: "unknown_recipient", reportId: null };
      }
      await client.query(
        `INSERT INTO report_jobs (report_id, kind, dedupe_key, payload, max_attempts, run_at)
         VALUES ($1, 'verify_submit', $2, $3, 3, now() + interval '3 seconds')
         ON CONFLICT (dedupe_key) DO UPDATE
         SET payload = EXCLUDED.payload, state = 'pending', run_at = now(), updated_at = now()
         WHERE report_jobs.state = 'pending'`,
        [
          report.id,
          `${report.id}:verify-submit:${report.lifecycle_attempt}`,
          { encryptedCode: input.encryptedCode }
        ]
      );
      await client.query(
        `UPDATE reports SET status = 'verification_received', verification_deadline = NULL,
           updated_at = now() WHERE id = $1`,
        [report.id]
      );
      await this.cancelPendingVerificationResends(client, report.id);
      await this.event(client, report.id, "verification_email_received");
      await client.query("COMMIT");
      return { status: "accepted", reportId: report.id };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  public async registerReportUpdateEmail(input: {
    messageId: string;
    recipient: string;
    discordReportId: string;
    discordStatus: DiscordReportStatus;
    encryptedReviewUrl?: string;
  }): Promise<InboundEmailRegistration> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const reportResult = await client.query<ReportRow>(
        `SELECT * FROM reports
         WHERE discord_report_id = $1 AND reporter_email = $2
         FOR UPDATE`,
        [input.discordReportId, input.recipient.toLowerCase()]
      );
      const report = reportResult.rows[0];
      const inserted = await client.query(
        `INSERT INTO inbound_messages (
           message_id, report_id, recipient, status, external_report_id, external_status
         ) VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (message_id) DO NOTHING
         RETURNING message_id`,
        [
          input.messageId,
          report?.id ?? null,
          input.recipient.toLowerCase(),
          report ? "accepted" : "pending_report",
          input.discordReportId,
          input.discordStatus
        ]
      );
      if (inserted.rowCount === 0) {
        await client.query("COMMIT");
        return { status: "duplicate", reportId: report?.id ?? null };
      }
      if (!report) {
        await client.query("COMMIT");
        return { status: "pending_report", reportId: null };
      }
      if (
        input.discordStatus === "closed_no_action" &&
        input.encryptedReviewUrl !== undefined &&
        report.review_status === null
      ) {
        await client.query(
          `UPDATE reports
           SET review_status = 'queued', review_status_updated_at = now(),
               review_error_code = NULL, review_error_message = NULL,
               updated_at = now()
           WHERE id = $1 AND review_status IS NULL`,
          [report.id]
        );
        await client.query(
          `INSERT INTO report_jobs
             (report_id, kind, dedupe_key, payload, max_attempts, run_at)
           VALUES ($1, 'submit_review', $2, $3, 3, now())
           ON CONFLICT (dedupe_key) DO NOTHING`,
          [
            report.id,
            `${report.id}:submit-review`,
            { encryptedReviewUrl: input.encryptedReviewUrl }
          ]
        );
        await this.event(client, report.id, "review_queued");
      }
      if (!shouldApplyDiscordStatus(report.discord_status, input.discordStatus)) {
        await client.query("COMMIT");
        return { status: "accepted", reportId: report.id };
      }
      if (report.error_code === "discord_receipt_timeout") {
        await client.query(
          `UPDATE reports
           SET status = 'submitted', error_code = NULL, error_message = NULL,
               retryable = false, failure_stage = NULL, receipt_deadline = NULL,
               updated_at = now()
           WHERE id = $1`,
          [report.id]
        );
        await this.event(client, report.id, "report_receipt_recovered", {
          discordStatus: input.discordStatus
        });
      }
      await client.query(
        `UPDATE reports
         SET discord_status = $2,
              discord_status_updated_at = now(), receipt_deadline = NULL,
              review_status = CASE
                WHEN $2 = 'review_not_approved' THEN 'not_approved'
                WHEN $2 = 'actioned'
                  AND discord_status = 'closed_no_action'
                  AND review_status IS NOT NULL THEN 'approved'
                ELSE review_status
              END,
              review_status_updated_at = CASE
                WHEN $2 = 'review_not_approved'
                  OR ($2 = 'actioned'
                    AND discord_status = 'closed_no_action'
                    AND review_status IS NOT NULL) THEN now()
                ELSE review_status_updated_at
              END,
              review_confirmation_deadline = CASE
                WHEN $2 IN ('actioned', 'review_not_approved') THEN NULL
                ELSE review_confirmation_deadline
              END,
              review_error_code = CASE
                WHEN $2 IN ('actioned', 'review_not_approved') THEN NULL
                ELSE review_error_code
              END,
              review_error_message = CASE
                WHEN $2 IN ('actioned', 'review_not_approved') THEN NULL
                ELSE review_error_message
              END,
             updated_at = now()
         WHERE id = $1`,
        [report.id, input.discordStatus]
      );
      await this.event(client, report.id, "discord_status_updated", {
        discordStatus: input.discordStatus
      });
      await client.query("COMMIT");
      return { status: "accepted", reportId: report.id };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  public async registerReviewUpdateEmail(input: {
    messageId: string;
    recipient: string;
    discordReportId: string;
    reviewStatus: "received";
  }): Promise<InboundEmailRegistration> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const reportResult = await client.query<ReportRow>(
        `SELECT * FROM reports
         WHERE discord_report_id = $1 AND reporter_email = $2
         FOR UPDATE`,
        [input.discordReportId, input.recipient.toLowerCase()]
      );
      const report = reportResult.rows[0];
      const inserted = await client.query(
        `INSERT INTO inbound_messages (
           message_id, report_id, recipient, status, external_report_id, external_status
         ) VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (message_id) DO NOTHING
         RETURNING message_id`,
        [
          input.messageId,
          report?.id ?? null,
          input.recipient.toLowerCase(),
          report ? "accepted" : "pending_report",
          input.discordReportId,
          `review_${input.reviewStatus}`
        ]
      );
      if (inserted.rowCount === 0) {
        await client.query("COMMIT");
        return { status: "duplicate", reportId: report?.id ?? null };
      }
      if (!report) {
        await client.query("COMMIT");
        return { status: "pending_report", reportId: null };
      }
      if (
        report.review_status !== "approved" &&
        report.review_status !== "not_approved" &&
        report.review_status !== "received"
      ) {
        await client.query(
          `UPDATE reports
           SET review_status = 'received', review_status_updated_at = now(),
               review_confirmation_deadline = NULL,
               review_error_code = NULL, review_error_message = NULL,
               updated_at = now()
           WHERE id = $1`,
          [report.id]
        );
        await this.event(client, report.id, "review_received");
      }
      await client.query("COMMIT");
      return { status: "accepted", reportId: report.id };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  public async markReviewRequested(
    reportId: string,
    discordReportId: string
  ): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const updated = await client.query(
        `UPDATE reports
         SET review_status = 'requested', review_status_updated_at = now(),
             review_confirmation_deadline =
               now() + ($3 * interval '1 second'),
             review_error_code = NULL, review_error_message = NULL,
             updated_at = now()
         WHERE id = $1 AND discord_report_id = $2 AND review_status = 'queued'
         RETURNING id`,
        [reportId, discordReportId, DISCORD_REVIEW_CONFIRMATION_TIMEOUT_SECONDS]
      );
      if (updated.rowCount !== 1) {
        throw new Error("Report is no longer waiting for review submission.");
      }
      await this.event(client, reportId, "review_requested");
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  public async failReviewRequest(
    reportId: string,
    ambiguous: boolean,
    errorCode: string,
    errorMessage: string
  ): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const reviewStatus: DiscordReviewStatus = ambiguous
        ? "request_ambiguous"
        : "request_failed";
      const updated = await client.query(
        `UPDATE reports
         SET review_status = $2, review_status_updated_at = now(),
             review_confirmation_deadline = NULL,
             review_error_code = $3, review_error_message = $4,
             updated_at = now()
         WHERE id = $1 AND review_status = 'queued'`,
        [reportId, reviewStatus, errorCode, errorMessage]
      );
      if (updated.rowCount === 1) {
        await this.event(
          client,
          reportId,
          ambiguous ? "review_request_ambiguous" : "review_request_failed",
          { errorCode }
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  public async markReviewIneligible(
    reportId: string,
    errorCode: string,
    errorMessage: string
  ): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const updated = await client.query(
        `UPDATE reports
         SET review_status = 'ineligible', review_status_updated_at = now(),
             review_confirmation_deadline = NULL,
             review_error_code = $2, review_error_message = $3,
             updated_at = now()
         WHERE id = $1 AND review_status = 'queued'`,
        [reportId, errorCode, errorMessage]
      );
      if (updated.rowCount === 1) {
        await this.event(client, reportId, "review_ineligible", {
          errorCode,
          discordErrorCode: "521004"
        });
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  public async retryIneligibleReview(
    input: RetryIneligibleReviewInput
  ): Promise<RetryIneligibleReviewResult> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const reportResult = await client.query<ReportRow>(
        "SELECT * FROM reports WHERE id = $1 FOR UPDATE",
        [input.reportId]
      );
      const report = reportResult.rows[0];
      if (!report) throw new ReviewRetryError("report_not_found");
      if (report.submitter_discord_user_id !== input.submitterDiscordUserId) {
        throw new ReviewRetryError("report_owner_mismatch");
      }
      const replayResult = await client.query(
        `SELECT 1
         FROM review_retry_requests
         WHERE report_id = $1 AND idempotency_key = $2`,
        [report.id, input.idempotencyKey]
      );
      if (replayResult.rowCount === 1) {
        await client.query("COMMIT");
        return { replayed: true, report };
      }
      if (report.review_status !== "ineligible") {
        throw new ReviewRetryError("review_not_ineligible");
      }
      if (
        report.review_retry_requested_at !== null &&
        report.review_retry_requested_at.getTime() >
          Date.now() - REVIEW_RETRY_COOLDOWN_SECONDS * 1_000
      ) {
        throw new ReviewRetryError("review_retry_cooldown");
      }
      const jobResult = await client.query<{
        id: string;
        state: string;
      }>(
        `SELECT id::text, state
         FROM report_jobs
         WHERE report_id = $1 AND kind = 'submit_review'
         FOR UPDATE`,
        [report.id]
      );
      const job = jobResult.rows[0];
      if (!job || (job.state !== "completed" && job.state !== "failed")) {
        throw new ReviewRetryError("review_retry_unavailable");
      }
      await client.query(
        `INSERT INTO review_retry_requests (report_id, idempotency_key)
         VALUES ($1, $2)`,
        [report.id, input.idempotencyKey]
      );
      await client.query(
        `UPDATE report_jobs
         SET state = 'pending', attempts = 0, max_attempts = 3, run_at = now(),
             payload = payload - 'ineligibleRetryPending',
             locked_at = NULL, last_error = NULL, updated_at = now()
         WHERE id = $1`,
        [job.id]
      );
      const updatedResult = await client.query<ReportRow>(
        `UPDATE reports
         SET review_status = 'queued', review_status_updated_at = now(),
             review_confirmation_deadline = NULL,
             review_error_code = NULL, review_error_message = NULL,
             review_retry_requested_at = now(), updated_at = now()
         WHERE id = $1
         RETURNING *`,
        [report.id]
      );
      const updated = updatedResult.rows[0];
      if (!updated) throw new Error("Review retry update returned no report.");
      await this.event(client, report.id, "review_queued", { manual: true });
      await client.query("COMMIT");
      return { replayed: false, report: updated };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  public async claimJob(): Promise<JobRow | undefined> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query<JobRow>(
        `SELECT id::text, report_id, kind, payload, attempts, max_attempts
         FROM report_jobs
         WHERE state = 'pending' AND run_at <= now()
         ORDER BY run_at, id
         FOR UPDATE SKIP LOCKED
         LIMIT 1`
      );
      const job = result.rows[0];
      if (job) {
        await client.query(
          `UPDATE report_jobs
           SET state = 'running', attempts = attempts + 1, locked_at = now(), updated_at = now()
           WHERE id = $1`,
          [job.id]
        );
        job.attempts += 1;
      }
      await client.query("COMMIT");
      return job;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  public async completeJob(jobId: string): Promise<void> {
    await this.pool.query(
      "UPDATE report_jobs SET state = 'completed', updated_at = now() WHERE id = $1",
      [jobId]
    );
  }

  public async retryJob(job: JobRow, message: string, delaySeconds: number): Promise<void> {
    await this.pool.query(
      `UPDATE report_jobs
       SET state = 'pending', run_at = now() + ($2 * interval '1 second'),
           locked_at = NULL, last_error = $3, updated_at = now()
       WHERE id = $1`,
      [job.id, delaySeconds, message]
    );
  }

  public async retryReviewIneligibleJob(
    job: JobRow,
    message: string,
    delaySeconds: number
  ): Promise<void> {
    await this.pool.query(
      `UPDATE report_jobs
       SET state = 'pending', run_at = now() + ($2 * interval '1 second'),
           payload = jsonb_set(payload, '{ineligibleRetryPending}', 'true'::jsonb),
           max_attempts = GREATEST(max_attempts, attempts + 1),
           locked_at = NULL, last_error = $3, updated_at = now()
       WHERE id = $1`,
      [job.id, delaySeconds, message]
    );
  }

  public async failJobAndReport(
    job: JobRow,
    errorCode: string,
    message: string
  ): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const reportResult = await client.query<ReportRow>(
        "SELECT * FROM reports WHERE id = $1 FOR UPDATE",
        [job.report_id]
      );
      const report = reportResult.rows[0];
      if (!report) throw new Error("Report no longer exists.");
      const retryable = isRetryableFailure(
        report.status,
        errorCode,
        report.retry_sequence
      );
      await client.query(
        "UPDATE report_jobs SET state = 'failed', last_error = $2, updated_at = now() WHERE id = $1",
        [job.id, message]
      );
      await client.query(
        `UPDATE reports
         SET status = 'failed', error_code = $2, error_message = $3, updated_at = now()
             , retryable = $4, failure_stage = $5, verification_deadline = NULL
         WHERE id = $1`,
        [job.report_id, errorCode, message, retryable, report.status]
      );
      await this.event(client, job.report_id, "report_failed", {
        errorCode,
        failureStage: report.status,
        lifecycleAttempt: report.lifecycle_attempt,
        retryable
      });
      await this.cancelPendingVerificationResends(client, job.report_id);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  public async retryReport(record: RetryReportRecord): Promise<RetryReportResult> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const reportResult = await client.query<ReportRow>(
        "SELECT * FROM reports WHERE id = $1 FOR UPDATE",
        [record.reportId]
      );
      const report = reportResult.rows[0];
      if (!report) throw new ReportRetryError("report_not_found");
      if (report.submitter_discord_user_id !== record.submitterDiscordUserId) {
        throw new ReportRetryError("report_owner_mismatch");
      }

      const replayResult = await client.query<ReportRow>(
        "SELECT * FROM reports WHERE idempotency_key = $1 FOR UPDATE",
        [record.idempotencyKey]
      );
      const replay = replayResult.rows[0];
      if (replay) {
        if (
          replay.retry_of_report_id !== report.id ||
          replay.request_hash !== record.requestHash
        ) {
          throw new IdempotencyConflictError();
        }
        await client.query("COMMIT");
        return { replayed: true, report: replay };
      }
      const failedRetry = report.status === "failed";
      const deniedReviewResubmission =
        report.discord_status === "review_not_approved" &&
        report.retried_as_report_id === null;
      if (!failedRetry && !deniedReviewResubmission) {
        throw new ReportRetryError("report_not_failed");
      }
      if (failedRetry && !report.retryable) {
        throw new ReportRetryError("report_not_retryable");
      }
      if (
        record.mode === "automatic" &&
        (report.error_code === "discord_receipt_timeout" || report.retry_sequence >= 2)
      ) {
        throw new ReportRetryError("report_not_retryable");
      }
      if (failedRetry && record.hasOverrides) {
        throw new ReportRetryError("report_not_retryable");
      }
      if (record.mode === "manual" && report.error_code === "discord_receipt_timeout") {
        const priorTimeout = await client.query<{ exists: boolean }>(
          `WITH RECURSIVE ancestors AS (
             SELECT retry_of_report_id FROM reports WHERE id = $1
             UNION ALL
             SELECT parent.retry_of_report_id
             FROM reports parent
             JOIN ancestors child ON parent.id = child.retry_of_report_id
             WHERE child.retry_of_report_id IS NOT NULL
           )
           SELECT EXISTS (
             SELECT 1 FROM reports
             WHERE id IN (SELECT retry_of_report_id FROM ancestors)
               AND error_code = 'discord_receipt_timeout'
           ) AS exists`,
          [report.id]
        );
        if (priorTimeout.rows[0]?.exists) {
          throw new ReportRetryError("report_not_retryable");
        }
      }
      const nextSequence = report.retry_sequence + 1;
      const inserted = await client.query<ReportRow>(
        `INSERT INTO reports (
           id, idempotency_key, request_hash, flow, country, report_type,
           submitter_discord_user_id, reporter_legal_name, reporter_email,
           timezone, locale, language, proxy_session_id, status, input,
           retry_of_report_id, retry_sequence
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
           'queued', $14, $15, $16
         ) RETURNING *`,
        [
          record.id,
          record.idempotencyKey,
          record.requestHash,
          report.flow,
          report.country,
          report.report_type,
          report.submitter_discord_user_id,
          record.legalName,
          record.email.toLowerCase(),
          record.timezone,
          record.locale,
          record.language,
          record.proxySessionId,
          record.input,
          report.id,
          nextSequence
        ]
      );
      await client.query(
        `INSERT INTO report_jobs (report_id, kind, dedupe_key, max_attempts)
         VALUES ($1, 'request_code', $2, 3)`,
        [record.id, `${record.id}:request-code:1`]
      );
      const successor = inserted.rows[0];
      if (!successor) throw new Error("Retry report insert returned no row.");
      await client.query(
        `UPDATE reports SET retryable = false, retried_as_report_id = $2, updated_at = now()
         WHERE id = $1`,
        [report.id, successor.id]
      );
      await this.event(client, successor.id, "report_api_request_sent", {
        retryOfReportId: report.id,
        retrySequence: nextSequence
      });
      await this.event(client, successor.id, "report_created", {
        retryOfReportId: report.id,
        retrySequence: nextSequence
      });
      await this.event(client, report.id, "report_retry_created", {
        newReportId: successor.id,
        retrySequence: nextSequence
      });
      await client.query("COMMIT");
      return { replayed: false, report: successor };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  public async markSubmitted(reportId: string, discordReportId: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `UPDATE reports
         SET status = 'submitted', discord_report_id = $2, session_state = NULL,
             verification_deadline = NULL,
             receipt_deadline = now() + ($3 * interval '1 second'),
             error_code = NULL, error_message = NULL, retryable = false,
             failure_stage = NULL, updated_at = now()
         WHERE id = $1`,
        [reportId, discordReportId, DISCORD_RECEIPT_TIMEOUT_SECONDS]
      );
      await this.event(client, reportId, "report_submitted", { discordReportId });
      const pending = await client.query<{ external_status: DiscordReportStatus }>(
        `SELECT external_status
         FROM inbound_messages
         WHERE external_report_id = $1 AND recipient = (
           SELECT reporter_email FROM reports WHERE id = $2
         ) AND report_id IS NULL
           AND external_status IN (
             'received', 'actioned', 'closed_no_action', 'review_not_approved'
           )
         ORDER BY received_at DESC
         LIMIT 1`,
        [discordReportId, reportId]
      );
      const pendingStatus = pending.rows[0]?.external_status;
      if (pendingStatus !== undefined) {
        await client.query(
          `UPDATE reports
           SET discord_status = $2, discord_status_updated_at = now(),
               receipt_deadline = NULL, updated_at = now()
           WHERE id = $1`,
          [reportId, pendingStatus]
        );
        await client.query(
          `UPDATE inbound_messages
           SET report_id = $2, status = 'accepted'
           WHERE external_report_id = $1 AND report_id IS NULL`,
          [discordReportId, reportId]
        );
        await this.event(client, reportId, "discord_status_updated", {
          discordStatus: pendingStatus
        });
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}

export class IdempotencyConflictError extends Error {
  public constructor() {
    super("Idempotency-Key was already used with a different request body.");
    this.name = "IdempotencyConflictError";
  }
}

const RETRY_ERROR_MESSAGES: Record<ReportRetryErrorCode, string> = {
  report_not_found: "Report was not found.",
  report_owner_mismatch: "The Discord user does not own this report.",
  report_not_failed:
    "Only safely failed reports or reports with a denied review can be resent.",
  report_not_retryable: "This report cannot be retried safely."
};

export class ReportRetryError extends Error {
  public readonly code: ReportRetryErrorCode;
  public readonly statusCode: number;

  public constructor(code: ReportRetryErrorCode) {
    super(RETRY_ERROR_MESSAGES[code]);
    this.name = "ReportRetryError";
    this.code = code;
    this.statusCode = code === "report_not_found" ? 404 : code === "report_owner_mismatch" ? 403 : 409;
  }
}

export type ReviewRetryErrorCode =
  | "report_not_found"
  | "report_owner_mismatch"
  | "review_not_ineligible"
  | "review_retry_unavailable"
  | "review_retry_cooldown";

const REVIEW_RETRY_ERROR_MESSAGES: Record<ReviewRetryErrorCode, string> = {
  report_not_found: "Report was not found.",
  report_owner_mismatch: "The Discord user does not own this report.",
  review_not_ineligible: "Only a definitively ineligible appeal can be retried.",
  review_retry_unavailable: "This appeal is already pending or cannot be retried safely.",
  review_retry_cooldown: "Wait 30 seconds before retrying this appeal again."
};

export class ReviewRetryError extends Error {
  public readonly code: ReviewRetryErrorCode;
  public readonly statusCode: number;

  public constructor(code: ReviewRetryErrorCode) {
    super(REVIEW_RETRY_ERROR_MESSAGES[code]);
    this.name = "ReviewRetryError";
    this.code = code;
    this.statusCode = code === "report_not_found" ? 404 : code === "report_owner_mismatch" ? 403 : 409;
  }
}
