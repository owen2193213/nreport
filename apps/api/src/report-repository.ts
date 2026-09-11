import { createHash, randomUUID } from "node:crypto";

import type {
  CreateReportInput,
  CursorPage,
  ReportLifecycleEvent,
  ReportStatus,
  ReportTimelineEvent,
  RetryReportInput
} from "@nreport/contracts";
import type { Pool, PoolClient, QueryResultRow } from "pg";
import type { LifecycleJob, LifecycleReport } from "./lifecycle-runner-v2.js";
import type { AccountEventDelivery } from "./event-delivery-v2.js";

export const REPORT_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS report_credit_chains (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES api_accounts(id) ON DELETE RESTRICT,
  state text NOT NULL CHECK (state IN ('available', 'reserved', 'consumed', 'released')),
  original_report_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS account_reports (
  id uuid PRIMARY KEY,
  trace_id uuid NOT NULL DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES api_accounts(id) ON DELETE RESTRICT,
  idempotency_key text NOT NULL,
  request_hash text NOT NULL,
  flow text NOT NULL CHECK (flow IN ('message', 'profile', 'server')),
  use_ai boolean NOT NULL,
  request_input jsonb NOT NULL,
  prepared_input jsonb,
  legal_reference text,
  research_summary text,
  research_sources jsonb NOT NULL DEFAULT '[]'::jsonb,
  safe_ai_summary jsonb,
  preparation_ai_requests bigint NOT NULL DEFAULT 0 CHECK (preparation_ai_requests >= 0),
  preparation_input_tokens bigint NOT NULL DEFAULT 0 CHECK (preparation_input_tokens >= 0),
  preparation_output_tokens bigint NOT NULL DEFAULT 0 CHECK (preparation_output_tokens >= 0),
  preparation_search_requests bigint NOT NULL DEFAULT 0 CHECK (preparation_search_requests >= 0),
  credit_chain_id uuid NOT NULL REFERENCES report_credit_chains(id) ON DELETE RESTRICT,
  predecessor_report_id uuid REFERENCES account_reports(id) ON DELETE RESTRICT,
  successor_report_id uuid REFERENCES account_reports(id) ON DELETE RESTRICT,
  retry_mode text CHECK (retry_mode IS NULL OR retry_mode IN ('reuse', 'regenerate', 'rewrite_ai', 'edit_manual')),
  retry_sequence integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'queued',
  reporter_legal_name text,
  reporter_email text UNIQUE,
  timezone text,
  locale text,
  language text,
  proxy_session_id text,
  session_state text,
  discord_report_id text,
  discord_status text,
  discord_status_updated_at timestamptz,
  review_status text,
  review_status_updated_at timestamptz,
  review_confirmation_deadline timestamptz,
  review_submission_started_at timestamptz,
  review_error_code text,
  review_error_message text,
  failure_stage text,
  error_code text,
  error_message text,
  submission_started_at timestamptz,
  verification_deadline timestamptz,
  receipt_deadline timestamptz,
  lifecycle_attempt integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, idempotency_key),
  UNIQUE (predecessor_report_id)
);

ALTER TABLE account_reports ADD COLUMN IF NOT EXISTS trace_id uuid;
UPDATE account_reports SET trace_id = gen_random_uuid() WHERE trace_id IS NULL;
ALTER TABLE account_reports ALTER COLUMN trace_id SET DEFAULT gen_random_uuid();
ALTER TABLE account_reports ALTER COLUMN trace_id SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS account_reports_trace_idx ON account_reports(trace_id);

DO $$ BEGIN
  ALTER TABLE report_credit_chains
    ADD CONSTRAINT report_credit_chains_original_report_fk
    FOREIGN KEY (original_report_id) REFERENCES account_reports(id) ON DELETE RESTRICT;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE credit_ledger
    ADD CONSTRAINT credit_ledger_credit_chain_fk
    FOREIGN KEY (credit_chain_id) REFERENCES report_credit_chains(id) ON DELETE RESTRICT;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS account_report_events (
  id bigserial PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES api_accounts(id) ON DELETE RESTRICT,
  report_id uuid NOT NULL REFERENCES account_reports(id) ON DELETE CASCADE,
  event_type text NOT NULL,
  lifecycle_attempt integer NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION serialize_account_report_event_inserts()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(1729132441);
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS account_report_events_serialize_insert ON account_report_events;
CREATE TRIGGER account_report_events_serialize_insert
  AFTER INSERT ON account_report_events
  FOR EACH ROW EXECUTE FUNCTION serialize_account_report_event_inserts();

CREATE TABLE IF NOT EXISTS account_report_jobs (
  id bigserial PRIMARY KEY,
  report_id uuid NOT NULL REFERENCES account_reports(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('prepare_report', 'request_code', 'verify_submit', 'submit_review')),
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

CREATE TABLE IF NOT EXISTS account_inbound_messages (
  message_id text PRIMARY KEY,
  report_id uuid REFERENCES account_reports(id) ON DELETE SET NULL,
  recipient text NOT NULL,
  status text NOT NULL,
  external_report_id text,
  external_status text,
  encrypted_payload text,
  received_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS account_rate_limit_windows (
  account_id uuid NOT NULL REFERENCES api_accounts(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('report_mutation', 'ai_preparation', 'account_read')),
  window_start timestamptz NOT NULL,
  request_count integer NOT NULL CHECK (request_count > 0),
  PRIMARY KEY (account_id, kind, window_start)
);

ALTER TABLE account_rate_limit_windows
  DROP CONSTRAINT IF EXISTS account_rate_limit_windows_kind_check;
ALTER TABLE account_rate_limit_windows
  ADD CONSTRAINT account_rate_limit_windows_kind_check
  CHECK (kind IN ('report_mutation', 'ai_preparation', 'account_read'));

ALTER TABLE account_reports DROP CONSTRAINT IF EXISTS account_reports_retry_mode_check;
ALTER TABLE account_reports ADD CONSTRAINT account_reports_retry_mode_check
  CHECK (retry_mode IS NULL OR retry_mode IN ('reuse', 'regenerate', 'rewrite_ai', 'edit_manual'));

CREATE TABLE IF NOT EXISTS event_destination_deliveries (
  event_id bigint NOT NULL REFERENCES account_report_events(id) ON DELETE CASCADE,
  destination_id uuid NOT NULL REFERENCES webhook_destinations(id) ON DELETE RESTRICT,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'sending', 'sent', 'expired')),
  attempts integer NOT NULL DEFAULT 0,
  run_at timestamptz NOT NULL DEFAULT now(),
  locked_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (event_id, destination_id)
);

CREATE INDEX IF NOT EXISTS account_reports_owner_created_idx
  ON account_reports(account_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS account_report_events_owner_idx
  ON account_report_events(account_id, id);
CREATE INDEX IF NOT EXISTS account_report_jobs_claim_idx
  ON account_report_jobs(kind, state, run_at, locked_at, id);
CREATE INDEX IF NOT EXISTS event_destination_deliveries_claim_idx
  ON event_destination_deliveries(state, run_at, locked_at, event_id);

-- Aggregate-only operations telemetry. These tables deliberately contain no report,
-- account, Discord, or webhook destination identifiers.
CREATE TABLE IF NOT EXISTS operational_worker_health (
  component text NOT NULL,
  instance_id uuid NOT NULL,
  last_heartbeat_at timestamptz NOT NULL DEFAULT now(),
  last_progress_at timestamptz,
  active_jobs integer NOT NULL DEFAULT 0,
  configured_capacity integer NOT NULL DEFAULT 0,
  recent_failure_count integer NOT NULL DEFAULT 0,
  recent_rate_limit_count integer NOT NULL DEFAULT 0,
  window_started_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (component, instance_id)
);

CREATE TABLE IF NOT EXISTS operational_alert_state (
  alert_key text PRIMARY KEY,
  severity text NOT NULL CHECK (severity IN ('warning', 'critical')),
  state text NOT NULL CHECK (state IN ('open', 'closed')),
  first_observed_at timestamptz NOT NULL DEFAULT now(),
  last_observed_at timestamptz NOT NULL DEFAULT now(),
  last_sent_at timestamptz,
  recovery_sent_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS operations_alert_outbox (
  id bigserial PRIMARY KEY,
  alert_key text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('open', 'reminder', 'recovery')),
  payload jsonb NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'sending', 'sent')),
  attempts integer NOT NULL DEFAULT 0,
  run_at timestamptz NOT NULL DEFAULT now(),
  locked_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (alert_key, kind, state)
);
CREATE INDEX IF NOT EXISTS operations_alert_outbox_claim_idx
  ON operations_alert_outbox(state, run_at, locked_at, id);
`;

export class ReportMutationError extends Error {
  public constructor(
    public readonly code:
      | "account_not_found"
      | "account_suspended"
      | "credits_exhausted"
      | "idempotency_conflict"
      | "report_not_found"
      | "invalid_retry"
      | "retry_cooldown"
      | "invalid_cursor"
      | "rate_limited",
    message: string
  ) {
    super(message);
    this.name = "ReportMutationError";
  }
}

export interface AccountReportRow extends QueryResultRow {
  id: string;
  trace_id: string;
  account_id: string;
  idempotency_key: string;
  request_hash: string;
  flow: CreateReportInput["flow"];
  use_ai: boolean;
  request_input: CreateReportInput;
  prepared_input: Record<string, unknown> | null;
  retry_mode: "reuse" | "regenerate" | "rewrite_ai" | "edit_manual" | null;
  legal_reference: string | null;
  research_summary: string | null;
  research_sources: unknown[];
  credit_state?: "available" | "reserved" | "consumed" | "released";
  lifecycle_attempt: number;
  discord_report_id: string | null;
  discord_status: "received" | "actioned" | "closed_no_action" | "review_not_approved" | null;
  review_status: "queued" | "requested" | "received" | "confirmation_timeout" | "request_failed" | "ineligible" | "request_ambiguous" | "approved" | "not_approved" | null;
  failure_stage: string | null;
  error_code: string | null;
  error_message: string | null;
  predecessor_report_id: string | null;
  successor_report_id: string | null;
  submission_started_at: Date | null;
  status: ReportStatus;
  credit_chain_id: string;
  created_at: Date;
  updated_at: Date;
}

export interface InboundEmailRegistration {
  status: "accepted" | "duplicate" | "unknown_recipient" | "pending_report";
  reportId: string | null;
}

export class ReportRepository {
  public constructor(private readonly pool: Pick<Pool, "connect" | "query">) {}

  public async queueSnapshot(): Promise<QueueSnapshot> {
    const result = await this.pool.query<QueueSnapshotRow>(
      `SELECT
         count(*) FILTER (WHERE kind = 'prepare_report' AND state = 'pending' AND run_at <= now())::text AS preparation_ready,
         count(*) FILTER (WHERE kind = 'prepare_report' AND state = 'pending' AND run_at > now())::text AS preparation_delayed,
         count(*) FILTER (WHERE kind = 'prepare_report' AND state = 'running')::text AS preparation_running,
         extract(epoch FROM (now() - min(run_at) FILTER (WHERE kind = 'prepare_report' AND state = 'pending' AND run_at <= now()))) * 1000 AS preparation_oldest_ms,
         count(*) FILTER (WHERE kind <> 'prepare_report' AND state = 'pending' AND run_at <= now())::text AS lifecycle_ready,
         count(*) FILTER (WHERE kind <> 'prepare_report' AND state = 'pending' AND run_at > now())::text AS lifecycle_delayed,
         count(*) FILTER (WHERE kind <> 'prepare_report' AND state = 'running')::text AS lifecycle_running,
         extract(epoch FROM (now() - min(run_at) FILTER (WHERE kind <> 'prepare_report' AND state = 'pending' AND run_at <= now()))) * 1000 AS lifecycle_oldest_ms,
         count(*) FILTER (WHERE kind = 'request_code' AND state IN ('pending', 'running'))::text AS request_code,
         count(*) FILTER (WHERE kind = 'verify_submit' AND state IN ('pending', 'running'))::text AS verify_submit,
         count(*) FILTER (WHERE kind = 'submit_review' AND state IN ('pending', 'running'))::text AS submit_review
       FROM account_report_jobs`
    );
    const row = result.rows[0];
    return {
      preparation: queuePhase(row?.preparation_ready, row?.preparation_delayed, row?.preparation_running, row?.preparation_oldest_ms),
      lifecycle: {
        ...queuePhase(row?.lifecycle_ready, row?.lifecycle_delayed, row?.lifecycle_running, row?.lifecycle_oldest_ms),
        byJobKind: {
          requestCode: count(row?.request_code),
          verifySubmit: count(row?.verify_submit),
          submitReview: count(row?.submit_review)
        }
      }
    };
  }

  public async queueLength(): Promise<number> {
    const result = await this.pool.query<{ count: string }>(
      "SELECT count(DISTINCT report_id)::text AS count FROM account_report_jobs WHERE state IN ('pending', 'running')"
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  public async recordOperationalWorker(sample: {
    component: string;
    instanceId: string;
    configuredCapacity: number;
    activeJobs?: number;
    progressed?: boolean;
    failure?: boolean;
    rateLimited?: boolean;
  }): Promise<void> {
    await this.pool.query(
      `INSERT INTO operational_worker_health (
         component, instance_id, configured_capacity, active_jobs, last_progress_at,
         recent_failure_count, recent_rate_limit_count
       ) VALUES ($1, $2::uuid, $3, $4, CASE WHEN $5 THEN now() ELSE NULL END,
         CASE WHEN $6 THEN 1 ELSE 0 END, CASE WHEN $7 THEN 1 ELSE 0 END)
       ON CONFLICT (component, instance_id) DO UPDATE SET
         configured_capacity = EXCLUDED.configured_capacity,
         active_jobs = EXCLUDED.active_jobs,
         last_heartbeat_at = now(),
         last_progress_at = CASE WHEN $5 THEN now() ELSE operational_worker_health.last_progress_at END,
         recent_failure_count = CASE
           WHEN operational_worker_health.window_started_at < now() - interval '5 minutes' THEN CASE WHEN $6 THEN 1 ELSE 0 END
           ELSE operational_worker_health.recent_failure_count + CASE WHEN $6 THEN 1 ELSE 0 END END,
         recent_rate_limit_count = CASE
           WHEN operational_worker_health.window_started_at < now() - interval '5 minutes' THEN CASE WHEN $7 THEN 1 ELSE 0 END
           ELSE operational_worker_health.recent_rate_limit_count + CASE WHEN $7 THEN 1 ELSE 0 END END,
         window_started_at = CASE WHEN operational_worker_health.window_started_at < now() - interval '5 minutes' THEN now() ELSE operational_worker_health.window_started_at END,
         updated_at = now()`,
      [sample.component, sample.instanceId, sample.configuredCapacity, sample.activeJobs ?? 0,
        sample.progressed ?? false, sample.failure ?? false, sample.rateLimited ?? false]
    );
  }

  public async operationalWorkerHealth(): Promise<Array<{
    component: string; heartbeatAgeMs: number; progressAgeMs: number | null; configuredCapacity: number;
    activeJobs: number; recentFailureCount: number; recentRateLimitCount: number;
  }>> {
    const result = await this.pool.query<{
      component: string; heartbeat_age_ms: string; progress_age_ms: string | null;
      configured_capacity: number; active_jobs: number; recent_failure_count: number; recent_rate_limit_count: number;
    }>(`SELECT component,
         (extract(epoch FROM now() - max(last_heartbeat_at)) * 1000)::text AS heartbeat_age_ms,
         (extract(epoch FROM now() - max(last_progress_at)) * 1000)::text AS progress_age_ms,
         sum(configured_capacity)::int AS configured_capacity, sum(active_jobs)::int AS active_jobs,
         sum(recent_failure_count)::int AS recent_failure_count, sum(recent_rate_limit_count)::int AS recent_rate_limit_count
       FROM operational_worker_health WHERE updated_at >= now() - interval '10 minutes' GROUP BY component`);
    return result.rows.map((row) => ({
      component: row.component, heartbeatAgeMs: Number(row.heartbeat_age_ms),
      progressAgeMs: row.progress_age_ms === null ? null : Number(row.progress_age_ms),
      configuredCapacity: row.configured_capacity, activeJobs: row.active_jobs,
      recentFailureCount: row.recent_failure_count, recentRateLimitCount: row.recent_rate_limit_count
    }));
  }

  public async transitionOperationalAlerts(alerts: Array<{ key: string; severity: "warning" | "critical" }>): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const seen = new Set(alerts.map((alert) => alert.key));
      for (const alert of alerts) {
        const prior = await client.query<{ state: "open" | "closed"; last_sent_at: Date | null }>(
          "SELECT state, last_sent_at FROM operational_alert_state WHERE alert_key = $1 FOR UPDATE", [alert.key]
        );
        const row = prior.rows[0];
        const shouldSend = row === undefined || row.state === "closed" || row.last_sent_at === null || row.last_sent_at < new Date(Date.now() - 30 * 60_000);
        await client.query(
          `INSERT INTO operational_alert_state (alert_key, severity, state, last_sent_at)
           VALUES ($1, $2, 'open', CASE WHEN $3 THEN now() ELSE NULL END)
           ON CONFLICT (alert_key) DO UPDATE SET severity = EXCLUDED.severity, state = 'open',
             last_observed_at = now(), last_sent_at = CASE WHEN $3 THEN now() ELSE operational_alert_state.last_sent_at END, updated_at = now()`,
          [alert.key, alert.severity, shouldSend]
        );
        if (shouldSend) await client.query(
          `INSERT INTO operations_alert_outbox (alert_key, kind, payload)
           VALUES ($1, $2, jsonb_build_object('alertKey', $1::text, 'severity', $3::text))
           ON CONFLICT (alert_key, kind, state) DO NOTHING`,
          [alert.key, row?.state === "open" ? "reminder" : "open", alert.severity]
        );
      }
      const open = await client.query<{ alert_key: string }>("SELECT alert_key FROM operational_alert_state WHERE state = 'open' FOR UPDATE");
      for (const row of open.rows) if (!seen.has(row.alert_key)) {
        await client.query("UPDATE operational_alert_state SET state = 'closed', recovery_sent_at = now(), updated_at = now() WHERE alert_key = $1", [row.alert_key]);
        await client.query(
          `INSERT INTO operations_alert_outbox (alert_key, kind, payload)
           VALUES ($1, 'recovery', jsonb_build_object('alertKey', $1::text, 'status', 'recovered'))
           ON CONFLICT (alert_key, kind, state) DO NOTHING`, [row.alert_key]
        );
      }
      await client.query("COMMIT");
    } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
  }

  public async claimOperationsAlert(): Promise<{ id: string; payload: { alertKey: string; severity?: string; status?: string }; attempts: number } | null> {
    const result = await this.pool.query<{ id: string; payload: { alertKey: string; severity?: string; status?: string }; attempts: number }>(
      `WITH candidate AS (
         SELECT id FROM operations_alert_outbox WHERE state = 'pending' AND run_at <= now()
           AND (locked_at IS NULL OR locked_at < now() - interval '2 minutes') ORDER BY run_at, id FOR UPDATE SKIP LOCKED LIMIT 1
       ) UPDATE operations_alert_outbox AS item SET state = 'sending', locked_at = now(), attempts = attempts + 1, updated_at = now()
       FROM candidate WHERE item.id = candidate.id RETURNING item.id::text, item.payload, item.attempts`
    );
    return result.rows[0] ?? null;
  }

  public async completeOperationsAlert(id: string): Promise<void> {
    await this.pool.query("UPDATE operations_alert_outbox SET state = 'sent', locked_at = NULL, updated_at = now() WHERE id = $1", [id]);
  }

  public async retryOperationsAlert(id: string, delaySeconds: number, category: string): Promise<void> {
    await this.pool.query(
      `UPDATE operations_alert_outbox SET state = 'pending', locked_at = NULL, last_error = $3,
       run_at = now() + ($2::text || ' seconds')::interval, updated_at = now() WHERE id = $1`,
      [id, Math.max(5, Math.floor(delaySeconds)), category.slice(0, 80)]
    );
  }

  public static requestHash(input: CreateReportInput): string {
    return createHash("sha256").update(JSON.stringify(input)).digest("hex");
  }

  public async migrate(): Promise<void> {
    await this.pool.query(REPORT_SCHEMA_SQL);
  }

  public async recoverInterruptedJobs(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `UPDATE account_report_jobs AS job
         SET state = 'pending', locked_at = NULL, run_at = now(), updated_at = now()
         FROM account_reports AS report
         WHERE job.report_id = report.id AND job.state = 'running'
           AND (
             (job.kind = 'prepare_report' AND job.locked_at < now() - interval '6 minutes')
             OR
             (job.kind IN ('request_code', 'verify_submit') AND job.locked_at < now() - interval '2 minutes')
           )
           AND report.submission_started_at IS NULL`
      );
      await client.query(
        `UPDATE account_report_jobs AS job
         SET state = 'pending', locked_at = NULL, run_at = now(), updated_at = now()
         FROM account_reports AS report
         WHERE job.report_id = report.id AND job.state = 'running'
           AND job.kind = 'submit_review'
           AND job.locked_at < now() - interval '2 minutes'
           AND report.review_submission_started_at IS NULL`
      );
      const ambiguous = await client.query<{
        id: string;
        account_id: string;
        lifecycle_attempt: number;
      }>(
        `UPDATE account_reports AS report
         SET status = 'failed', failure_stage = 'submitting',
             error_code = 'ambiguous_submission_state',
             error_message = 'Discord submission may have started before the worker restarted.',
             updated_at = now()
         FROM account_report_jobs AS job
         WHERE job.report_id = report.id AND job.state = 'running'
           AND job.kind = 'verify_submit' AND report.submission_started_at IS NOT NULL
           AND job.locked_at < now() - interval '2 minutes'
           AND report.status <> 'submitted'
         RETURNING report.id, report.account_id, report.lifecycle_attempt`
      );
      for (const row of ambiguous.rows) {
        await client.query(
          `UPDATE account_report_jobs SET state = 'failed', locked_at = NULL,
             last_error = 'ambiguous_submission_state', updated_at = now()
           WHERE report_id = $1 AND kind = 'verify_submit' AND state = 'running'`,
          [row.id]
        );
        await insertEvent(client, row.account_id, row.id, "report_failed", row.lifecycle_attempt, {
          errorCode: "ambiguous_submission_state"
        });
      }
      const ambiguousReviews = await client.query<{
        id: string;
        account_id: string;
        lifecycle_attempt: number;
      }>(
        `UPDATE account_reports AS report
         SET review_status = 'request_ambiguous', review_status_updated_at = now(),
             review_confirmation_deadline = NULL,
             review_error_code = 'review_request_ambiguous',
             review_error_message = 'The appeal outcome is uncertain after a worker restart.',
             updated_at = now()
         FROM account_report_jobs AS job
         WHERE job.report_id = report.id AND job.state = 'running'
           AND job.kind = 'submit_review' AND report.review_status = 'queued'
           AND job.locked_at < now() - interval '2 minutes'
           AND report.review_submission_started_at IS NOT NULL
         RETURNING report.id, report.account_id, report.lifecycle_attempt`
      );
      for (const row of ambiguousReviews.rows) {
        await client.query(
          `UPDATE account_report_jobs SET state = 'failed', locked_at = NULL,
             last_error = 'review_request_ambiguous', updated_at = now()
           WHERE report_id = $1 AND kind = 'submit_review' AND state = 'running'`,
          [row.id]
        );
        await insertEvent(client, row.account_id, row.id, "review_request_ambiguous", row.lifecycle_attempt, {
          errorCode: "review_request_ambiguous"
        });
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      (client).release();
    }
  }

  public async expireDeadlines(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const verification = await client.query<{
        id: string; account_id: string; credit_chain_id: string;
        credit_state: "reserved" | "consumed"; lifecycle_attempt: number;
      }>(
        `SELECT report.id, report.account_id, report.credit_chain_id,
                chain.state AS credit_state, report.lifecycle_attempt
         FROM account_reports AS report
         JOIN report_credit_chains AS chain ON chain.id = report.credit_chain_id
         WHERE report.verification_deadline <= now()
           AND report.status IN ('requesting_verification', 'awaiting_verification', 'verification_received')
           AND report.submission_started_at IS NULL
           AND chain.state IN ('reserved', 'consumed')
         FOR UPDATE OF report, chain`
      );
      for (const report of verification.rows) {
        if (report.credit_state === "reserved") {
          await releaseCredit(client, report.account_id, report.credit_chain_id, "Verification email timed out");
        }
        await client.query(
          `UPDATE account_reports SET status = 'failed', failure_stage = status,
             error_code = 'verification_timeout', error_message = 'Discord verification email timed out.',
             verification_deadline = NULL, updated_at = now() WHERE id = $1`,
          [report.id]
        );
        await client.query(
          `UPDATE account_report_jobs SET state = 'failed', locked_at = NULL,
             last_error = 'verification_timeout', updated_at = now()
           WHERE report_id = $1 AND state IN ('pending', 'running')`,
          [report.id]
        );
        await insertEvent(client, report.account_id, report.id, "report_failed", report.lifecycle_attempt, { errorCode: "verification_timeout" });
      }
      const receipts = await client.query<{ id: string; account_id: string; lifecycle_attempt: number }>(
        `UPDATE account_reports SET status = 'failed', failure_stage = 'submitted',
           error_code = 'discord_receipt_timeout',
           error_message = 'Discord did not send a report receipt before the deadline.',
           receipt_deadline = NULL, updated_at = now()
         WHERE status = 'submitted' AND discord_status IS NULL AND receipt_deadline <= now()
         RETURNING id, account_id, lifecycle_attempt`
      );
      for (const report of receipts.rows) {
        await insertEvent(client, report.account_id, report.id, "report_receipt_timeout", report.lifecycle_attempt, { errorCode: "discord_receipt_timeout" });
      }
      const reviews = await client.query<{ id: string; account_id: string; lifecycle_attempt: number }>(
        `UPDATE account_reports SET review_status = 'confirmation_timeout',
           review_status_updated_at = now(), review_confirmation_deadline = NULL,
           review_error_code = 'review_confirmation_timeout',
           review_error_message = 'Discord did not confirm the automatic appeal before the deadline.',
           updated_at = now()
         WHERE review_status = 'requested' AND review_confirmation_deadline <= now()
         RETURNING id, account_id, lifecycle_attempt`
      );
      for (const report of reviews.rows) {
        await insertEvent(client, report.account_id, report.id, "review_confirmation_timeout", report.lifecycle_attempt, { errorCode: "review_confirmation_timeout" });
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      (client).release();
    }
  }

  public async create(
    accountId: string,
    idempotencyKey: string,
    input: CreateReportInput
  ): Promise<{ created: boolean; report: AccountReportRow }> {
    const requestHash = ReportRepository.requestHash(input);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const account = await client.query<{ status: "active" | "suspended"; available_credits: number }>(
        `SELECT status, available_credits FROM api_accounts
         WHERE id = $1 FOR UPDATE`,
        [accountId]
      );
      const accountRow = account.rows[0];
      if (accountRow === undefined) {
        throw new ReportMutationError("account_not_found", "Account was not found.");
      }
      if (accountRow.status === "suspended") {
        throw new ReportMutationError("account_suspended", "Account is suspended.");
      }

      const existing = await client.query<AccountReportRow>(
        `SELECT report.*, chain.state AS credit_state FROM account_reports AS report
         JOIN report_credit_chains AS chain ON chain.id = report.credit_chain_id
         WHERE report.account_id = $1 AND report.idempotency_key = $2`,
        [accountId, idempotencyKey]
      );
      const existingRow = existing.rows[0];
      if (existingRow !== undefined) {
        if (existingRow.request_hash !== requestHash) {
          throw new ReportMutationError(
            "idempotency_conflict",
            "Idempotency key was already used for a different request."
          );
        }
        await client.query("COMMIT");
        return { created: false, report: existingRow };
      }
      await consumeRateLimit(client, accountId, "report_mutation", "minute", 60);
      if (input.useAi) await consumeRateLimit(client, accountId, "ai_preparation", "hour", 20);
      if (accountRow.available_credits < 1) {
        throw new ReportMutationError("credits_exhausted", "No report credits are available.");
      }

      const reportId = randomUUID();
      const traceId = randomUUID();
      const chainId = randomUUID();
      await client.query(
        `UPDATE api_accounts
         SET available_credits = available_credits - 1,
             reserved_credits = reserved_credits + 1,
             updated_at = now()
         WHERE id = $1`,
        [accountId]
      );
      await client.query(
        `INSERT INTO report_credit_chains (id, account_id, state, original_report_id)
         VALUES ($1, $2, 'reserved', NULL)`,
        [chainId, accountId]
      );
      const inserted = await client.query<AccountReportRow>(
        `INSERT INTO account_reports
           (id, trace_id, account_id, idempotency_key, request_hash, flow, use_ai,
            request_input, credit_chain_id, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'queued')
         RETURNING *`,
        [reportId, traceId, accountId, idempotencyKey, requestHash, input.flow, input.useAi, input, chainId]
      );
      await client.query(
        "UPDATE report_credit_chains SET original_report_id = $2 WHERE id = $1",
        [chainId, reportId]
      );
      await client.query(
        `INSERT INTO credit_ledger
           (account_id, credit_chain_id, kind, available_delta, reserved_delta, reason)
         VALUES ($1, $2, 'reservation', -1, 1, 'Report creation')`,
        [accountId, chainId]
      );
      await client.query(
        `INSERT INTO account_report_jobs (report_id, kind, dedupe_key, max_attempts)
         VALUES ($1, 'prepare_report', $2, 3)`,
        [reportId, `prepare:${reportId}`]
      );
      const event = await client.query<{ id: string }>(
        `INSERT INTO account_report_events
           (account_id, report_id, event_type, lifecycle_attempt)
         VALUES ($1, $2, 'report_queued', 1)
         RETURNING id`,
        [accountId, reportId]
      );
      await enqueueDestinationDelivery(client, accountId, event.rows[0]?.id);
      await client.query("COMMIT");
      const report = inserted.rows[0];
      if (report === undefined) throw new Error("Report insert did not return a row.");
      return { created: true, report: Object.assign(report, { credit_state: "reserved" }) };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      (client).release();
    }
  }

  public async findOwned(accountId: string, reportId: string): Promise<AccountReportRow | null> {
    const result = await this.pool.query<AccountReportRow>(
      `SELECT report.*, chain.state AS credit_state
       FROM account_reports AS report
       JOIN report_credit_chains AS chain ON chain.id = report.credit_chain_id
       WHERE report.account_id = $1 AND report.id = $2`,
      [accountId, reportId]
    );
    return result.rows[0] ?? null;
  }

  public async listOwned(
    accountId: string,
    after: string | null,
    limit: number
  ): Promise<{ rows: AccountReportRow[]; next: string | null }> {
    const pageSize = Math.max(1, Math.min(100, limit));
    let cursor: { createdAt: string; id: string } | null = null;
    if (after !== null) {
      try {
        const decoded = JSON.parse(Buffer.from(after, "base64url").toString("utf8")) as Record<string, unknown>;
        if (typeof decoded.createdAt !== "string" || typeof decoded.id !== "string" || !Number.isFinite(Date.parse(decoded.createdAt))) {
          throw new Error("Invalid cursor");
        }
        cursor = { createdAt: decoded.createdAt, id: decoded.id };
      } catch {
        throw new ReportMutationError("invalid_cursor", "Report cursor is invalid.");
      }
    }
    const result = cursor === null
      ? await this.pool.query<AccountReportRow>(
          `SELECT report.*, chain.state AS credit_state
           FROM account_reports AS report
           JOIN report_credit_chains AS chain ON chain.id = report.credit_chain_id
           WHERE report.account_id = $1
           ORDER BY report.created_at DESC, report.id DESC LIMIT $2`,
          [accountId, pageSize + 1]
        )
      : await this.pool.query<AccountReportRow>(
          `SELECT report.*, chain.state AS credit_state
           FROM account_reports AS report
           JOIN report_credit_chains AS chain ON chain.id = report.credit_chain_id
           WHERE report.account_id = $1 AND (report.created_at, report.id) < ($2::timestamptz, $3::uuid)
           ORDER BY report.created_at DESC, report.id DESC LIMIT $4`,
          [accountId, cursor.createdAt, cursor.id, pageSize + 1]
        );
    const hasMore = result.rows.length > pageSize;
    const rows = result.rows.slice(0, pageSize);
    const last = rows.at(-1);
    return {
      rows,
      next: hasMore && last !== undefined
        ? Buffer.from(JSON.stringify({ createdAt: last.created_at.toISOString(), id: last.id })).toString("base64url")
        : null
    };
  }

  public async operationalDiagnostics(): Promise<Record<string, unknown>> {
    const result = await this.pool.query<{
      reports: string; pending_jobs: string; running_jobs: string;
      pending_deliveries: string; expired_deliveries: string;
    }>(
      `SELECT
         (SELECT count(*) FROM account_reports)::text AS reports,
         (SELECT count(*) FROM account_report_jobs WHERE state = 'pending')::text AS pending_jobs,
         (SELECT count(*) FROM account_report_jobs WHERE state = 'running')::text AS running_jobs,
         (SELECT count(*) FROM event_destination_deliveries WHERE state = 'pending')::text AS pending_deliveries,
         (SELECT count(*) FROM event_destination_deliveries WHERE state = 'expired')::text AS expired_deliveries`
    );
    const row = result.rows[0];
    const [snapshot, workers, alerts] = await Promise.all([
      this.queueSnapshot(), this.operationalWorkerHealth(), this.pool.query<{ alert_key: string; severity: string }>(
        "SELECT alert_key, severity FROM operational_alert_state WHERE state = 'open' ORDER BY alert_key"
      )
    ]);
    return {
      reports: Number(row?.reports ?? 0),
      pendingJobs: Number(row?.pending_jobs ?? 0),
      runningJobs: Number(row?.running_jobs ?? 0),
      pendingDeliveries: Number(row?.pending_deliveries ?? 0),
      expiredDeliveries: Number(row?.expired_deliveries ?? 0),
      queues: snapshot,
      workers,
      openAlerts: alerts.rows.map((alert) => ({ key: alert.alert_key, severity: alert.severity }))
    };
  }

  public async timeline(accountId: string, reportId: string): Promise<ReportTimelineEvent[]> {
    const result = await this.pool.query<{
      id: string;
      event_type: string;
      lifecycle_attempt: number;
      metadata: Record<string, unknown>;
      created_at: Date;
    }>(
      `SELECT event.id, event.event_type, event.lifecycle_attempt, event.metadata, event.created_at
       FROM account_report_events AS event
       JOIN account_reports AS report ON report.id = event.report_id
       WHERE event.account_id = $1 AND event.report_id = $2 AND report.account_id = $1
       ORDER BY event.id`,
      [accountId, reportId]
    );
    return result.rows.map((row) => ({
      eventId: String(row.id),
      type: row.event_type,
      occurredAt: row.created_at.toISOString(),
      lifecycleAttempt: row.lifecycle_attempt,
      discordStatus: row.event_type.startsWith("discord:")
        ? row.event_type.slice("discord:".length) as ReportTimelineEvent["discordStatus"]
        : typeof row.metadata.discordStatus === "string"
          ? row.metadata.discordStatus as ReportTimelineEvent["discordStatus"]
          : null,
      errorCode: typeof row.metadata.errorCode === "string" ? row.metadata.errorCode : null
    }));
  }

  public async listEvents(
    accountId: string,
    after: string | null,
    limit: number
  ): Promise<CursorPage<ReportLifecycleEvent>> {
    const pageSize = Math.max(1, Math.min(100, limit));
    const result = await this.pool.query<{
      id: string;
      account_id: string;
      report_id: string;
      trace_id: string;
      event_type: string;
      lifecycle_attempt: number;
      created_at: Date;
    }>(
      `SELECT event.id, event.account_id, event.report_id, report.trace_id,
              event.event_type, event.lifecycle_attempt, event.created_at
       FROM account_report_events AS event
       JOIN account_reports AS report ON report.id = event.report_id
       WHERE event.account_id = $1 AND event.id > $2
       ORDER BY event.id LIMIT $3`,
      [accountId, after ?? "0", pageSize + 1]
    );
    const hasMore = result.rows.length > pageSize;
    const rows = result.rows.slice(0, pageSize);
    return {
      items: rows.map((row) => ({
        eventId: String(row.id),
        accountId: row.account_id,
        reportId: row.report_id,
        traceId: row.trace_id,
        type: row.event_type,
        occurredAt: row.created_at.toISOString(),
        lifecycleAttempt: row.lifecycle_attempt
      })),
      next: hasMore ? String(rows.at(-1)?.id ?? after ?? "0") : null
    };
  }

  public async retry(
    accountId: string,
    predecessorReportId: string,
    idempotencyKey: string,
    input: RetryReportInput,
    now = new Date()
  ): Promise<{ created: boolean; report: AccountReportRow }> {
    const mode = input.mode;
    const requestHash = createHash("sha256")
      .update(JSON.stringify({ predecessorReportId, input }))
      .digest("hex");
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const account = await client.query<{ status: "active" | "suspended"; available_credits: number }>(
        "SELECT status, available_credits FROM api_accounts WHERE id = $1 FOR UPDATE",
        [accountId]
      );
      const accountRow = account.rows[0];
      if (accountRow === undefined) throw new ReportMutationError("account_not_found", "Account was not found.");
      if (accountRow.status !== "active") throw new ReportMutationError("account_suspended", "Account is suspended.");

      const existing = await client.query<AccountReportRow>(
        `SELECT report.*, chain.state AS credit_state FROM account_reports AS report
         JOIN report_credit_chains AS chain ON chain.id = report.credit_chain_id
         WHERE report.account_id = $1 AND report.idempotency_key = $2`,
        [accountId, idempotencyKey]
      );
      const existingRow = existing.rows[0];
      if (existingRow !== undefined) {
        if (existingRow.request_hash !== requestHash) {
          throw new ReportMutationError("idempotency_conflict", "Idempotency key was already used for a different request.");
        }
        await client.query("COMMIT");
        return { created: false, report: existingRow };
      }
      await consumeRateLimit(client, accountId, "report_mutation", "minute", 60);

      const predecessorResult = await client.query<AccountReportRow & {
        credit_state: "available" | "reserved" | "consumed" | "released";
        discord_status: string | null;
        error_code: string | null;
        successor_report_id: string | null;
        legal_reference: string | null;
        research_summary: string | null;
        research_sources: unknown[];
        lifecycle_attempt: number;
        retry_sequence: number;
      }>(
        `SELECT predecessor.*, chain.state AS credit_state
         FROM account_reports AS predecessor
         JOIN report_credit_chains AS chain ON chain.id = predecessor.credit_chain_id
         WHERE predecessor.account_id = $1 AND predecessor.id = $2
         FOR UPDATE OF predecessor, chain`,
        [accountId, predecessorReportId]
      );
      const predecessor = predecessorResult.rows[0];
      if (predecessor === undefined) throw new ReportMutationError("report_not_found", "Report was not found.");
      if (predecessor.successor_report_id !== null) {
        throw new ReportMutationError("invalid_retry", "This report already has a successor.");
      }
      if (now.getTime() - predecessor.updated_at.getTime() < 30_000) {
        throw new ReportMutationError("retry_cooldown", "Wait 30 seconds before retrying this report.");
      }
      if (!reportRetryableModes(predecessor).includes(mode)) {
        throw new ReportMutationError("invalid_retry", "The requested retry mode is not available.");
      }
      if (mode === "regenerate" || mode === "rewrite_ai") await consumeRateLimit(client, accountId, "ai_preparation", "hour", 20);

      if (predecessor.credit_state === "released") {
        if (accountRow.available_credits < 1) {
          throw new ReportMutationError("credits_exhausted", "No report credits are available.");
        }
        await client.query(
          `UPDATE api_accounts SET available_credits = available_credits - 1,
             reserved_credits = reserved_credits + 1, updated_at = now() WHERE id = $1`,
          [accountId]
        );
        await client.query(
          "UPDATE report_credit_chains SET state = 'reserved', updated_at = now() WHERE id = $1 AND state = 'released'",
          [predecessor.credit_chain_id]
        );
        await client.query(
          `INSERT INTO credit_ledger
             (account_id, credit_chain_id, kind, available_delta, reserved_delta, reason)
           VALUES ($1, $2, 'reservation', -1, 1, 'Retry chain re-reservation')`,
          [accountId, predecessor.credit_chain_id]
        );
      } else if (predecessor.credit_state === "consumed") {
        await client.query(
          `INSERT INTO credit_ledger
             (account_id, credit_chain_id, kind, available_delta, reserved_delta, reason)
           VALUES ($1, $2, 'retry_chain_reuse', 0, 0, 'Consumed retry entitlement reused')`,
          [accountId, predecessor.credit_chain_id]
        );
      } else {
        throw new ReportMutationError("invalid_retry", "The report credit chain is not retryable.");
      }

      const reportId = randomUUID();
      const traceId = randomUUID();
      const successorInput = replacementRequest(predecessor, input);
      const inserted = await client.query<AccountReportRow>(
        `INSERT INTO account_reports
           (id, trace_id, account_id, idempotency_key, request_hash, flow, use_ai, request_input,
            prepared_input, legal_reference, research_summary, research_sources,
            credit_chain_id, predecessor_report_id, retry_mode, retry_sequence,
            lifecycle_attempt, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
                 $13, $14, $15, $16, $17, 'queued')
         RETURNING *`,
        [
          reportId, traceId, accountId, idempotencyKey, requestHash, predecessor.flow,
          successorInput.useAi, successorInput,
          mode === "reuse" ? predecessor.prepared_input : null,
          mode === "reuse" ? predecessor.legal_reference : null,
          mode === "reuse" ? predecessor.research_summary : null,
          mode === "reuse" ? JSON.stringify(predecessor.research_sources) : "[]",
          predecessor.credit_chain_id, predecessor.id, mode,
          (predecessor.retry_sequence ?? 0) + 1,
          (predecessor.lifecycle_attempt ?? 1) + 1
        ]
      );
      await client.query(
        "UPDATE account_reports SET successor_report_id = $2, updated_at = now() WHERE id = $1",
        [predecessor.id, reportId]
      );
      await client.query(
        `INSERT INTO account_report_jobs (report_id, kind, dedupe_key, max_attempts)
         VALUES ($1, 'prepare_report', $2, 3)`,
        [reportId, `prepare:${reportId}`]
      );
      await insertEvent(client, accountId, reportId, "report_queued", (predecessor.lifecycle_attempt ?? 1) + 1, {
        retryMode: mode,
        predecessorReportId: predecessor.id
      });
      await client.query("COMMIT");
      const report = inserted.rows[0];
      if (report === undefined) throw new Error("Retry report insert did not return a row.");
      return {
        created: true,
        report: Object.assign(report, {
          credit_state: predecessor.credit_state === "released" ? "reserved" : "consumed"
        })
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      (client).release();
    }
  }

  public async claimPreparation(): Promise<{ jobId: string; report: AccountReportRow } | null> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const job = await client.query<{ id: string; report_id: string }>(
        `WITH candidate AS (
           SELECT id FROM account_report_jobs
           WHERE kind = 'prepare_report' AND state = 'pending' AND run_at <= now()
           ORDER BY run_at, id FOR UPDATE SKIP LOCKED LIMIT 1
         )
         UPDATE account_report_jobs AS job
         SET state = 'running', attempts = attempts + 1, locked_at = now(), updated_at = now()
         FROM candidate WHERE job.id = candidate.id
         RETURNING job.id, job.report_id`
      );
      const claimed = job.rows[0];
      if (claimed === undefined) {
        await client.query("COMMIT");
        return null;
      }
      const report = await client.query<AccountReportRow>(
        "SELECT * FROM account_reports WHERE id = $1",
        [claimed.report_id]
      );
      await client.query("COMMIT");
      const row = report.rows[0];
      if (row === undefined) throw new Error("Claimed preparation report was not found.");
      return { jobId: claimed.id, report: row };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      (client).release();
    }
  }

  public async transition(reportId: string, status: ReportStatus): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const updated = await client.query<{ account_id: string; lifecycle_attempt: number }>(
        `UPDATE account_reports AS report SET status = $2, updated_at = now()
         WHERE report.id = $1
           AND report.status NOT IN ('failed', 'submitting', 'submitted')
           AND EXISTS (
             SELECT 1 FROM api_accounts AS account
             WHERE account.id = report.account_id AND account.status = 'active'
           )
         RETURNING account_id, lifecycle_attempt`,
        [reportId, status]
      );
      const row = updated.rows[0];
      if (row !== undefined) await insertEvent(client, row.account_id, reportId, `report_${status}`, row.lifecycle_attempt);
      await client.query("COMMIT");
      return row !== undefined;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      (client).release();
    }
  }

  public async completePreparation(
    jobId: string,
    reportId: string,
    prepared: {
      country: string;
      category: string;
      description: string;
      finalText: string;
      legalReference: string | null;
      researchSummary: string | null;
      sources: unknown[];
    },
    identity: {
      legalName: string;
      email: string;
      locale: string;
      timezone: string;
      language: string;
      proxySessionId: string;
    },
    _usage: { aiRequests: number; inputTokens: number; outputTokens: number; searchRequests: number }
  ): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const recorded = await client.query<{
        account_id: string;
        preparation_ai_requests: string;
        preparation_input_tokens: string;
        preparation_output_tokens: string;
        preparation_search_requests: string;
      }>(
        `SELECT account_id, preparation_ai_requests, preparation_input_tokens,
                preparation_output_tokens, preparation_search_requests
         FROM account_reports WHERE id = $1 FOR UPDATE`,
        [reportId]
      );
      const current = recorded.rows[0];
      if (current === undefined) throw new Error("Report is not eligible for preparation completion.");
      const usageDelta = {
        aiRequests: Math.max(0, _usage.aiRequests - Number(current.preparation_ai_requests)),
        inputTokens: Math.max(0, _usage.inputTokens - Number(current.preparation_input_tokens)),
        outputTokens: Math.max(0, _usage.outputTokens - Number(current.preparation_output_tokens)),
        searchRequests: Math.max(0, _usage.searchRequests - Number(current.preparation_search_requests))
      };
      await client.query(
        `UPDATE api_accounts SET ai_requests = ai_requests + $2,
           input_tokens = input_tokens + $3, output_tokens = output_tokens + $4,
           search_requests = search_requests + $5, updated_at = now() WHERE id = $1`,
        [current.account_id, usageDelta.aiRequests, usageDelta.inputTokens, usageDelta.outputTokens, usageDelta.searchRequests]
      );
      const updated = await client.query<{ account_id: string; lifecycle_attempt: number }>(
        `UPDATE account_reports
         SET prepared_input = $2, legal_reference = $3, research_summary = $4,
             research_sources = $5, reporter_legal_name = $6, reporter_email = $7,
             locale = $8, timezone = $9, language = $10, proxy_session_id = $11,
             preparation_ai_requests = $12, preparation_input_tokens = $13,
             preparation_output_tokens = $14, preparation_search_requests = $15,
             status = 'requesting_verification', updated_at = now()
         WHERE id = $1 AND status IN ('queued', 'planning', 'researching', 'writing')
         RETURNING account_id, lifecycle_attempt`,
        [
          reportId,
          { country: prepared.country, category: prepared.category, description: prepared.description, finalText: prepared.finalText },
          prepared.legalReference,
          prepared.researchSummary,
          JSON.stringify(prepared.sources),
          identity.legalName,
          identity.email,
          identity.locale,
          identity.timezone,
          identity.language,
          identity.proxySessionId,
          _usage.aiRequests,
          _usage.inputTokens,
          _usage.outputTokens,
          _usage.searchRequests
        ]
      );
      const row = updated.rows[0];
      if (row === undefined) throw new Error("Report is not eligible for preparation completion.");
      await client.query(
        "UPDATE account_report_jobs SET state = 'completed', locked_at = NULL, updated_at = now() WHERE id = $1 AND report_id = $2",
        [jobId, reportId]
      );
      await client.query(
        `INSERT INTO account_report_jobs (report_id, kind, dedupe_key, max_attempts)
         VALUES ($1, 'request_code', $2, 3) ON CONFLICT (dedupe_key) DO NOTHING`,
        [reportId, `request-code:${reportId}:1`]
      );
      await insertEvent(client, row.account_id, reportId, "report_prepared", row.lifecycle_attempt);
      await insertEvent(client, row.account_id, reportId, "verification_queued", row.lifecycle_attempt);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      (client).release();
    }
  }

  public async failPreparation(jobId: string, reportId: string, code: string, message: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const locked = await lockReportCredit(client, reportId);
      if (locked !== undefined && locked.credit_state === "reserved") {
        await releaseCredit(client, locked.account_id, locked.credit_chain_id, "Preparation failed");
      }
      if (locked !== undefined) {
        const failed = await client.query(
          `UPDATE account_reports
           SET status = 'failed', failure_stage = status, error_code = $2,
               error_message = $3, updated_at = now()
           WHERE id = $1 AND submission_started_at IS NULL AND status <> 'failed'
           RETURNING id`,
          [reportId, code, message]
        );
        await client.query(
          "UPDATE account_report_jobs SET state = 'failed', locked_at = NULL, last_error = $2, updated_at = now() WHERE id = $1",
          [jobId, code]
        );
        if (failed.rowCount === 1) {
          await insertEvent(client, locked.account_id, reportId, "report_failed", locked.lifecycle_attempt, { errorCode: code });
        }
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      (client).release();
    }
  }

  public async recordPreparationUsage(
    reportId: string,
    usage: { aiRequests: number; inputTokens: number; outputTokens: number; searchRequests: number }
  ): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const report = await client.query<{ account_id: string }>(
        `UPDATE account_reports SET
           preparation_ai_requests = preparation_ai_requests + $2,
           preparation_input_tokens = preparation_input_tokens + $3,
           preparation_output_tokens = preparation_output_tokens + $4,
           preparation_search_requests = preparation_search_requests + $5,
           updated_at = now()
         WHERE id = $1 RETURNING account_id`,
        [reportId, usage.aiRequests, usage.inputTokens, usage.outputTokens, usage.searchRequests]
      );
      const row = report.rows[0];
      if (row === undefined) throw new Error("Preparation usage report was not found.");
      await client.query(
        `UPDATE api_accounts SET ai_requests = ai_requests + $2,
           input_tokens = input_tokens + $3, output_tokens = output_tokens + $4,
           search_requests = search_requests + $5, updated_at = now() WHERE id = $1`,
        [row.account_id, usage.aiRequests, usage.inputTokens, usage.outputTokens, usage.searchRequests]
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  public async beginSubmission(job: LifecycleJob): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      if (!(await ownsLifecycleJob(client, job))) {
        await client.query("COMMIT");
        return false;
      }
      const locked = await lockReportCredit(client, job.report_id);
      if (
        locked === undefined ||
        locked.status !== "verifying" ||
        (locked.credit_state !== "reserved" && locked.credit_state !== "consumed")
      ) {
        await client.query("COMMIT");
        return false;
      }
      if (locked.account_status !== "active") {
        if (locked.credit_state === "reserved") {
          await releaseCredit(client, locked.account_id, locked.credit_chain_id, "Account suspended before submission");
        }
        await client.query(
          `UPDATE account_reports SET status = 'failed', failure_stage = 'verifying',
             error_code = 'account_suspended', error_message = 'Account was suspended before submission.',
             updated_at = now() WHERE id = $1`,
          [job.report_id]
        );
        await insertEvent(client, locked.account_id, job.report_id, "report_failed", locked.lifecycle_attempt, { errorCode: "account_suspended" });
        await client.query("COMMIT");
        return false;
      }
      if (locked.credit_state === "reserved") {
        const consumedBalance = await client.query(
          `UPDATE api_accounts SET reserved_credits = reserved_credits - 1, updated_at = now()
           WHERE id = $1 AND reserved_credits > 0 RETURNING id`,
          [locked.account_id]
        );
        const consumedChain = await client.query(
          "UPDATE report_credit_chains SET state = 'consumed', updated_at = now() WHERE id = $1 AND state = 'reserved' RETURNING id",
          [locked.credit_chain_id]
        );
        if (consumedBalance.rowCount !== 1 || consumedChain.rowCount !== 1) {
          throw new Error("Reserved report credit could not be consumed atomically.");
        }
        await client.query(
          `INSERT INTO credit_ledger
             (account_id, credit_chain_id, kind, available_delta, reserved_delta, reason)
           VALUES ($1, $2, 'consumption', 0, -1, 'Discord submission started')`,
          [locked.account_id, locked.credit_chain_id]
        );
      }
      await client.query(
        `UPDATE account_reports SET status = 'submitting', submission_started_at = now(), updated_at = now()
         WHERE id = $1`,
        [job.report_id]
      );
      await insertEvent(client, locked.account_id, job.report_id, "submission_started", locked.lifecycle_attempt);
      await client.query("COMMIT");
      return true;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      (client).release();
    }
  }

  public async claimLifecycleJob(): Promise<LifecycleJob | null> {
    const result = await this.pool.query<LifecycleJob & QueryResultRow>(
      `WITH candidate AS (
         SELECT id FROM account_report_jobs
         WHERE kind <> 'prepare_report' AND state = 'pending' AND run_at <= now()
         ORDER BY run_at, id FOR UPDATE SKIP LOCKED LIMIT 1
       )
       UPDATE account_report_jobs AS job
       SET state = 'running', attempts = attempts + 1, locked_at = now(), updated_at = now()
       FROM candidate WHERE job.id = candidate.id
       RETURNING job.id, job.report_id, job.kind, job.payload, job.attempts,
                 job.max_attempts, job.attempts AS execution_token,
                 (SELECT trace_id FROM account_reports WHERE id = job.report_id) AS trace_id`
    );
    return result.rows[0] ?? null;
  }

  public async heartbeatLifecycleJob(job: LifecycleJob): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE account_report_jobs
       SET locked_at = now(), updated_at = now()
       WHERE id = $1 AND attempts = $2 AND state = 'running'
       RETURNING id`,
      [job.id, job.execution_token]
    );
    return result.rowCount === 1;
  }

  public async getLifecycleReport(reportId: string): Promise<LifecycleReport | null> {
    const result = await this.pool.query<LifecycleReport & QueryResultRow>(
      `SELECT id, trace_id, flow, prepared_input->>'country' AS country,
              reporter_email, reporter_legal_name, timezone, locale, language,
              proxy_session_id, session_state, request_input, prepared_input, discord_report_id
       FROM account_reports WHERE id = $1`,
      [reportId]
    );
    return result.rows[0] ?? null;
  }

  public async setStatus(
    job: LifecycleJob,
    status: "requesting_verification" | "verifying"
  ): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      if (!(await ownsLifecycleJob(client, job))) {
        await client.query("COMMIT");
        return false;
      }
      const updated = await client.query<{ account_id: string; lifecycle_attempt: number }>(
        `UPDATE account_reports AS report SET status = $2, updated_at = now()
         WHERE report.id = $1
           AND report.status NOT IN ('failed', 'submitting', 'submitted')
           AND EXISTS (
             SELECT 1 FROM api_accounts AS account
             WHERE account.id = report.account_id AND account.status = 'active'
           )
         RETURNING account_id, lifecycle_attempt`,
        [job.report_id, status]
      );
      const row = updated.rows[0];
      if (row !== undefined) {
        await insertEvent(client, row.account_id, job.report_id, `report_${status}`, row.lifecycle_attempt);
      }
      await client.query("COMMIT");
      return row !== undefined;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  public async saveAwaitingVerification(
    job: LifecycleJob,
    encryptedSession: string
  ): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      if (!(await ownsLifecycleJob(client, job))) {
        await client.query("COMMIT");
        return false;
      }
      const updated = await client.query<{
        account_id: string; lifecycle_attempt: number; status: ReportStatus;
      }>(
        `UPDATE account_reports
         SET session_state = $2,
             status = CASE WHEN status = 'verification_received'
               THEN 'verification_received' ELSE 'awaiting_verification' END,
             verification_deadline = CASE WHEN status = 'verification_received'
               THEN NULL ELSE now() + interval '60 seconds' END,
             updated_at = now()
         WHERE id = $1 AND status IN ('requesting_verification', 'verification_received')
           AND EXISTS (
             SELECT 1 FROM api_accounts AS account
             WHERE account.id = account_reports.account_id AND account.status = 'active'
           )
         RETURNING account_id, lifecycle_attempt, status`,
        [job.report_id, encryptedSession]
      );
      const row = updated.rows[0];
      if (row !== undefined) {
        await client.query(
          `UPDATE account_report_jobs SET state = 'completed', locked_at = NULL, updated_at = now()
           WHERE id = $1 AND report_id = $2 AND attempts = $3 AND state = 'running'`,
          [job.id, job.report_id, job.execution_token]
        );
        if (row.status === "awaiting_verification") {
          await insertEvent(client, row.account_id, job.report_id, "awaiting_verification", row.lifecycle_attempt);
        }
      }
      await client.query("COMMIT");
      return row !== undefined;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      (client).release();
    }
  }

  public async completeLifecycleJob(job: LifecycleJob): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE account_report_jobs
       SET state = 'completed', locked_at = NULL, updated_at = now()
       WHERE id = $1 AND attempts = $2 AND state = 'running'
       RETURNING id`,
      [job.id, job.execution_token]
    );
    return result.rowCount === 1;
  }

  public async retryLifecycleJob(job: LifecycleJob, code: string, delaySeconds: number): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE account_report_jobs
       SET state = 'pending', locked_at = NULL, last_error = $3,
           run_at = now() + ($4 * interval '1 second'), updated_at = now()
       WHERE id = $1 AND attempts = $2 AND state = 'running'
       RETURNING id`,
      [job.id, job.execution_token, code, delaySeconds]
    );
    return result.rowCount === 1;
  }

  public async failBeforeSubmission(
    job: LifecycleJob,
    code: string,
    message: string
  ): Promise<boolean> {
    return this.failLifecycle(job, code, message, true);
  }

  public async failAfterSubmission(
    job: LifecycleJob,
    code: string,
    message: string
  ): Promise<boolean> {
    return this.failLifecycle(job, code, message, false);
  }

  private async failLifecycle(
    job: LifecycleJob,
    code: string,
    message: string,
    releaseReservation: boolean
  ): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      if (!(await ownsLifecycleJob(client, job))) {
        await client.query("COMMIT");
        return false;
      }
      const locked = await lockReportCredit(client, job.report_id);
      if (locked !== undefined && releaseReservation && locked.credit_state === "reserved") {
        await releaseCredit(client, locked.account_id, locked.credit_chain_id, "Lifecycle failed before submission");
      }
      if (locked !== undefined) {
        const failed = await client.query(
          `UPDATE account_reports
           SET status = 'failed', failure_stage = status, error_code = $2,
               error_message = $3, updated_at = now()
           WHERE id = $1 AND status <> 'failed'
             AND ($4::boolean = false OR submission_started_at IS NULL)
           RETURNING id`,
          [job.report_id, code, message, releaseReservation]
        );
        await client.query(
          `UPDATE account_report_jobs SET state = 'failed', locked_at = NULL,
             last_error = $4, updated_at = now()
           WHERE id = $1 AND report_id = $2 AND attempts = $3 AND state = 'running'`,
          [job.id, job.report_id, job.execution_token, code]
        );
        if (failed.rowCount === 1) {
          await insertEvent(client, locked.account_id, job.report_id, "report_failed", locked.lifecycle_attempt, { errorCode: code });
        }
      }
      await client.query("COMMIT");
      return true;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      (client).release();
    }
  }

  public async markSubmitted(job: LifecycleJob, discordReportId: string): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      if (!(await ownsLifecycleJob(client, job))) {
        await client.query("COMMIT");
        return false;
      }
      const updated = await client.query<{ account_id: string; lifecycle_attempt: number }>(
        `UPDATE account_reports
         SET status = 'submitted', discord_report_id = $2,
             receipt_deadline = now() + interval '120 seconds', updated_at = now()
         WHERE id = $1 AND status = 'submitting'
         RETURNING account_id, lifecycle_attempt`,
        [job.report_id, discordReportId]
      );
      const row = updated.rows[0];
      if (row === undefined) throw new Error("Submitting report could not be persisted.");
      await client.query(
        `UPDATE account_report_jobs SET state = 'completed', locked_at = NULL, updated_at = now()
         WHERE id = $1 AND report_id = $2 AND attempts = $3 AND state = 'running'`,
        [job.id, job.report_id, job.execution_token]
      );
      await insertEvent(client, row.account_id, job.report_id, "report_submitted", row.lifecycle_attempt);
      const pending = await client.query<{
        message_id: string; external_status: string; encrypted_payload: string | null;
      }>(
        `SELECT message_id, external_status, encrypted_payload
         FROM account_inbound_messages
         WHERE external_report_id = $1 AND status = 'pending_report'
         ORDER BY received_at, message_id FOR UPDATE`,
        [discordReportId]
      );
      let currentStatus: string | null = null;
      for (const inbound of pending.rows) {
        if (shouldApplyDiscordStatus(currentStatus, inbound.external_status)) {
          currentStatus = inbound.external_status;
          await client.query(
            `UPDATE account_reports SET discord_status = $2, discord_status_updated_at = now(),
               receipt_deadline = NULL, updated_at = now() WHERE id = $1`,
            [job.report_id, inbound.external_status]
          );
          await insertEvent(client, row.account_id, job.report_id, `discord:${inbound.external_status}`, row.lifecycle_attempt);
        }
        if (inbound.external_status === "closed_no_action" && inbound.encrypted_payload !== null) {
          await client.query(
            `UPDATE account_reports SET review_status = 'queued', review_status_updated_at = now(),
               updated_at = now() WHERE id = $1 AND review_status IS NULL`,
            [job.report_id]
          );
          await client.query(
            `INSERT INTO account_report_jobs (report_id, kind, dedupe_key, payload, max_attempts)
             VALUES ($1, 'submit_review', $2, $3, 3) ON CONFLICT (dedupe_key) DO NOTHING`,
            [job.report_id, `submit-review:${job.report_id}`, { encryptedReviewUrl: inbound.encrypted_payload }]
          );
          await insertEvent(client, row.account_id, job.report_id, "review_queued", row.lifecycle_attempt);
        }
        await client.query(
          `UPDATE account_inbound_messages SET report_id = $2, status = 'accepted'
           WHERE message_id = $1`,
          [inbound.message_id, job.report_id]
        );
      }
      await client.query("COMMIT");
      return true;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      (client).release();
    }
  }

  public async markReviewRequested(job: LifecycleJob, discordReportId: string): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      if (!(await ownsLifecycleJob(client, job))) {
        await client.query("COMMIT");
        return false;
      }
      const updated = await client.query<{ account_id: string; lifecycle_attempt: number }>(
        `UPDATE account_reports
         SET review_status = 'requested', review_status_updated_at = now(),
             review_confirmation_deadline = now() + interval '2 minutes',
             review_error_code = NULL, review_error_message = NULL, updated_at = now()
         WHERE id = $1 AND discord_report_id = $2 AND review_status = 'queued'
         RETURNING account_id, lifecycle_attempt`,
        [job.report_id, discordReportId]
      );
      const row = updated.rows[0];
      if (row === undefined) throw new Error("Report is no longer waiting for automatic appeal submission.");
      await client.query(
        `UPDATE account_report_jobs SET state = 'completed', locked_at = NULL, updated_at = now()
         WHERE id = $1 AND report_id = $2 AND attempts = $3 AND state = 'running'`,
        [job.id, job.report_id, job.execution_token]
      );
      await insertEvent(client, row.account_id, job.report_id, "review_requested", row.lifecycle_attempt);
      await client.query("COMMIT");
      return true;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      (client).release();
    }
  }

  public async beginReviewSubmission(job: LifecycleJob): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      if (!(await ownsLifecycleJob(client, job))) {
        await client.query("COMMIT");
        return false;
      }
      const updated = await client.query<{ account_id: string; lifecycle_attempt: number }>(
        `UPDATE account_reports SET review_submission_started_at = now(), updated_at = now()
         WHERE id = $1 AND review_status = 'queued' AND review_submission_started_at IS NULL
         RETURNING account_id, lifecycle_attempt`,
        [job.report_id]
      );
      const row = updated.rows[0];
      if (row !== undefined) await insertEvent(client, row.account_id, job.report_id, "review_submission_started", row.lifecycle_attempt);
      await client.query("COMMIT");
      return row !== undefined;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      (client).release();
    }
  }

  public async failReview(
    job: LifecycleJob,
    status: "ineligible" | "request_failed" | "request_ambiguous",
    code: string,
    message: string
  ): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      if (!(await ownsLifecycleJob(client, job))) {
        await client.query("COMMIT");
        return false;
      }
      const updated = await client.query<{ account_id: string; lifecycle_attempt: number }>(
        `UPDATE account_reports
         SET review_status = $2, review_status_updated_at = now(),
             review_confirmation_deadline = NULL, review_error_code = $3,
             review_error_message = $4, updated_at = now()
         WHERE id = $1 AND review_status = 'queued'
         RETURNING account_id, lifecycle_attempt`,
        [job.report_id, status, code, message]
      );
      await client.query(
        `UPDATE account_report_jobs SET state = 'failed', locked_at = NULL,
           last_error = $4, updated_at = now()
         WHERE id = $1 AND report_id = $2 AND attempts = $3 AND state = 'running'`,
        [job.id, job.report_id, job.execution_token, code]
      );
      const row = updated.rows[0];
      if (row !== undefined) await insertEvent(client, row.account_id, job.report_id, `review_${status}`, row.lifecycle_attempt, { errorCode: code });
      await client.query("COMMIT");
      return true;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      (client).release();
    }
  }

  public async claimEventDelivery(): Promise<AccountEventDelivery | null> {
    await this.pool.query(
      `UPDATE event_destination_deliveries SET state = 'expired', locked_at = NULL, updated_at = now()
       WHERE state IN ('pending', 'sending') AND created_at < now() - interval '7 days'`
    );
    const result = await this.pool.query<AccountEventDelivery & QueryResultRow>(
      `WITH candidate AS (
         SELECT delivery.event_id, delivery.destination_id
         FROM event_destination_deliveries AS delivery
         JOIN webhook_destinations AS destination ON destination.id = delivery.destination_id
         WHERE destination.status = 'active'
           AND delivery.run_at <= now()
           AND (delivery.state = 'pending' OR (delivery.state = 'sending' AND delivery.locked_at < now() - interval '2 minutes'))
         ORDER BY delivery.run_at, delivery.event_id
         FOR UPDATE OF delivery SKIP LOCKED LIMIT 1
       ), claimed AS (
         UPDATE event_destination_deliveries AS delivery
         SET state = 'sending', attempts = attempts + 1, locked_at = now(), updated_at = now()
         FROM candidate
         WHERE delivery.event_id = candidate.event_id AND delivery.destination_id = candidate.destination_id
         RETURNING delivery.*
       )
       SELECT claimed.event_id, claimed.destination_id, claimed.attempts, claimed.created_at,
              destination.url AS destination_url, destination.encrypted_signing_secret,
              event.account_id, event.report_id, report.trace_id, event.event_type,
              event.lifecycle_attempt, event.created_at AS occurred_at
       FROM claimed
       JOIN webhook_destinations AS destination ON destination.id = claimed.destination_id
       JOIN account_report_events AS event ON event.id = claimed.event_id
       JOIN account_reports AS report ON report.id = event.report_id`
    );
    return result.rows[0] ?? null;
  }

  public async completeEventDelivery(eventId: string, destinationId: string): Promise<void> {
    await this.pool.query(
      `UPDATE event_destination_deliveries
       SET state = 'sent', locked_at = NULL, last_error = NULL, updated_at = now()
       WHERE event_id = $1 AND destination_id = $2`,
      [eventId, destinationId]
    );
  }

  public async retryEventDelivery(
    eventId: string,
    destinationId: string,
    error: string,
    delayMilliseconds: number
  ): Promise<void> {
    await this.pool.query(
      `UPDATE event_destination_deliveries
       SET state = CASE WHEN created_at < now() - interval '7 days' THEN 'expired' ELSE 'pending' END,
           run_at = now() + ($4 * interval '1 millisecond'), locked_at = NULL,
           last_error = $3, updated_at = now()
       WHERE event_id = $1 AND destination_id = $2`,
      [eventId, destinationId, error.slice(0, 500), Math.max(500, Math.min(3_600_000, delayMilliseconds))]
    );
  }

  public async registerVerificationEmail(input: {
    messageId: string;
    recipient: string;
    encryptedCode: string;
  }): Promise<InboundEmailRegistration> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const reportResult = await client.query<{
        id: string;
        account_id: string;
        lifecycle_attempt: number;
      }>(
        `SELECT id, account_id, lifecycle_attempt FROM account_reports
         WHERE reporter_email = $1
           AND status IN ('requesting_verification', 'awaiting_verification', 'verification_received')
         FOR UPDATE`,
        [input.recipient.toLowerCase()]
      );
      const report = reportResult.rows[0];
      const inserted = await client.query(
        `INSERT INTO account_inbound_messages (message_id, report_id, recipient, status)
         VALUES ($1, $2, $3, $4) ON CONFLICT (message_id) DO NOTHING
         RETURNING message_id`,
        [input.messageId, report?.id ?? null, input.recipient.toLowerCase(), report === undefined ? "unknown_recipient" : "accepted"]
      );
      if (inserted.rowCount === 0) {
        await client.query("COMMIT");
        return { status: "duplicate", reportId: report?.id ?? null };
      }
      if (report === undefined) {
        await client.query("COMMIT");
        return { status: "unknown_recipient", reportId: null };
      }
      await client.query(
        `INSERT INTO account_report_jobs
           (report_id, kind, dedupe_key, payload, max_attempts, run_at)
         VALUES ($1, 'verify_submit', $2, $3, 3, now() + interval '3 seconds')
         ON CONFLICT (dedupe_key) DO UPDATE
         SET payload = EXCLUDED.payload, state = 'pending', run_at = EXCLUDED.run_at,
             locked_at = NULL, last_error = NULL, updated_at = now()
         WHERE account_report_jobs.state = 'pending'`,
        [report.id, `verify-submit:${report.id}:${report.lifecycle_attempt}`, { encryptedCode: input.encryptedCode }]
      );
      await client.query(
        `UPDATE account_reports SET status = 'verification_received',
           verification_deadline = NULL, updated_at = now() WHERE id = $1`,
        [report.id]
      );
      await insertEvent(client, report.account_id, report.id, "verification_received", report.lifecycle_attempt);
      await client.query("COMMIT");
      return { status: "accepted", reportId: report.id };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      (client).release();
    }
  }

  public async registerReportUpdateEmail(input: {
    messageId: string;
    recipient: string;
    discordReportId: string;
    discordStatus: "received" | "actioned" | "closed_no_action" | "review_not_approved";
    encryptedReviewUrl?: string;
  }): Promise<InboundEmailRegistration> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const reportResult = await client.query<AccountReportRow & {
        discord_status: string | null;
        review_status: string | null;
        error_code: string | null;
        lifecycle_attempt: number;
      }>(
        `SELECT * FROM account_reports
         WHERE discord_report_id = $1 AND reporter_email = $2 FOR UPDATE`,
        [input.discordReportId, input.recipient.toLowerCase()]
      );
      const report = reportResult.rows[0];
      const inserted = await client.query(
        `INSERT INTO account_inbound_messages
           (message_id, report_id, recipient, status, external_report_id, external_status, encrypted_payload)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (message_id) DO NOTHING RETURNING message_id`,
        [
          input.messageId, report?.id ?? null, input.recipient.toLowerCase(),
          report === undefined ? "pending_report" : "accepted",
          input.discordReportId, input.discordStatus, input.encryptedReviewUrl ?? null
        ]
      );
      if (inserted.rowCount === 0) {
        await client.query("COMMIT");
        return { status: "duplicate", reportId: report?.id ?? null };
      }
      if (report === undefined) {
        await client.query("COMMIT");
        return { status: "pending_report", reportId: null };
      }

      if (
        input.discordStatus === "closed_no_action" &&
        input.encryptedReviewUrl !== undefined &&
        report.review_status === null
      ) {
        await client.query(
          `UPDATE account_reports SET review_status = 'queued', review_status_updated_at = now(),
             review_error_code = NULL, review_error_message = NULL, updated_at = now()
           WHERE id = $1 AND review_status IS NULL`,
          [report.id]
        );
        await client.query(
          `INSERT INTO account_report_jobs (report_id, kind, dedupe_key, payload, max_attempts)
           VALUES ($1, 'submit_review', $2, $3, 3)
           ON CONFLICT (dedupe_key) DO NOTHING`,
          [report.id, `submit-review:${report.id}`, { encryptedReviewUrl: input.encryptedReviewUrl }]
        );
        await insertEvent(client, report.account_id, report.id, "review_queued", report.lifecycle_attempt);
      }
      if (shouldApplyDiscordStatus(report.discord_status, input.discordStatus)) {
        if (report.error_code === "discord_receipt_timeout") {
          await client.query(
            `UPDATE account_reports SET status = 'submitted', failure_stage = NULL,
               error_code = NULL, error_message = NULL, updated_at = now() WHERE id = $1`,
            [report.id]
          );
          await insertEvent(client, report.account_id, report.id, "report_receipt_recovered", report.lifecycle_attempt);
        }
        await client.query(
          `UPDATE account_reports
           SET discord_status = $2, discord_status_updated_at = now(), receipt_deadline = NULL,
               review_status = CASE
                 WHEN $2 = 'review_not_approved' THEN 'not_approved'
                 WHEN $2 = 'actioned' AND review_status IS NOT NULL THEN 'approved'
                 ELSE review_status END,
               review_status_updated_at = CASE
                 WHEN $2 IN ('actioned', 'review_not_approved') THEN now()
                 ELSE review_status_updated_at END,
               review_confirmation_deadline = CASE
                 WHEN $2 IN ('actioned', 'review_not_approved') THEN NULL
                 ELSE review_confirmation_deadline END,
               updated_at = now()
           WHERE id = $1`,
          [report.id, input.discordStatus]
        );
        await insertEvent(client, report.account_id, report.id, `discord:${input.discordStatus}`, report.lifecycle_attempt);
      }
      await client.query("COMMIT");
      return { status: "accepted", reportId: report.id };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      (client).release();
    }
  }

  public async registerReviewUpdateEmail(input: {
    messageId: string;
    recipient: string;
    discordReportId: string;
  }): Promise<InboundEmailRegistration> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const reportResult = await client.query<AccountReportRow & { review_status: string | null; lifecycle_attempt: number }>(
        `SELECT * FROM account_reports
         WHERE discord_report_id = $1 AND reporter_email = $2 FOR UPDATE`,
        [input.discordReportId, input.recipient.toLowerCase()]
      );
      const report = reportResult.rows[0];
      const inserted = await client.query(
        `INSERT INTO account_inbound_messages
           (message_id, report_id, recipient, status, external_report_id, external_status)
         VALUES ($1, $2, $3, $4, $5, 'review_received')
         ON CONFLICT (message_id) DO NOTHING RETURNING message_id`,
        [input.messageId, report?.id ?? null, input.recipient.toLowerCase(), report === undefined ? "pending_report" : "accepted", input.discordReportId]
      );
      if (inserted.rowCount === 0) {
        await client.query("COMMIT");
        return { status: "duplicate", reportId: report?.id ?? null };
      }
      if (report === undefined) {
        await client.query("COMMIT");
        return { status: "pending_report", reportId: null };
      }
      if (!new Set(["approved", "not_approved", "received"]).has(report.review_status ?? "")) {
        await client.query(
          `UPDATE account_reports SET review_status = 'received', review_status_updated_at = now(),
             review_confirmation_deadline = NULL, review_error_code = NULL,
             review_error_message = NULL, updated_at = now() WHERE id = $1`,
          [report.id]
        );
        await insertEvent(client, report.account_id, report.id, "review_received", report.lifecycle_attempt);
      }
      await client.query("COMMIT");
      return { status: "accepted", reportId: report.id };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      (client).release();
    }
  }
}

interface LockedCreditRow extends QueryResultRow {
  account_id: string;
  credit_chain_id: string;
  credit_state: "available" | "reserved" | "consumed" | "released";
  account_status: "active" | "suspended";
  status: ReportStatus;
  lifecycle_attempt: number;
}

export interface QueuePhaseSnapshot {
  readyPending: number;
  delayedPending: number;
  running: number;
  oldestReadyAgeMs: number | null;
}

export interface QueueSnapshot {
  preparation: QueuePhaseSnapshot;
  lifecycle: QueuePhaseSnapshot & {
    byJobKind: { requestCode: number; verifySubmit: number; submitReview: number };
  };
}

interface QueueSnapshotRow extends QueryResultRow {
  preparation_ready: string;
  preparation_delayed: string;
  preparation_running: string;
  preparation_oldest_ms: string | null;
  lifecycle_ready: string;
  lifecycle_delayed: string;
  lifecycle_running: string;
  lifecycle_oldest_ms: string | null;
  request_code: string;
  verify_submit: string;
  submit_review: string;
}

async function ownsLifecycleJob(client: PoolClient, job: LifecycleJob): Promise<boolean> {
  const result = await client.query(
    `SELECT 1 FROM account_report_jobs
     WHERE id = $1 AND attempts = $2 AND state = 'running'
     FOR UPDATE`,
    [job.id, job.execution_token]
  );
  return result.rowCount === 1;
}

async function lockReportCredit(client: PoolClient, reportId: string): Promise<LockedCreditRow | undefined> {
  const result = await client.query<LockedCreditRow>(
    `SELECT report.account_id, report.credit_chain_id, report.status, report.lifecycle_attempt,
            chain.state AS credit_state, account.status AS account_status
     FROM account_reports AS report
     JOIN report_credit_chains AS chain ON chain.id = report.credit_chain_id
     JOIN api_accounts AS account ON account.id = report.account_id
     WHERE report.id = $1 FOR UPDATE OF report, chain, account`,
    [reportId]
  );
  return result.rows[0];
}

async function releaseCredit(client: PoolClient, accountId: string, chainId: string, reason: string): Promise<void> {
  const releasedBalance = await client.query(
    `UPDATE api_accounts
     SET available_credits = available_credits + 1,
         reserved_credits = reserved_credits - 1,
         updated_at = now()
     WHERE id = $1 AND reserved_credits > 0 RETURNING id`,
    [accountId]
  );
  const releasedChain = await client.query(
    "UPDATE report_credit_chains SET state = 'released', updated_at = now() WHERE id = $1 AND state = 'reserved' RETURNING id",
    [chainId]
  );
  if (releasedBalance.rowCount !== 1 || releasedChain.rowCount !== 1) {
    throw new Error("Reserved report credit could not be released atomically.");
  }
  await client.query(
    `INSERT INTO credit_ledger
       (account_id, credit_chain_id, kind, available_delta, reserved_delta, reason)
     VALUES ($1, $2, 'release', 1, -1, $3)`,
    [accountId, chainId, reason]
  );
}

async function insertEvent(
  client: PoolClient,
  accountId: string,
  reportId: string,
  type: string,
  lifecycleAttempt: number,
  metadata: Record<string, unknown> = {}
): Promise<void> {
  const result = await client.query<{ id: string }>(
    `INSERT INTO account_report_events
       (account_id, report_id, event_type, lifecycle_attempt, metadata)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [accountId, reportId, type, lifecycleAttempt, metadata]
  );
  await enqueueDestinationDelivery(client, accountId, result.rows[0]?.id);
}

async function enqueueDestinationDelivery(
  client: PoolClient,
  accountId: string,
  eventId: string | undefined
): Promise<void> {
  if (eventId === undefined) return;
  await client.query(
    `INSERT INTO event_destination_deliveries (event_id, destination_id)
     SELECT $2, webhook_destination_id FROM api_accounts
     WHERE id = $1 AND webhook_destination_id IS NOT NULL
     ON CONFLICT DO NOTHING`,
    [accountId, eventId]
  );
}

function count(value: string | undefined): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? Math.max(0, Math.trunc(parsed)) : 0;
}

function age(value: string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.trunc(parsed)) : null;
}

function queuePhase(
  ready: string | undefined,
  delayed: string | undefined,
  running: string | undefined,
  oldest: string | null | undefined
): QueuePhaseSnapshot {
  return {
    readyPending: count(ready),
    delayedPending: count(delayed),
    running: count(running),
    oldestReadyAgeMs: age(oldest)
  };
}

export function reportRetryableModes(report: {
  status: ReportStatus;
  use_ai: boolean;
  prepared_input: Record<string, unknown> | null;
  discord_status: string | null;
  review_status?: string | null;
  error_code: string | null;
  submission_started_at?: Date | null;
}): Array<"reuse" | "regenerate" | "rewrite_ai" | "edit_manual"> {
  if (report.discord_status === "actioned" || report.error_code === "ambiguous_submission_state") return [];
  if (report.review_status === "ineligible" || report.review_status === "confirmation_timeout" || report.review_status === "request_ambiguous") return [];
  const appealDenied = report.discord_status === "review_not_approved" || report.review_status === "not_approved";
  if (appealDenied) return ["rewrite_ai", "edit_manual"];
  const failedBeforeBoundary = report.status === "failed" && report.submission_started_at == null;
  if (!failedBeforeBoundary) return [];
  const modes: Array<"reuse" | "regenerate"> = [];
  if (report.prepared_input !== null) modes.push("reuse");
  if (report.use_ai) modes.push("regenerate");
  return modes;
}

const APPEAL_DENIAL_REWRITE_INSTRUCTION = "Discord denied the automatic appeal, but no explanatory denial reason was provided. Re-evaluate the original evidence independently. Write a materially improved replacement report and choose the strongest supported country, category, and legal reference; these may differ from the prior report. Do not invent a denial reason, new evidence, or facts not present in the captured target.";

type InternalCreateReportInput = CreateReportInput & {
  rewriteDirective?: { instruction: string; previousReportReason?: string; previousContext?: string };
};

function replacementRequest(predecessor: AccountReportRow, input: RetryReportInput): InternalCreateReportInput {
  if (input.mode === "reuse" || input.mode === "regenerate") return predecessor.request_input;
  const target = structuredClone(predecessor.request_input.target);
  if (input.mode === "rewrite_ai") {
    const previous = predecessor.prepared_input;
    return {
      flow: predecessor.flow,
      useAi: true,
      target,
      rewriteDirective: {
        instruction: APPEAL_DENIAL_REWRITE_INSTRUCTION,
        ...(typeof previous?.description === "string" ? { previousReportReason: previous.description } : {}),
        ...(typeof previous?.finalText === "string" ? { previousContext: previous.finalText } : {})
      }
    };
  }
  if (input.mode !== "edit_manual") throw new Error("Unsupported replacement mode.");
  if (predecessor.flow === "profile" && "reportedUsername" in target && input.profileElements !== undefined) target.profileElements = input.profileElements;
  if (predecessor.flow === "server" && "guildIdOrInviteCode" in target && input.guildElements !== undefined) target.guildElements = input.guildElements;
  return { flow: predecessor.flow, useAi: false, target, country: input.country, category: input.category, description: input.finalText, finalText: input.finalText };
}

function shouldApplyDiscordStatus(current: string | null, incoming: string): boolean {
  if (current === incoming || current === "actioned") return false;
  if (incoming === "received") return current === null;
  if (incoming === "actioned") return true;
  if (incoming === "review_not_approved") return current !== "actioned";
  return current === null || current === "received";
}

async function consumeRateLimit(
  client: PoolClient,
  accountId: string,
  kind: "report_mutation" | "ai_preparation",
  window: "minute" | "hour",
  maximum: number
): Promise<void> {
  const result = await client.query<{ request_count: number }>(
    `INSERT INTO account_rate_limit_windows (account_id, kind, window_start, request_count)
     VALUES ($1, $2, date_trunc('${window}', now()), 1)
     ON CONFLICT (account_id, kind, window_start)
     DO UPDATE SET request_count = account_rate_limit_windows.request_count + 1
     RETURNING request_count`,
    [accountId, kind]
  );
  if ((result.rows[0]?.request_count ?? 1) > maximum) {
    throw new ReportMutationError("rate_limited", "Account request limit was exceeded.");
  }
}
