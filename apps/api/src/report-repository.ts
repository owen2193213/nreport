import { createHash, randomUUID } from "node:crypto";

import type {
  CreateReportInput,
  CursorPage,
  ReportLifecycleEvent,
  ReportConnectionRecovery,
  ReportStatus,
  ReportTimelineEvent,
  RetryReportInput,
  DiscordReportStatus
} from "@nreport/contracts";
import { boundedDiagnostic } from "@nreport/contracts";
import type { Pool, PoolClient, QueryResultRow } from "pg";
import type {
  LifecycleFailureSignal,
  LifecycleJob,
  LifecycleReport,
  LifecycleRetryOptions
} from "./lifecycle-runner-v2.js";
import type { AccountEventDelivery } from "./event-delivery-v2.js";
import { isEventCursor, isReportCursor } from "./pagination.js";

export const REPORT_EVENT_PUBLICATION_SCHEMA_SQL = `
LOCK TABLE account_report_events IN ACCESS EXCLUSIVE MODE;
CREATE SEQUENCE IF NOT EXISTS account_report_events_ordered_id_seq AS bigint CACHE 1;
ALTER SEQUENCE account_report_events_ordered_id_seq CACHE 1;
DO $$
DECLARE
  publication_sequence regclass;
  current_serial_sequence regclass;
  publication_last_value bigint;
  previous_last_value bigint;
  highest_existing_id bigint;
  publication_called boolean;
BEGIN
  publication_sequence := to_regclass(format('%I.%I', current_schema(), 'account_report_events_ordered_id_seq'));
  current_serial_sequence := pg_get_serial_sequence(
    format('%I.%I', current_schema(), 'account_report_events'), 'id'
  )::regclass;

  SELECT last_value, is_called
  INTO publication_last_value, publication_called
  FROM account_report_events_ordered_id_seq;

  IF NOT publication_called THEN
    SELECT COALESCE(MAX(id), 0) INTO highest_existing_id FROM account_report_events;
    highest_existing_id := GREATEST(highest_existing_id, publication_last_value);

    IF current_serial_sequence IS NOT NULL
       AND current_serial_sequence <> publication_sequence THEN
      EXECUTE format('SELECT last_value FROM %s', current_serial_sequence)
        INTO previous_last_value;
      -- last_value is the end of a reserved cache block, so advance past it.
      highest_existing_id := GREATEST(highest_existing_id, previous_last_value);
    END IF;

    -- Mark the high-water mark as consumed so repeat migrations never reseed it.
    PERFORM setval(publication_sequence, highest_existing_id, true);
  END IF;

  IF current_serial_sequence IS NOT NULL
     AND current_serial_sequence <> publication_sequence THEN
    EXECUTE format('ALTER SEQUENCE %s OWNED BY NONE', current_serial_sequence);
  END IF;
END;
$$;
ALTER TABLE account_report_events ALTER COLUMN id DROP DEFAULT;
ALTER SEQUENCE account_report_events_ordered_id_seq OWNED BY account_report_events.id;

CREATE OR REPLACE FUNCTION serialize_account_report_event_inserts()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  sequence_name text;
BEGIN
  -- Match the event row's FK checks before taking the global publication lock.
  EXECUTE format('SELECT 1 FROM %I.api_accounts WHERE id = $1 FOR KEY SHARE', TG_TABLE_SCHEMA)
    USING NEW.account_id;
  EXECUTE format('SELECT 1 FROM %I.account_reports WHERE id = $1 FOR KEY SHARE', TG_TABLE_SCHEMA)
    USING NEW.report_id;
  PERFORM pg_advisory_xact_lock(1729132441);
  sequence_name := pg_get_serial_sequence(
    format('%I.%I', TG_TABLE_SCHEMA, TG_TABLE_NAME), 'id'
  );
  NEW.id := nextval(sequence_name::regclass);
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS account_report_events_serialize_insert ON account_report_events;
DROP TRIGGER IF EXISTS account_report_events_assign_id_before_insert ON account_report_events;
CREATE TRIGGER account_report_events_assign_id_before_insert
  BEFORE INSERT ON account_report_events
  FOR EACH ROW EXECUTE FUNCTION serialize_account_report_event_inserts();
`;

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
  connection_recovery jsonb,
  automatic_network_restarts integer NOT NULL DEFAULT 0
    CONSTRAINT account_reports_automatic_network_restarts_check CHECK (automatic_network_restarts BETWEEN 0 AND 1),
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
ALTER TABLE account_reports ADD COLUMN IF NOT EXISTS connection_recovery jsonb;
ALTER TABLE account_reports ADD COLUMN IF NOT EXISTS automatic_network_restarts integer NOT NULL DEFAULT 0;
DO $$ BEGIN
  ALTER TABLE account_reports
    ADD CONSTRAINT account_reports_automatic_network_restarts_check
    CHECK (automatic_network_restarts BETWEEN 0 AND 1);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
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

${REPORT_EVENT_PUBLICATION_SCHEMA_SQL}

CREATE TABLE IF NOT EXISTS account_report_diagnostics (
  id bigserial PRIMARY KEY,
  report_id uuid REFERENCES account_reports(id) ON DELETE SET NULL,
  trace_id uuid,
  service text NOT NULL,
  severity text NOT NULL,
  event text NOT NULL,
  stage text,
  outcome text,
  lifecycle_attempt integer,
  reporter_email text,
  error_code text,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS account_report_diagnostics_report_idx ON account_report_diagnostics(report_id, created_at DESC);
CREATE INDEX IF NOT EXISTS account_report_diagnostics_trace_idx ON account_report_diagnostics(trace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS account_report_diagnostics_created_idx ON account_report_diagnostics(created_at);

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
CREATE INDEX IF NOT EXISTS account_report_jobs_pending_claim_idx
  ON account_report_jobs(kind, run_at, id) WHERE state = 'pending';
CREATE INDEX IF NOT EXISTS account_report_jobs_queue_length_idx
  ON account_report_jobs(report_id) WHERE state IN ('pending', 'running');
CREATE INDEX IF NOT EXISTS event_destination_deliveries_claim_idx
  ON event_destination_deliveries(state, run_at, locked_at, event_id);
CREATE INDEX IF NOT EXISTS event_destination_deliveries_ordering_idx
  ON event_destination_deliveries(destination_id, event_id) WHERE state IN ('pending', 'sending');
CREATE INDEX IF NOT EXISTS account_inbound_messages_pending_correlation_idx
  ON account_inbound_messages (external_report_id, recipient, received_at, message_id)
  WHERE status = 'pending_report';
CREATE INDEX IF NOT EXISTS account_inbound_messages_report_idx
  ON account_inbound_messages (report_id, received_at, message_id)
  WHERE report_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS account_inbound_messages_recipient_idx
  ON account_inbound_messages (recipient, received_at, message_id);

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
  episode bigint NOT NULL DEFAULT 0,
  notification_sequence bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS operations_alert_outbox (
  id bigserial PRIMARY KEY,
  alert_key text NOT NULL,
  episode bigint NOT NULL DEFAULT 0,
  notification_sequence bigint NOT NULL DEFAULT 0,
  kind text NOT NULL CHECK (kind IN ('open', 'reminder', 'recovery')),
  payload jsonb NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'sending', 'sent')),
  attempts integer NOT NULL DEFAULT 0,
  run_at timestamptz NOT NULL DEFAULT now(),
  locked_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (alert_key, episode, notification_sequence)
);
ALTER TABLE operational_alert_state ADD COLUMN IF NOT EXISTS episode bigint NOT NULL DEFAULT 0;
ALTER TABLE operational_alert_state ADD COLUMN IF NOT EXISTS notification_sequence bigint NOT NULL DEFAULT 0;
ALTER TABLE operations_alert_outbox ADD COLUMN IF NOT EXISTS episode bigint NOT NULL DEFAULT 0;
ALTER TABLE operations_alert_outbox ADD COLUMN IF NOT EXISTS notification_sequence bigint NOT NULL DEFAULT 0;
ALTER TABLE operations_alert_outbox DROP CONSTRAINT IF EXISTS operations_alert_outbox_alert_key_kind_state_key;
ALTER TABLE operations_alert_outbox DROP CONSTRAINT IF EXISTS operations_alert_outbox_alert_key_episode_kind_key;
ALTER TABLE operations_alert_outbox DROP CONSTRAINT IF EXISTS operations_alert_outbox_alert_key_episode_notification_sequence_key;
-- Rows created under the former (alert_key, kind, state) constraint may contain
-- both a sent and a pending copy of the same kind. Give each legacy row a
-- distinct episode before installing the stricter episode key.
UPDATE operations_alert_outbox SET episode = id WHERE episode = 0;
UPDATE operations_alert_outbox SET notification_sequence = id WHERE notification_sequence = 0;
UPDATE operational_alert_state AS alert SET episode = COALESCE((
  SELECT max(item.episode) FROM operations_alert_outbox AS item WHERE item.alert_key = alert.alert_key
), 0) WHERE alert.episode = 0;
UPDATE operational_alert_state AS alert SET notification_sequence = COALESCE((
  SELECT max(item.notification_sequence) FROM operations_alert_outbox AS item
  WHERE item.alert_key = alert.alert_key AND item.episode = alert.episode
), 0) WHERE alert.notification_sequence = 0;
DO $$ BEGIN
  ALTER TABLE operations_alert_outbox ADD CONSTRAINT operations_alert_outbox_episode_seq_uniq UNIQUE (alert_key, episode, notification_sequence);
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL;
END $$;
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
  connection_recovery: ReportConnectionRecovery | null;
  automatic_network_restarts: number;
  failure_stage: string | null;
  error_code: string | null;
  error_message: string | null;
  predecessor_report_id: string | null;
  successor_report_id: string | null;
  reporter_email: string | null;
  submission_started_at: Date | null;
  status: ReportStatus;
  credit_chain_id: string;
  created_at: Date;
  updated_at: Date;
}

export interface InboundEmailRegistration {
  status: "accepted" | "duplicate" | "unknown_recipient" | "pending_report";
  reportId: string | null;
  traceId: string | null;
}

export class ReportRepository {
  private lastDeliveryExpiryAt = 0;

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
    await this.persistOperationalAlertState(alerts, true);
  }

  public async observeOperationalAlerts(alerts: Array<{ key: string; severity: "warning" | "critical" }>): Promise<void> {
    await this.persistOperationalAlertState(alerts, false);
  }

  private async persistOperationalAlertState(
    alerts: Array<{ key: string; severity: "warning" | "critical" }>,
    enqueueNotifications: boolean
  ): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const seen = new Set(alerts.map((alert) => alert.key));
      for (const alert of alerts) {
        const prior = await client.query<{
          state: "open" | "closed";
          last_sent_at: Date | null;
          episode: string;
          notification_sequence: string;
        }>(
          "SELECT state, last_sent_at, episode::text, notification_sequence::text FROM operational_alert_state WHERE alert_key = $1 FOR UPDATE", [alert.key]
        );
        const row = prior.rows[0];
        const episode = row === undefined ? 1 : row.state === "closed" ? Number(row.episode) + 1 : Number(row.episode);
        const shouldSend = enqueueNotifications && (row === undefined || row.state === "closed" || row.last_sent_at === null || row.last_sent_at < new Date(Date.now() - 30 * 60_000));
        const notificationSequence = shouldSend
          ? (row === undefined || row.state === "closed" ? 1 : Number(row.notification_sequence) + 1)
          : Number(row?.notification_sequence ?? 0);
        await client.query(
          `INSERT INTO operational_alert_state (alert_key, severity, state, last_sent_at, episode, notification_sequence)
           VALUES ($1, $2, 'open', CASE WHEN $3 THEN now() ELSE NULL END, $4, $5)
           ON CONFLICT (alert_key) DO UPDATE SET severity = EXCLUDED.severity, state = 'open',
             episode = EXCLUDED.episode, notification_sequence = EXCLUDED.notification_sequence,
             last_observed_at = now(), last_sent_at = CASE WHEN $3 THEN now() ELSE operational_alert_state.last_sent_at END, updated_at = now()`,
          [alert.key, alert.severity, shouldSend, episode, notificationSequence]
        );
        if (shouldSend) await client.query(
          `INSERT INTO operations_alert_outbox (alert_key, episode, notification_sequence, kind, payload)
           VALUES ($1, $2, $3, $4, jsonb_build_object('alertKey', $1::text, 'severity', $5::text))
           ON CONFLICT (alert_key, episode, notification_sequence) DO NOTHING`,
          [alert.key, episode, notificationSequence, row?.state === "open" ? "reminder" : "open", alert.severity]
        );
      }
      const open = await client.query<{ alert_key: string; episode: string; notification_sequence: string }>("SELECT alert_key, episode::text, notification_sequence::text FROM operational_alert_state WHERE state = 'open' FOR UPDATE");
      for (const row of open.rows) if (!seen.has(row.alert_key)) {
        if (enqueueNotifications) {
          const notificationSequence = Number(row.notification_sequence) + 1;
          await client.query(
            "UPDATE operational_alert_state SET state = 'closed', recovery_sent_at = now(), notification_sequence = $2, updated_at = now() WHERE alert_key = $1",
            [row.alert_key, notificationSequence]
          );
          await client.query(
            `INSERT INTO operations_alert_outbox (alert_key, episode, notification_sequence, kind, payload)
             VALUES ($1, $2, $3, 'recovery', jsonb_build_object('alertKey', $1::text, 'status', 'recovered'))
             ON CONFLICT (alert_key, episode, notification_sequence) DO NOTHING`, [row.alert_key, Number(row.episode), notificationSequence]
          );
        } else {
          await client.query(
            "UPDATE operational_alert_state SET state = 'closed', updated_at = now() WHERE alert_key = $1",
            [row.alert_key]
          );
        }
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

  public async recoverInterruptedJobs(
    onFailure?: (failure: LifecycleFailureSignal) => void
  ): Promise<LifecycleFailureSignal[]> {
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
              (job.kind IN ('request_code', 'verify_submit')
                AND job.attempts < job.max_attempts
                AND job.locked_at < now() - interval '2 minutes')
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
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }

    const failures: LifecycleFailureSignal[] = [];
    const exhaustedJobs = await this.pool.query<{ id: string } & QueryResultRow>(
      `SELECT job.id
       FROM account_report_jobs AS job
       JOIN account_reports AS report ON report.id = job.report_id
       WHERE job.kind IN ('request_code', 'verify_submit')
         AND job.state IN ('pending', 'running')
         AND job.attempts >= job.max_attempts
         AND (job.state = 'pending' OR job.locked_at IS NULL
              OR job.locked_at < now() - interval '2 minutes')
         AND (report.submission_started_at IS NULL OR job.kind = 'request_code')
       ORDER BY report.id, job.id`
    );
    for (const candidate of exhaustedJobs.rows) {
      const failure = await this.failExhaustedLifecycleJob(candidate.id);
      if (failure !== undefined) {
        failures.push(failure);
        onFailure?.(failure);
      }
    }

    const ambiguousSubmissions = await this.pool.query<{ id: string }>(
      `SELECT report.id FROM account_reports AS report
       JOIN account_report_jobs AS job ON job.report_id = report.id
       WHERE job.state = 'running' AND job.kind = 'verify_submit'
         AND report.submission_started_at IS NOT NULL
         AND job.locked_at < now() - interval '2 minutes'
         AND report.status <> 'submitted'
       ORDER BY report.id`
    );
    const ambiguousReviews = await this.pool.query<{ id: string }>(
      `SELECT report.id FROM account_reports AS report
       JOIN account_report_jobs AS job ON job.report_id = report.id
       WHERE job.state = 'running' AND job.kind = 'submit_review'
         AND report.review_status = 'queued'
         AND job.locked_at < now() - interval '2 minutes'
         AND report.review_submission_started_at IS NOT NULL
       ORDER BY report.id`
    );

    for (const candidate of ambiguousSubmissions.rows) {
      const failure = await this.recoverAmbiguousSubmission(candidate.id);
      if (failure !== undefined) {
        failures.push(failure);
        onFailure?.(failure);
      }
    }
    for (const candidate of ambiguousReviews.rows) {
      const failure = await this.recoverAmbiguousReview(candidate.id);
      if (failure !== undefined) {
        failures.push(failure);
        onFailure?.(failure);
      }
    }
    return failures;
  }

  private async failExhaustedLifecycleJob(jobId: string): Promise<LifecycleFailureSignal | undefined> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const owner = await client.query<{ report_id: string } & QueryResultRow>(
        "SELECT report_id FROM account_report_jobs WHERE id = $1",
        [jobId]
      );
      const reportId = owner.rows[0]?.report_id;
      if (reportId === undefined || !(await lockReportMutationParents(client, reportId))) {
        await client.query("COMMIT");
        return undefined;
      }
      const candidate = await client.query<{
        id: string;
        report_id: string;
        kind: LifecycleJob["kind"];
        payload: Record<string, unknown>;
        attempts: number;
        max_attempts: number;
        trace_id: string;
      } & QueryResultRow>(
        `SELECT job.id, job.report_id, job.kind, job.payload, job.attempts, job.max_attempts,
                report.trace_id
         FROM account_report_jobs AS job
         JOIN account_reports AS report ON report.id = job.report_id
         WHERE job.id = $1 AND job.kind IN ('request_code', 'verify_submit')
           AND job.state IN ('pending', 'running')
           AND job.attempts >= job.max_attempts
           AND (job.state = 'pending' OR job.locked_at IS NULL
                OR job.locked_at < now() - interval '2 minutes')
           AND (report.submission_started_at IS NULL OR job.kind = 'request_code')
         FOR UPDATE OF job`,
        [jobId]
      );
      const row = candidate.rows[0];
      if (row === undefined) {
        await client.query("COMMIT");
        return undefined;
      }

      const locked = await lockReportCredit(client, row.report_id);
      if (locked === undefined) {
        await client.query("COMMIT");
        return undefined;
      }
      const job: LifecycleJob = {
        id: row.id,
        report_id: row.report_id,
        kind: row.kind,
        payload: row.payload,
        attempts: row.attempts,
        max_attempts: row.max_attempts,
        execution_token: row.attempts,
        trace_id: row.trace_id
      };
      if (await settleSupersededRequestJob(client, job, locked, undefined, true)) {
        await client.query("COMMIT");
        return undefined;
      }
      if (locked.submission_started_at !== null) {
        await client.query("COMMIT");
        return undefined;
      }

      const errorCode = "lifecycle_attempts_exhausted";
      const errorMessage = "The lifecycle worker stopped during the last permitted verification attempt. No further attempt was started.";
      if (locked.credit_state === "reserved") {
        await releaseCredit(client, locked.account_id, locked.credit_chain_id, "Lifecycle attempts exhausted before submission");
      }
      const failed = await client.query(
        `UPDATE account_reports
         SET status = 'failed', failure_stage = status, error_code = $2,
             error_message = $3, connection_recovery = NULL, updated_at = now()
         WHERE id = $1 AND submission_started_at IS NULL AND status <> 'failed'
         RETURNING id`,
        [row.report_id, errorCode, errorMessage]
      );
      const settledJob = await client.query(
        `UPDATE account_report_jobs
         SET state = 'failed', locked_at = NULL, last_error = $4, updated_at = now()
         WHERE id = $1 AND report_id = $2 AND attempts = $3
           AND attempts >= max_attempts AND state IN ('pending', 'running')
         RETURNING id`,
        [row.id, row.report_id, row.attempts, errorCode]
      );
      if (settledJob.rowCount !== 1) throw new Error("Exhausted lifecycle job could not be settled.");
      if (failed.rowCount === 1) {
        await insertEvent(client, locked.account_id, row.report_id, "report_failed", locked.lifecycle_attempt, {
          errorCode
        });
      }
      await client.query("COMMIT");
      if (failed.rowCount !== 1) return undefined;
      return {
        reportId: row.report_id,
        traceId: row.trace_id,
        lifecycleAttempt: locked.lifecycle_attempt,
        stage: "verification",
        eventType: "report_failed",
        outcome: "failed",
        errorCategory: "lifecycle_attempts_exhausted"
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  private async recoverAmbiguousSubmission(reportId: string): Promise<LifecycleFailureSignal | undefined> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      if (!(await lockReportMutationParents(client, reportId))) {
        await client.query("COMMIT");
        return undefined;
      }
      const candidate = await client.query<{
        id: string; trace_id: string; account_id: string; lifecycle_attempt: number;
      }>(
        `SELECT report.id, report.trace_id, report.account_id, report.lifecycle_attempt
         FROM account_reports AS report
         JOIN account_report_jobs AS job ON job.report_id = report.id
         WHERE report.id = $1 AND job.state = 'running' AND job.kind = 'verify_submit'
           AND report.submission_started_at IS NOT NULL
           AND job.locked_at < now() - interval '2 minutes'
           AND report.status <> 'submitted'
         FOR UPDATE OF job`,
        [reportId]
      );
      const row = candidate.rows[0];
      if (row === undefined) {
        await client.query("COMMIT");
        return undefined;
      }
      await client.query(
        `UPDATE account_reports SET status = 'failed', failure_stage = 'submitting',
           error_code = 'ambiguous_submission_state',
           error_message = 'Discord submission may have started before the worker restarted.',
           connection_recovery = NULL, updated_at = now() WHERE id = $1`,
        [reportId]
      );
      await client.query(
        `UPDATE account_report_jobs SET state = 'failed', locked_at = NULL,
           last_error = 'ambiguous_submission_state', updated_at = now()
         WHERE report_id = $1 AND kind = 'verify_submit' AND state = 'running'`,
        [reportId]
      );
      await insertEvent(client, row.account_id, row.id, "report_failed", row.lifecycle_attempt, {
        errorCode: "ambiguous_submission_state"
      });
      await client.query("COMMIT");
      return {
        reportId: row.id, traceId: row.trace_id, lifecycleAttempt: row.lifecycle_attempt,
        stage: "submitting", eventType: "report_failed", outcome: "ambiguous",
        errorCategory: "ambiguous_submission_state"
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  private async recoverAmbiguousReview(reportId: string): Promise<LifecycleFailureSignal | undefined> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      if (!(await lockReportMutationParents(client, reportId))) {
        await client.query("COMMIT");
        return undefined;
      }
      const candidate = await client.query<{
        id: string; trace_id: string; account_id: string; lifecycle_attempt: number;
      }>(
        `SELECT report.id, report.trace_id, report.account_id, report.lifecycle_attempt
         FROM account_reports AS report
         JOIN account_report_jobs AS job ON job.report_id = report.id
         WHERE report.id = $1 AND job.state = 'running' AND job.kind = 'submit_review'
           AND report.review_status = 'queued'
           AND job.locked_at < now() - interval '2 minutes'
           AND report.review_submission_started_at IS NOT NULL
         FOR UPDATE OF job`,
        [reportId]
      );
      const row = candidate.rows[0];
      if (row === undefined) {
        await client.query("COMMIT");
        return undefined;
      }
      await client.query(
        `UPDATE account_reports SET review_status = 'request_ambiguous', review_status_updated_at = now(),
           review_confirmation_deadline = NULL,
           review_error_code = 'review_request_ambiguous',
           review_error_message = 'The appeal outcome is uncertain after a worker restart.',
           updated_at = now() WHERE id = $1`,
        [reportId]
      );
      await client.query(
        `UPDATE account_report_jobs SET state = 'failed', locked_at = NULL,
           last_error = 'review_request_ambiguous', updated_at = now()
         WHERE report_id = $1 AND kind = 'submit_review' AND state = 'running'`,
        [reportId]
      );
      await insertEvent(client, row.account_id, row.id, "review_request_ambiguous", row.lifecycle_attempt, {
        errorCode: "review_request_ambiguous"
      });
      await client.query("COMMIT");
      return {
        reportId: row.id, traceId: row.trace_id, lifecycleAttempt: row.lifecycle_attempt,
        stage: "review_submission", eventType: "review_request_ambiguous", outcome: "ambiguous",
        errorCategory: "review_request_ambiguous"
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  public async expireDeadlines(onFailure?: (failure: LifecycleFailureSignal) => void): Promise<void> {
    // Each expired report is handled in its own short transaction that locks
    // in the same order as create(): the api_accounts row first, then the
    // report/chain. A single wrapping transaction previously called
    // releaseCredit (which locks api_accounts) after an earlier insertEvent
    // in the loop had already taken account_report_events' global advisory
    // lock, inverting create()'s lock order and risking deadlock.
    const candidates = await this.pool.query<{ id: string }>(
      `SELECT report.id
       FROM account_reports AS report
       JOIN report_credit_chains AS chain ON chain.id = report.credit_chain_id
       WHERE report.verification_deadline <= now()
         AND report.status IN ('requesting_verification', 'awaiting_verification', 'verification_received')
         AND report.submission_started_at IS NULL
         AND chain.state IN ('reserved', 'consumed')`
    );
    for (const candidate of candidates.rows) {
      const failure = await this.expireVerificationDeadline(candidate.id);
      if (failure !== undefined) onFailure?.(failure);
    }
    await this.expireReceiptDeadlines(onFailure);
    await this.expireReviewDeadlines(onFailure);
  }

  private async expireVerificationDeadline(reportId: string): Promise<LifecycleFailureSignal | undefined> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      if (!(await lockReportMutationParents(client, reportId))) {
        await client.query("COMMIT");
        return undefined;
      }
      const locked = await client.query<{
        account_id: string; trace_id: string; credit_chain_id: string;
        credit_state: "available" | "reserved" | "consumed" | "released"; lifecycle_attempt: number;
      }>(
        `SELECT report.account_id, report.trace_id, report.credit_chain_id, chain.state AS credit_state, report.lifecycle_attempt
         FROM account_reports AS report
         JOIN report_credit_chains AS chain ON chain.id = report.credit_chain_id
         WHERE report.id = $1
           AND report.verification_deadline <= now()
           AND report.status IN ('requesting_verification', 'awaiting_verification', 'verification_received')
           AND report.submission_started_at IS NULL
           AND chain.state IN ('reserved', 'consumed')`,
        [reportId]
      );
      const report = locked.rows[0];
      if (report === undefined) {
        // No longer eligible: already handled by another pass, or the report
        // advanced past the deadline concurrently.
        await client.query("COMMIT");
        return undefined;
      }
      if (report.credit_state === "reserved") {
        await releaseCredit(client, report.account_id, report.credit_chain_id, "Verification email timed out");
      }
      await client.query(
        `UPDATE account_reports SET status = 'failed', failure_stage = status,
           error_code = 'verification_timeout', error_message = 'Discord verification email timed out.',
           verification_deadline = NULL, connection_recovery = NULL, updated_at = now() WHERE id = $1`,
        [reportId]
      );
      await client.query(
        `UPDATE account_report_jobs SET state = 'failed', locked_at = NULL,
           last_error = 'verification_timeout', updated_at = now()
         WHERE report_id = $1 AND state IN ('pending', 'running')`,
        [reportId]
      );
      await insertEvent(client, report.account_id, reportId, "report_failed", report.lifecycle_attempt, { errorCode: "verification_timeout" });
      await client.query("COMMIT");
      return {
        reportId,
        traceId: report.trace_id,
        lifecycleAttempt: report.lifecycle_attempt,
        stage: "verification",
        eventType: "report_failed",
        outcome: "failed",
        errorCategory: "verification_timeout"
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      (client).release();
    }
  }

  private async expireReceiptDeadlines(onFailure?: (failure: LifecycleFailureSignal) => void): Promise<void> {
    const candidates = await this.pool.query<{ id: string }>(
      `SELECT id FROM account_reports
       WHERE status = 'submitted' AND discord_status IS NULL AND receipt_deadline <= now()
       ORDER BY receipt_deadline, id`
    );
    for (const candidate of candidates.rows) {
      const client = await this.pool.connect();
      let failure: LifecycleFailureSignal | undefined;
      try {
        await client.query("BEGIN");
        if (!(await lockReportMutationParents(client, candidate.id))) {
          await client.query("COMMIT");
          continue;
        }
        const expired = await client.query<{
          id: string; trace_id: string; account_id: string; lifecycle_attempt: number;
        }>(
          `UPDATE account_reports SET status = 'failed', failure_stage = 'submitted',
             error_code = 'discord_receipt_timeout',
             error_message = 'Discord did not send a report receipt before the deadline.',
             receipt_deadline = NULL, connection_recovery = NULL, updated_at = now()
           WHERE id = $1 AND status = 'submitted' AND discord_status IS NULL AND receipt_deadline <= now()
           RETURNING id, trace_id, account_id, lifecycle_attempt`,
          [candidate.id]
        );
        const report = expired.rows[0];
        if (report !== undefined) {
          await insertEvent(client, report.account_id, report.id, "report_receipt_timeout", report.lifecycle_attempt, {
            errorCode: "discord_receipt_timeout"
          });
          failure = {
            reportId: report.id, traceId: report.trace_id, lifecycleAttempt: report.lifecycle_attempt,
            stage: "submitted", eventType: "report_receipt_timeout", outcome: "failed",
            errorCategory: "discord_receipt_timeout"
          };
        }
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
      if (failure !== undefined) onFailure?.(failure);
    }
  }

  private async expireReviewDeadlines(onFailure?: (failure: LifecycleFailureSignal) => void): Promise<void> {
    const candidates = await this.pool.query<{ id: string }>(
      `SELECT id FROM account_reports
       WHERE review_status = 'requested' AND review_confirmation_deadline <= now()
       ORDER BY review_confirmation_deadline, id`
    );
    for (const candidate of candidates.rows) {
      const client = await this.pool.connect();
      let failure: LifecycleFailureSignal | undefined;
      try {
        await client.query("BEGIN");
        if (!(await lockReportMutationParents(client, candidate.id))) {
          await client.query("COMMIT");
          continue;
        }
        const expired = await client.query<{
          id: string; trace_id: string; account_id: string; lifecycle_attempt: number;
        }>(
          `UPDATE account_reports SET review_status = 'confirmation_timeout',
             review_status_updated_at = now(), review_confirmation_deadline = NULL,
             review_error_code = 'review_confirmation_timeout',
             review_error_message = 'Discord did not confirm the automatic appeal before the deadline.',
             updated_at = now()
           WHERE id = $1 AND review_status = 'requested' AND review_confirmation_deadline <= now()
           RETURNING id, trace_id, account_id, lifecycle_attempt`,
          [candidate.id]
        );
        const report = expired.rows[0];
        if (report !== undefined) {
          await insertEvent(client, report.account_id, report.id, "review_confirmation_timeout", report.lifecycle_attempt, {
            errorCode: "review_confirmation_timeout"
          });
          failure = {
            reportId: report.id, traceId: report.trace_id, lifecycleAttempt: report.lifecycle_attempt,
            stage: "review_confirmation", eventType: "review_confirmation_timeout", outcome: "failed",
            errorCategory: "review_confirmation_timeout"
          };
        }
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
      if (failure !== undefined) onFailure?.(failure);
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
         WHERE id = $1 FOR NO KEY UPDATE`,
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
        if (!isReportCursor(decoded)) {
          throw new Error("Invalid cursor");
        }
        cursor = { createdAt: decoded.createdAt, id: decoded.id };
      } catch {
        throw new ReportMutationError("invalid_cursor", "Report cursor is invalid.");
      }
    }
    const result = cursor === null
      ? await this.pool.query<AccountReportRow & { cursor_created_at: string }>(
          `SELECT report.*, chain.state AS credit_state,
                  to_char(report.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_created_at
           FROM account_reports AS report
           JOIN report_credit_chains AS chain ON chain.id = report.credit_chain_id
           WHERE report.account_id = $1
           ORDER BY report.created_at DESC, report.id DESC LIMIT $2`,
          [accountId, pageSize + 1]
        )
      : await this.pool.query<AccountReportRow & { cursor_created_at: string }>(
          `SELECT report.*, chain.state AS credit_state,
                  to_char(report.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_created_at
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
        ? Buffer.from(JSON.stringify({ createdAt: last.cursor_created_at, id: last.id })).toString("base64url")
        : null
    };
  }

  public async operationalDiagnostics(reportId?: string): Promise<Record<string, unknown>> {
    const result = await this.pool.query<{
      reports: string; pending_jobs: string; running_jobs: string;
      pending_deliveries: string; expired_deliveries: string; pending_inbound_messages: string;
      pending_inbound_older_than_two_minutes: string; oldest_pending_inbound_age_ms: string | null;
    }>(
      `SELECT
         (SELECT count(*) FROM account_reports)::text AS reports,
         (SELECT count(*) FROM account_report_jobs WHERE state = 'pending')::text AS pending_jobs,
         (SELECT count(*) FROM account_report_jobs WHERE state = 'running')::text AS running_jobs,
         (SELECT count(*) FROM event_destination_deliveries WHERE state = 'pending')::text AS pending_deliveries,
         (SELECT count(*) FROM event_destination_deliveries WHERE state = 'expired')::text AS expired_deliveries,
         (SELECT count(*) FROM account_inbound_messages WHERE status = 'pending_report')::text AS pending_inbound_messages,
         (SELECT count(*) FROM account_inbound_messages WHERE status = 'pending_report' AND received_at < now() - interval '2 minutes')::text AS pending_inbound_older_than_two_minutes,
         (SELECT extract(epoch FROM (now() - min(received_at))) * 1000 FROM account_inbound_messages WHERE status = 'pending_report')::text AS oldest_pending_inbound_age_ms`
    );
    const row = result.rows[0];
    const [snapshot, workers, alerts] = await Promise.all([
      this.queueSnapshot(), this.operationalWorkerHealth(), this.pool.query<{ alert_key: string; severity: string }>(
        "SELECT alert_key, severity FROM operational_alert_state WHERE state = 'open' ORDER BY alert_key"
      )
    ]);
    const diagnostics: Record<string, unknown> = {
      reports: Number(row?.reports ?? 0),
      pendingJobs: Number(row?.pending_jobs ?? 0),
      runningJobs: Number(row?.running_jobs ?? 0),
      pendingDeliveries: Number(row?.pending_deliveries ?? 0),
      expiredDeliveries: Number(row?.expired_deliveries ?? 0),
      pendingInboundMessages: Number(row?.pending_inbound_messages ?? 0),
      pendingInboundOlderThanTwoMinutes: Number(row?.pending_inbound_older_than_two_minutes ?? 0),
      oldestPendingInboundAgeMs: age(row?.oldest_pending_inbound_age_ms),
      queues: snapshot,
      workers,
      openAlerts: alerts.rows.map((alert) => ({ key: alert.alert_key, severity: alert.severity }))
    };
    if (reportId === undefined) return diagnostics;
    return { ...diagnostics, report: await this.reportDiagnostics(reportId) };
  }

  private async reportDiagnostics(reportId: string): Promise<Record<string, unknown> | null> {
    const reportResult = await this.pool.query<{
      id: string; trace_id: string; flow: string; status: string; error_code: string | null;
      error_message: string | null; failure_stage: string | null; discord_report_id: string | null;
      discord_status: string | null; review_status: string | null; created_at: Date | string;
      updated_at: Date | string; verification_deadline: Date | string | null; receipt_deadline: Date | string | null;
      submission_started_at: Date | string | null; credit_state: string;
    }>(
      `SELECT report.id, report.trace_id, report.flow, report.status, report.error_code,
              report.error_message, report.failure_stage, report.discord_report_id,
              report.discord_status, report.review_status, report.created_at, report.updated_at,
              report.verification_deadline, report.receipt_deadline, report.submission_started_at,
              chain.state AS credit_state
       FROM account_reports AS report
       JOIN report_credit_chains AS chain ON chain.id = report.credit_chain_id
       WHERE report.id = $1`,
      [reportId]
    );
    const report = reportResult.rows[0];
    if (report === undefined) return null;

    const [events, jobs, inboundSummary, inboundGroups, deliveries] = await Promise.all([
      this.pool.query<{
        id: string; event_type: string; lifecycle_attempt: number; created_at: Date | string; total_count: string;
      }>(
        `SELECT event.id::text, event.event_type, event.lifecycle_attempt, event.created_at,
                count(*) OVER()::text AS total_count
         FROM account_report_events AS event
         WHERE event.report_id = $1
         ORDER BY event.id DESC LIMIT 100`,
        [reportId]
      ),
      this.pool.query<{
        id: string; kind: string; state: string; attempts: number; max_attempts: number;
        run_at: Date | string; locked_at: Date | string | null; last_error_category: string | null;
        total_count: string;
      }>(
        `SELECT job.id::text, job.kind, job.state, job.attempts, job.max_attempts,
                job.run_at, job.locked_at,
                CASE
                  WHEN job.last_error IS NULL THEN NULL
                  WHEN job.last_error = 'account_suspended' THEN 'account_suspended'
                  WHEN job.last_error = 'ambiguous_submission_state' THEN 'ambiguous_submission'
                  WHEN job.last_error LIKE 'preparation_%' THEN 'preparation_failure'
                  WHEN job.last_error LIKE 'review_%' THEN 'review_failure'
                  WHEN job.last_error LIKE 'discord_http_%' THEN 'discord_http_failure'
                  WHEN job.last_error = 'discord_network_error' THEN 'discord_network_failure'
                  WHEN job.last_error LIKE 'discord_%' THEN 'discord_lifecycle_failure'
                  ELSE 'worker_failure'
                END AS last_error_category,
                count(*) OVER()::text AS total_count
         FROM account_report_jobs AS job
         WHERE job.report_id = $1
         ORDER BY job.updated_at DESC, job.id DESC LIMIT 50`,
        [reportId]
      ),
      this.pool.query<{
        total: string; pending_report: string; accepted: string; unknown_recipient: string; other_status: string;
        received: string; actioned: string; closed_no_action: string; review_not_approved: string;
        review_received: string; no_external_status: string; other_external_status: string;
        latest_received_at: Date | string | null;
      }>(
        `SELECT count(*)::text AS total,
                count(*) FILTER (WHERE message.status = 'pending_report')::text AS pending_report,
                count(*) FILTER (WHERE message.status = 'accepted')::text AS accepted,
                count(*) FILTER (WHERE message.status = 'unknown_recipient')::text AS unknown_recipient,
                count(*) FILTER (WHERE message.status NOT IN ('pending_report', 'accepted', 'unknown_recipient'))::text AS other_status,
                count(*) FILTER (WHERE message.external_status = 'received')::text AS received,
                count(*) FILTER (WHERE message.external_status = 'actioned')::text AS actioned,
                count(*) FILTER (WHERE message.external_status = 'closed_no_action')::text AS closed_no_action,
                count(*) FILTER (WHERE message.external_status = 'review_not_approved')::text AS review_not_approved,
                count(*) FILTER (WHERE message.external_status = 'review_received')::text AS review_received,
                count(*) FILTER (WHERE message.external_status IS NULL)::text AS no_external_status,
                count(*) FILTER (WHERE message.external_status IS NOT NULL AND message.external_status NOT IN
                  ('received', 'actioned', 'closed_no_action', 'review_not_approved', 'review_received'))::text AS other_external_status,
                max(message.received_at) AS latest_received_at
         FROM account_inbound_messages AS message
         JOIN account_reports AS report ON report.id = $1
         WHERE message.report_id = report.id OR message.recipient = report.reporter_email`,
        [reportId]
      ),
      this.pool.query<{
        external_report_id: string | null; registration_status: string; external_status: string | null;
        message_count: string; group_count: string; matches_report: boolean;
        first_received_at: Date | string; latest_received_at: Date | string;
      }>(
        `SELECT message.external_report_id, message.status AS registration_status, message.external_status,
                count(*)::text AS message_count, count(*) OVER()::text AS group_count,
                bool_or(message.external_report_id = report.discord_report_id) AS matches_report,
                min(message.received_at) AS first_received_at, max(message.received_at) AS latest_received_at
         FROM account_inbound_messages AS message
         JOIN account_reports AS report ON report.id = $1
         WHERE message.report_id = report.id OR message.recipient = report.reporter_email
         GROUP BY message.external_report_id, message.status, message.external_status
         ORDER BY max(message.received_at) DESC, message.external_report_id NULLS LAST LIMIT 50`,
        [reportId]
      ),
      this.pool.query<{ state: string; count: string }>(
        `SELECT delivery.state, count(*)::text AS count
         FROM event_destination_deliveries AS delivery
         JOIN account_report_events AS event ON event.id = delivery.event_id
         WHERE event.report_id = $1
         GROUP BY delivery.state`,
        [reportId]
      )
    ]);
    const summary = inboundSummary.rows[0];
    const deliveryCounts = { pending: 0, sending: 0, sent: 0, expired: 0, other: 0 };
    for (const delivery of deliveries.rows) {
      const state = delivery.state in deliveryCounts ? delivery.state as keyof typeof deliveryCounts : "other";
      deliveryCounts[state] = count(delivery.count);
    }
    const recentEvents = [...events.rows].reverse();
    const recentJobs = jobs.rows.map((job) => ({
      id: job.id,
      kind: safeDiagnosticJobKind(job.kind),
      state: safeDiagnosticJobState(job.state),
      attempts: count(String(job.attempts)),
      maxAttempts: count(String(job.max_attempts)),
      runAt: diagnosticTimestamp(job.run_at),
      lockedAt: diagnosticTimestamp(job.locked_at),
      lastErrorCategory: safeDiagnosticErrorCategory(job.last_error_category)
    }));
    const inboundGroupsList = inboundGroups.rows.map((group) => ({
      externalReportId: safeDiagnosticExternalReportId(group.external_report_id),
      matchesSubmittedReportId: group.matches_report === true,
      registrationStatus: safeDiagnosticInboundStatus(group.registration_status),
      externalStatus: safeDiagnosticExternalStatus(group.external_status),
      count: count(group.message_count),
      firstReceivedAt: diagnosticTimestamp(group.first_received_at),
      latestReceivedAt: diagnosticTimestamp(group.latest_received_at)
    }));

    return {
      id: report.id,
      traceId: report.trace_id,
      flow: safeDiagnosticLabel(report.flow, ["message", "profile", "server"]),
      status: safeDiagnosticStatus(report.status),
      errorCode: safeDiagnosticErrorCode(report.error_code),
      errorMessage: report.error_message === null ? null : report.error_message.slice(0, 1000),
      failureStage: report.failure_stage === null ? null : safeDiagnosticLabel(report.failure_stage, [
        "queued", "planning", "researching", "writing", "preparing", "requesting_verification",
        "awaiting_verification", "verification_received", "verifying", "submitting", "submitted"
      ]),
      discordReportId: safeDiagnosticExternalReportId(report.discord_report_id),
      discordStatus: safeDiagnosticExternalStatus(report.discord_status),
      reviewStatus: safeDiagnosticReviewStatus(report.review_status),
      createdAt: diagnosticTimestamp(report.created_at),
      updatedAt: diagnosticTimestamp(report.updated_at),
      verificationDeadline: diagnosticTimestamp(report.verification_deadline),
      receiptDeadline: diagnosticTimestamp(report.receipt_deadline),
      submissionStartedAt: diagnosticTimestamp(report.submission_started_at),
      creditState: safeDiagnosticCreditState(report.credit_state),
      events: {
        total: count(events.rows[0]?.total_count),
        items: recentEvents.map((event) => ({
          id: String(event.id), type: event.event_type, lifecycleAttempt: event.lifecycle_attempt,
          occurredAt: diagnosticTimestamp(event.created_at)
        }))
      },
      jobs: { total: count(jobs.rows[0]?.total_count), items: recentJobs },
      inbound: {
        total: count(summary?.total),
        byRegistrationStatus: {
          pendingReport: count(summary?.pending_report), accepted: count(summary?.accepted),
          unknownRecipient: count(summary?.unknown_recipient), other: count(summary?.other_status)
        },
        byExternalStatus: {
          received: count(summary?.received), actioned: count(summary?.actioned),
          closedNoAction: count(summary?.closed_no_action), reviewNotApproved: count(summary?.review_not_approved),
          reviewReceived: count(summary?.review_received), none: count(summary?.no_external_status),
          other: count(summary?.other_external_status)
        },
        latestReceivedAt: diagnosticTimestamp(summary?.latest_received_at),
        groupCount: count(inboundGroups.rows[0]?.group_count),
        groups: inboundGroupsList
      },
      deliveries: {
        total: deliveryCounts.pending + deliveryCounts.sending + deliveryCounts.sent + deliveryCounts.expired + deliveryCounts.other,
        ...deliveryCounts
      }
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
    if (!isEventCursor(after)) throw new ReportMutationError("invalid_cursor", "Event cursor is invalid.");
    const pageSize = Math.max(1, Math.min(100, limit));
    // The insert trigger assigns IDs after acquiring the transaction publication lock,
    // so a later commit cannot introduce an event below this cursor.
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
    input: RetryReportInput
  ): Promise<{ created: boolean; report: AccountReportRow }> {
    const mode = input.mode;
    const requestHash = createHash("sha256")
      .update(JSON.stringify({ predecessorReportId, input }))
      .digest("hex");
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const account = await client.query<{ status: "active" | "suspended"; available_credits: number }>(
        "SELECT status, available_credits FROM api_accounts WHERE id = $1 FOR NO KEY UPDATE",
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
         FOR NO KEY UPDATE OF predecessor, chain`,
        [accountId, predecessorReportId]
      );
      const predecessor = predecessorResult.rows[0];
      if (predecessor === undefined) throw new ReportMutationError("report_not_found", "Report was not found.");
      if (predecessor.successor_report_id !== null) {
        throw new ReportMutationError("invalid_retry", "This report already has a successor.");
      }
      if (!reportRetryableModes(predecessor).includes(mode)) {
        throw new ReportMutationError("invalid_retry", "The requested retry mode is not available.");
      }

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

  public async claimPreparation(): Promise<{ jobId: string; executionToken: number; report: AccountReportRow } | null> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const job = await client.query<{ id: string; report_id: string; attempts: number }>(
        `WITH candidate AS (
           SELECT id FROM account_report_jobs
           WHERE kind = 'prepare_report' AND state = 'pending' AND run_at <= now()
           ORDER BY run_at, id FOR UPDATE SKIP LOCKED LIMIT 1
         )
         UPDATE account_report_jobs AS job
         SET state = 'running', attempts = attempts + 1, locked_at = now(), updated_at = now()
         FROM candidate WHERE job.id = candidate.id
         RETURNING job.id, job.report_id, job.attempts`
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
      return { jobId: claimed.id, executionToken: claimed.attempts, report: row };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      (client).release();
    }
  }

  public async transition(reportId: string, status: ReportStatus, jobId: string, executionToken: number): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      if (!(await ownsPreparationJob(client, jobId, reportId, executionToken))) {
        await client.query("COMMIT");
        return false;
      }
      const updated = await client.query<{ account_id: string; lifecycle_attempt: number }>(
        `UPDATE account_reports AS report SET status = $2, connection_recovery = NULL, updated_at = now()
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
    _usage: { aiRequests: number; inputTokens: number; outputTokens: number; searchRequests: number },
    executionToken: number
  ): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      if (!(await ownsPreparationJob(client, jobId, reportId, executionToken))) {
        await client.query("COMMIT");
        return false;
      }
      const recorded = await client.query<{
        account_id: string;
        preparation_ai_requests: string;
        preparation_input_tokens: string;
        preparation_output_tokens: string;
        preparation_search_requests: string;
      }>(
        `SELECT account_id, preparation_ai_requests, preparation_input_tokens,
                preparation_output_tokens, preparation_search_requests
         FROM account_reports WHERE id = $1`,
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
        "UPDATE account_report_jobs SET state = 'completed', locked_at = NULL, updated_at = now() WHERE id = $1 AND report_id = $2 AND attempts = $3 AND state = 'running'",
        [jobId, reportId, executionToken]
      );
      await client.query(
        `INSERT INTO account_report_jobs (report_id, kind, dedupe_key, max_attempts)
         VALUES ($1, 'request_code', $2, 3) ON CONFLICT (dedupe_key) DO NOTHING`,
        [reportId, `request-code:${reportId}:1`]
      );
      await insertEvent(client, row.account_id, reportId, "report_prepared", row.lifecycle_attempt);
      await insertEvent(client, row.account_id, reportId, "verification_queued", row.lifecycle_attempt);
      await client.query("COMMIT");
      return true;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      (client).release();
    }
  }

  public async failPreparation(jobId: string, reportId: string, code: string, message: string, executionToken: number): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      if (!(await ownsPreparationJob(client, jobId, reportId, executionToken))) {
        await client.query("COMMIT");
        return false;
      }
      const locked = await lockReportCredit(client, reportId);
      if (locked !== undefined && locked.credit_state === "reserved") {
        await releaseCredit(client, locked.account_id, locked.credit_chain_id, "Preparation failed");
      }
      if (locked !== undefined) {
        const failed = await client.query(
          `UPDATE account_reports
           SET status = 'failed', failure_stage = status, error_code = $2,
               error_message = $3, connection_recovery = NULL, updated_at = now()
           WHERE id = $1 AND submission_started_at IS NULL AND status <> 'failed'
           RETURNING id`,
          [reportId, code, message]
        );
        await client.query(
          "UPDATE account_report_jobs SET state = 'failed', locked_at = NULL, last_error = $2, updated_at = now() WHERE id = $1 AND report_id = $3 AND attempts = $4 AND state = 'running'",
          [jobId, code, reportId, executionToken]
        );
        if (failed.rowCount === 1) {
          await insertEvent(client, locked.account_id, reportId, "report_failed", locked.lifecycle_attempt, { errorCode: code });
        }
      }
      await client.query("COMMIT");
      return locked !== undefined;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      (client).release();
    }
  }

  public async recordPreparationUsage(
    reportId: string,
    jobId: string,
    executionToken: number,
    usage: { aiRequests: number; inputTokens: number; outputTokens: number; searchRequests: number }
  ): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      if (!(await ownsPreparationJob(client, jobId, reportId, executionToken))) {
        await client.query("COMMIT");
        return false;
      }
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
      return true;
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
             connection_recovery = NULL, updated_at = now() WHERE id = $1`,
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
        `UPDATE account_reports SET status = 'submitting', submission_started_at = now(),
           connection_recovery = NULL, updated_at = now()
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
           AND (kind NOT IN ('request_code', 'verify_submit') OR attempts < max_attempts)
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
              proxy_session_id, session_state, request_input, prepared_input, status, discord_report_id
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
        `UPDATE account_reports AS report SET status = $2, connection_recovery = NULL, updated_at = now()
         WHERE report.id = $1
           AND (($3 = 'request_code' AND report.status = 'requesting_verification')
             OR ($3 = 'verify_submit' AND report.status IN ('awaiting_verification', 'verification_received', 'verifying')))
           AND EXISTS (
             SELECT 1 FROM api_accounts AS account
             WHERE account.id = report.account_id AND account.status = 'active'
           )
         RETURNING account_id, lifecycle_attempt`,
        [job.report_id, status, job.kind]
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
  ): Promise<boolean | "superseded"> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      if (!(await ownsLifecycleJob(client, job))) {
        await client.query("COMMIT");
        return false;
      }
      const locked = await lockReportCredit(client, job.report_id);
      if (locked !== undefined && await settleSupersededRequestJob(client, job, locked, encryptedSession)) {
        await client.query("COMMIT");
        return "superseded";
      }
      const updated = await client.query<{
        account_id: string; lifecycle_attempt: number; status: ReportStatus;
      }>(
        `UPDATE account_reports
         SET session_state = $2,
             connection_recovery = NULL,
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
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      if (!(await ownsLifecycleJob(client, job))) {
        await client.query("COMMIT");
        return false;
      }
      const result = await client.query(
        `UPDATE account_report_jobs SET state = 'completed', locked_at = NULL, updated_at = now()
         WHERE id = $1 AND report_id = $2 AND attempts = $3 AND state = 'running' RETURNING id`,
        [job.id, job.report_id, job.execution_token]
      );
      await client.query("COMMIT");
      return result.rowCount === 1;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  public async retryLifecycleJob(
    job: LifecycleJob,
    code: string,
    delaySeconds: number,
    options: LifecycleRetryOptions = {}
  ): Promise<boolean | "superseded"> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      if (!(await ownsLifecycleJob(client, job))) {
        await client.query("COMMIT");
        return false;
      }
      const locked = await lockReportCredit(client, job.report_id);
      if (locked !== undefined && await settleSupersededRequestJob(client, job, locked, options.encryptedSession)) {
        await client.query("COMMIT");
        return "superseded";
      }
      const attemptState = await client.query<{ attempts: number; max_attempts: number }>(
        `SELECT attempts, max_attempts FROM account_report_jobs
         WHERE id = $1 AND report_id = $2 AND kind = $3 AND attempts = $4 AND state = 'running'
         FOR UPDATE`,
        [job.id, job.report_id, job.kind, job.execution_token]
      );
      const actualAttempt = attemptState.rows[0];
      if (actualAttempt === undefined || actualAttempt.attempts >= actualAttempt.max_attempts) {
        await client.query("COMMIT");
        return false;
      }
      const recordProgress = options.recordConnectionProgress === true &&
        (job.kind === "request_code" || job.kind === "verify_submit") &&
        locked !== undefined && locked.submission_started_at === null &&
        locked.discord_report_id === null && locked.status !== "failed" &&
        locked.successor_report_id === null &&
        ((job.kind === "request_code" && locked.status === "requesting_verification") ||
          (job.kind === "verify_submit" &&
            (locked.status === "verification_received" || locked.status === "verifying")));
      if (locked === undefined || (options.recordConnectionProgress === true && !recordProgress)) {
        await client.query("COMMIT");
        return false;
      }
      if (options.encryptedSession !== undefined) {
        await client.query(
          `UPDATE account_reports SET session_state = $2, updated_at = now()
           WHERE id = $1 AND submission_started_at IS NULL`,
          [job.report_id, options.encryptedSession]
        );
      }
      if (options.encryptedVerifiedToken !== undefined) {
        await client.query(
          `UPDATE account_report_jobs SET payload = payload || jsonb_build_object('encryptedVerifiedToken', $2::text)
           WHERE id = $1 AND report_id = $3 AND attempts = $4 AND state = 'running'`,
          [job.id, options.encryptedVerifiedToken, job.report_id, job.execution_token]
        );
      }
      const scheduled = await client.query<{ run_at: Date }>(
        `UPDATE account_report_jobs
         SET state = 'pending', locked_at = NULL, last_error = $3,
             run_at = now() + ($4 * interval '1 second'), updated_at = now()
         WHERE id = $1 AND attempts = $2 AND state = 'running'
         RETURNING run_at`,
        [job.id, job.execution_token, code, Math.max(1, Math.floor(delaySeconds))]
      );
      const runAt = scheduled.rows[0]?.run_at;
      if (runAt === undefined) {
        await client.query("ROLLBACK");
        return false;
      }
      if (recordProgress) {
        const recovery: ReportConnectionRecovery = {
          state: "retrying",
          attempt: actualAttempt.attempts + 1,
          maxAttempts: actualAttempt.max_attempts,
          retryAt: runAt.toISOString(),
          successorReportId: null
        };
        await client.query(
          "UPDATE account_reports SET connection_recovery = $2::jsonb, updated_at = now() WHERE id = $1",
          [job.report_id, JSON.stringify(recovery)]
        );
        await insertEvent(client, locked.account_id, job.report_id, "report_connection_retry", locked.lifecycle_attempt, {
          attempt: recovery.attempt,
          maxAttempts: recovery.maxAttempts,
          retryAt: recovery.retryAt
        });
      }
      await client.query("COMMIT");
      return true;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  public async failBeforeSubmission(
    job: LifecycleJob,
    code: string,
    message: string,
    automaticNetworkRestartEligible = false,
    encryptedSession?: string
  ): Promise<boolean | "restarted" | "superseded"> {
    return this.failLifecycle(job, code, message, true, automaticNetworkRestartEligible, encryptedSession);
  }

  public async failAfterSubmission(
    job: LifecycleJob,
    code: string,
    message: string
  ): Promise<boolean> {
    return (await this.failLifecycle(job, code, message, false)) === true;
  }

  private async failLifecycle(
    job: LifecycleJob,
    code: string,
    message: string,
    releaseReservation: boolean,
    automaticNetworkRestartEligible = false,
    encryptedSession?: string
  ): Promise<boolean | "restarted" | "superseded"> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      if (!(await ownsLifecycleJob(client, job))) {
        await client.query("COMMIT");
        return false;
      }
      const locked = await lockReportCredit(client, job.report_id);
      if (
        locked !== undefined && releaseReservation &&
        await settleSupersededRequestJob(client, job, locked, encryptedSession)
      ) {
        await client.query("COMMIT");
        return "superseded";
      }
      if (
        locked !== undefined &&
        releaseReservation &&
        automaticNetworkRestartEligible &&
        await eligibleAutomaticNetworkRestart(client, job, locked, code)
      ) {
        const restarted = await createAutomaticNetworkSuccessor(client, job, locked, code, message);
        if (restarted) {
          await client.query("COMMIT");
          return "restarted";
        }
      }
      if (locked !== undefined && releaseReservation && locked.credit_state === "reserved") {
        await releaseCredit(client, locked.account_id, locked.credit_chain_id, "Lifecycle failed before submission");
      }
      if (locked !== undefined) {
        const failed = await client.query(
          `UPDATE account_reports
           SET status = 'failed', failure_stage = status, error_code = $2,
               error_message = $3, connection_recovery = NULL, updated_at = now()
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
      const updated = await client.query<AccountReportRow>(
        `UPDATE account_reports
         SET status = 'submitted', discord_report_id = $2,
             connection_recovery = NULL,
             receipt_deadline = now() + interval '120 seconds', updated_at = now()
         WHERE id = $1 AND status = 'submitting'
         RETURNING *`,
        [job.report_id, discordReportId]
      );
      const row = updated.rows[0];
      if (row === undefined) throw new Error("Submitting report could not be persisted.");
      await client.query(
        `UPDATE account_report_jobs SET state = 'completed', locked_at = NULL, updated_at = now()
         WHERE id = $1 AND report_id = $2 AND attempts = $3 AND state = 'running'`,
        [job.id, job.report_id, job.execution_token]
      );
      const pending = await client.query<InboundMessageRow>(
        `SELECT message_id, report_id, recipient, status, external_report_id, external_status,
                encrypted_payload, received_at
         FROM account_inbound_messages
         WHERE external_report_id = $1 AND recipient = $2 AND status = 'pending_report'
         ORDER BY received_at, message_id FOR UPDATE`,
        [discordReportId, row.reporter_email]
      );
      await insertEvent(client, row.account_id, job.report_id, "report_submitted", row.lifecycle_attempt);
      for (const inbound of pending.rows) {
        // Multiple messages can be pending when the submission result arrives.
        // Apply each against the state produced by earlier messages so an
        // older `received` email cannot downgrade a later `actioned` outcome.
        const current = await client.query<AccountReportRow>(
          "SELECT * FROM account_reports WHERE id = $1",
          [job.report_id]
        );
        const currentReport = current.rows[0];
        if (currentReport !== undefined) await this.applyInboundMessage(client, currentReport, inbound);
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
      const locked = await client.query<AccountReportRow>(
         `SELECT * FROM account_reports WHERE id = $1 AND discord_report_id = $2`,
        [job.report_id, discordReportId]
      );
      const row = locked.rows[0];
      if (row === undefined) throw new Error("Report is no longer waiting for automatic appeal submission.");
      if (row.review_status === "queued") {
        await client.query(
          `UPDATE account_reports
           SET review_status = 'requested', review_status_updated_at = now(),
               review_confirmation_deadline = now() + interval '2 minutes',
               review_error_code = NULL, review_error_message = NULL, updated_at = now()
           WHERE id = $1`,
          [job.report_id]
        );
        await insertEvent(client, row.account_id, job.report_id, "review_requested", row.lifecycle_attempt);
      } else if (!new Set(["received", "approved", "not_approved"]).has(row.review_status ?? "")) {
        throw new Error("Report is no longer waiting for automatic appeal submission.");
      }
      await client.query(
        `UPDATE account_report_jobs SET state = 'completed', locked_at = NULL, updated_at = now()
         WHERE id = $1 AND report_id = $2 AND attempts = $3 AND state = 'running'`,
        [job.id, job.report_id, job.execution_token]
      );
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
    // The 7-day expiry sweep used to run before every single claim, adding an
    // extra write on the hot path for each of the (now concurrent) delivery
    // loops. Throttle it to at most once a minute per repository instance.
    const now = Date.now();
    if (now - this.lastDeliveryExpiryAt >= 60_000) {
      // Claim the throttle slot synchronously (before the await below) so
      // concurrent delivery loops calling this at nearly the same instant
      // cannot all observe the stale timestamp and each run the sweep.
      this.lastDeliveryExpiryAt = now;
      await this.pool.query(
        `UPDATE event_destination_deliveries SET state = 'expired', locked_at = NULL, updated_at = now()
         WHERE state IN ('pending', 'sending') AND created_at < now() - interval '7 days'`
      );
    }
    const result = await this.pool.query<AccountEventDelivery & QueryResultRow>(
      `WITH candidate AS (
         SELECT delivery.event_id, delivery.destination_id
         FROM event_destination_deliveries AS delivery
         JOIN webhook_destinations AS destination ON destination.id = delivery.destination_id
         JOIN account_report_events AS event ON event.id = delivery.event_id
         WHERE destination.status = 'active'
           AND delivery.run_at <= now()
           AND (delivery.state = 'pending' OR (delivery.state = 'sending' AND delivery.locked_at < now() - interval '2 minutes'))
           AND NOT EXISTS (
             SELECT 1 FROM event_destination_deliveries AS blocker
             JOIN account_report_events AS blocker_event ON blocker_event.id = blocker.event_id
             WHERE blocker.destination_id = delivery.destination_id
               AND blocker.event_id < delivery.event_id
               AND blocker.state IN ('pending', 'sending')
               AND blocker_event.report_id = event.report_id
           )
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
      const recipient = input.recipient.toLowerCase();
      const candidate = await client.query<{ id: string }>(
        `SELECT id FROM account_reports
         WHERE reporter_email = $1
           AND status IN ('requesting_verification', 'awaiting_verification', 'verification_received')`,
        [recipient]
      );
      const candidateId = candidate.rows[0]?.id;
      const lockedCandidateId = candidateId !== undefined && await lockReportMutationParents(client, candidateId)
        ? candidateId
        : undefined;
      const reportResult = await client.query<{
        id: string;
        trace_id: string;
        account_id: string;
        lifecycle_attempt: number;
      }>(
        `SELECT id, trace_id, account_id, lifecycle_attempt FROM account_reports
         WHERE id = $1
           AND reporter_email = $2
           AND status IN ('requesting_verification', 'awaiting_verification', 'verification_received')`,
        [lockedCandidateId ?? null, recipient]
      );
      const report = reportResult.rows[0];
      const inserted = await client.query(
        `INSERT INTO account_inbound_messages (message_id, report_id, recipient, status)
         VALUES ($1, $2, $3, $4) ON CONFLICT (message_id) DO NOTHING
         RETURNING message_id`,
        [input.messageId, report?.id ?? null, recipient, report === undefined ? "unknown_recipient" : "accepted"]
      );
      if (inserted.rowCount === 0) {
        const duplicate = await duplicateInboundReport(client, input.messageId);
        await client.query("COMMIT");
        return { status: "duplicate", reportId: duplicate?.id ?? report?.id ?? null, traceId: duplicate?.trace_id ?? report?.trace_id ?? null };
      }
      if (report === undefined) {
        await client.query("COMMIT");
        return { status: "unknown_recipient", reportId: null, traceId: null };
      }
      await client.query(
        `INSERT INTO account_report_jobs
           (report_id, kind, dedupe_key, payload, max_attempts, run_at)
         VALUES ($1, 'verify_submit', $2, $3, 3, now() + interval '3 seconds')
         ON CONFLICT (dedupe_key) DO UPDATE
         SET payload = account_report_jobs.payload || EXCLUDED.payload,
             state = 'pending', run_at = EXCLUDED.run_at,
             locked_at = NULL, last_error = NULL, updated_at = now()
         WHERE account_report_jobs.state = 'pending'`,
        [report.id, `verify-submit:${report.id}:${report.lifecycle_attempt}`, { encryptedCode: input.encryptedCode }]
      );
      await client.query(
        `UPDATE account_reports SET status = 'verification_received',
           verification_deadline = NULL, connection_recovery = NULL, updated_at = now() WHERE id = $1`,
        [report.id]
      );
      await insertEvent(client, report.account_id, report.id, "verification_received", report.lifecycle_attempt);
      await client.query("COMMIT");
      return { status: "accepted", reportId: report.id, traceId: report.trace_id };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      (client).release();
    }
  }

  private async applyInboundMessage(
    client: PoolClient,
    report: AccountReportRow,
    message: InboundMessageRow
  ): Promise<InboundApplicationResult> {
    if (
      report.reporter_email === null || report.discord_report_id === null ||
      report.reporter_email.toLowerCase() !== message.recipient.toLowerCase() ||
      report.discord_report_id !== message.external_report_id || message.external_status === null
    ) return "deferred";

    if (message.external_status === "review_received") {
      const eligible = report.review_submission_started_at !== null || new Set([
        "requested", "confirmation_timeout", "request_failed", "request_ambiguous"
      ]).has(report.review_status ?? "");
      if (!eligible) return "deferred";
      if (new Set(["received", "approved", "not_approved"]).has(report.review_status ?? "")) {
        await this.consumeInboundMessage(client, report.id, message.message_id);
        return "consumed";
      }
      await client.query(
        `UPDATE account_reports SET review_status = 'received', review_status_updated_at = now(),
           review_confirmation_deadline = NULL, review_error_code = NULL,
           review_error_message = NULL, updated_at = now() WHERE id = $1`,
        [report.id]
      );
      await insertEvent(client, report.account_id, report.id, "review_received", report.lifecycle_attempt);
      await this.consumeInboundMessage(client, report.id, message.message_id);
      return "applied";
    }

    if (!shouldApplyDiscordStatus(report.discord_status, message.external_status)) {
      await this.consumeInboundMessage(client, report.id, message.message_id);
      return "consumed";
    }
    if (report.error_code === "discord_receipt_timeout") {
      await client.query(
        `UPDATE account_reports SET status = 'submitted', failure_stage = NULL,
           error_code = NULL, error_message = NULL, connection_recovery = NULL, updated_at = now() WHERE id = $1`,
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
      [report.id, message.external_status]
    );
    await insertEvent(client, report.account_id, report.id, `discord:${message.external_status}`, report.lifecycle_attempt);
    if (message.external_status === "closed_no_action" && message.encrypted_payload !== null && report.review_status === null) {
      await client.query(
        `UPDATE account_reports SET review_status = 'queued', review_status_updated_at = now(),
           review_error_code = NULL, review_error_message = NULL, updated_at = now()
         WHERE id = $1 AND review_status IS NULL`,
        [report.id]
      );
      await client.query(
        `INSERT INTO account_report_jobs (report_id, kind, dedupe_key, payload, max_attempts)
         VALUES ($1, 'submit_review', $2, $3, 3) ON CONFLICT (dedupe_key) DO NOTHING`,
        [report.id, `submit-review:${report.id}`, { encryptedReviewUrl: message.encrypted_payload }]
      );
      await insertEvent(client, report.account_id, report.id, "review_queued", report.lifecycle_attempt);
    }
    await this.consumeInboundMessage(client, report.id, message.message_id);
    return "applied";
  }

  public async recordDiagnostic(input: {
    reportId?: string; traceId?: string; service: string; severity: string; event: string;
    stage?: string; outcome?: string; lifecycleAttempt?: number; reporterEmail?: string;
    errorCode?: string; details?: unknown;
  }): Promise<void> {
    const details = boundedDiagnostic(input.details ?? {});
    await this.pool.query(
      `INSERT INTO account_report_diagnostics
       (report_id, trace_id, service, severity, event, stage, outcome, lifecycle_attempt, reporter_email, error_code, details)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [input.reportId ?? null, input.traceId ?? null, input.service, input.severity, input.event,
        input.stage ?? null, input.outcome ?? null, input.lifecycleAttempt ?? null, input.reporterEmail ?? null,
        input.errorCode ?? null, details]
    );
  }

  public async recordWorkerEmailDiagnostic(input: {
    recipient: string;
    event: string;
    details?: unknown;
  }): Promise<void> {
    const result = await this.pool.query<{ id: string; trace_id: string; lifecycle_attempt: number }>(
      `SELECT id, trace_id, lifecycle_attempt FROM account_reports
       WHERE reporter_email = $1 ORDER BY created_at DESC LIMIT 1`,
      [input.recipient]
    );
    const report = result.rows[0];
    await this.recordDiagnostic({
      ...(report === undefined ? {} : {
        reportId: report.id, traceId: report.trace_id, lifecycleAttempt: report.lifecycle_attempt
      }),
      service: "email-worker", severity: "error", event: input.event,
      stage: "email_forward", outcome: "failed", reporterEmail: input.recipient,
      details: input.details
    });
  }

  public async purgeDiagnostics(): Promise<void> {
    await this.pool.query("DELETE FROM account_report_diagnostics WHERE created_at < now() - interval '30 days'");
    await this.pool.query("DELETE FROM account_rate_limit_windows WHERE window_start < now() - interval '1 day'");
    await this.pool.query(
      "DELETE FROM event_destination_deliveries WHERE state IN ('sent', 'expired') AND updated_at < now() - interval '30 days'"
    );
    await this.pool.query(
      "DELETE FROM account_report_jobs WHERE state IN ('completed', 'failed') AND updated_at < now() - interval '30 days'"
    );
  }

  // Adopts a report stuck as status='failed', error_code='ambiguous_submission_state'
  // (discord_report_id never recorded because the final submission HTTP call
  // outcome was uncertain) once a later Discord lifecycle email proves the
  // submission actually reached Discord as `discordReportId`. Credits were
  // already consumed at submission start, so nothing changes there.
  private async adoptAmbiguousReport(
    client: PoolClient,
    reportId: string,
    accountId: string,
    lifecycleAttempt: number,
    discordReportId: string
  ): Promise<AccountReportRow | undefined> {
    const updated = await client.query<AccountReportRow>(
      `UPDATE account_reports SET discord_report_id = $2, status = 'submitted',
         failure_stage = NULL, error_code = NULL, error_message = NULL, updated_at = now()
       WHERE id = $1 AND discord_report_id IS NULL AND error_code = 'ambiguous_submission_state'
       RETURNING *`,
      [reportId, discordReportId]
    );
    const row = updated.rows[0];
    if (row !== undefined) {
      await insertEvent(client, accountId, reportId, "report_receipt_recovered", lifecycleAttempt);
    }
    return row;
  }

  private async consumeInboundMessage(client: PoolClient, reportId: string, messageId: string): Promise<void> {
    await client.query(
      `UPDATE account_inbound_messages SET report_id = $2, status = 'accepted'
       WHERE message_id = $1`,
      [messageId, reportId]
    );
  }

  public async registerReportUpdateEmail(input: {
    messageId: string;
    recipient: string;
    discordReportId: string;
    discordStatus: "received" | "actioned" | "closed_no_action" | "review_not_approved";
    encryptedReviewUrl?: string;
  }): Promise<InboundEmailRegistration> {
    return this.registerInboundLifecycleEmail({ ...input, externalStatus: input.discordStatus, encryptedPayload: input.encryptedReviewUrl ?? null });
  }

  public async registerReviewUpdateEmail(input: {
    messageId: string;
    recipient: string;
    discordReportId: string;
  }): Promise<InboundEmailRegistration> {
    return this.registerInboundLifecycleEmail({ ...input, externalStatus: "review_received", encryptedPayload: null });
  }

  private async registerInboundLifecycleEmail(input: {
    messageId: string;
    recipient: string;
    discordReportId: string;
    externalStatus: InboundExternalStatus;
    encryptedPayload: string | null;
  }): Promise<InboundEmailRegistration> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const recipient = input.recipient.toLowerCase();
      const candidate = await client.query<{ id: string }>(
        "SELECT id FROM account_reports WHERE reporter_email = $1",
        [recipient]
      );
      const candidateId = candidate.rows[0]?.id;
      const lockedCandidateId = candidateId !== undefined && await lockReportMutationParents(client, candidateId)
        ? candidateId
        : undefined;
      const reportResult = await client.query<AccountReportRow>(
        "SELECT * FROM account_reports WHERE id = $1 AND reporter_email = $2",
        [lockedCandidateId ?? null, recipient]
      );
      let report = reportResult.rows[0];
      if (report !== undefined && input.externalStatus !== "review_received" && isAdoptableAmbiguousReport(report)) {
        // reporter_email is UNIQUE per report, so this locked row is already
        // proven to be the submission this email belongs to even though the
        // ambiguous final HTTP outcome never recorded a discord_report_id.
        report = (await this.adoptAmbiguousReport(client, report.id, report.account_id, report.lifecycle_attempt, input.discordReportId)) ?? report;
      }
      // A recipient is only a lock/candidate key. Persisting an association is
      // allowed only after the Discord report ID agrees as well.
      const exactReport = report?.discord_report_id === input.discordReportId ? report : undefined;
      const inserted = await client.query(
        `INSERT INTO account_inbound_messages
           (message_id, report_id, recipient, status, external_report_id, external_status, encrypted_payload)
         VALUES ($1, $2, $3, 'pending_report', $4, $5, $6)
         ON CONFLICT (message_id) DO NOTHING RETURNING message_id`,
        [input.messageId, exactReport?.id ?? null, recipient, input.discordReportId, input.externalStatus, input.encryptedPayload]
      );
      if (inserted.rowCount === 0) {
        const duplicate = await client.query<InboundMessageRow>(
          `SELECT message_id, report_id, recipient, status, external_report_id, external_status,
                  encrypted_payload, received_at
           FROM account_inbound_messages WHERE message_id = $1 FOR UPDATE`,
          [input.messageId]
        );
        const stored = duplicate.rows[0];
        if (
          stored?.status === "pending_report" &&
          stored.recipient === recipient &&
          stored.external_report_id === input.discordReportId &&
          exactReport !== undefined
        ) {
          const applied = await this.applyInboundMessage(client, exactReport, stored);
          await client.query("COMMIT");
          return applied === "deferred"
            ? { status: "pending_report", reportId: null, traceId: null }
            : { status: "accepted", reportId: exactReport.id, traceId: exactReport.trace_id };
        }
        await client.query("COMMIT");
        const prior = await duplicateInboundReport(client, input.messageId);
        return { status: "duplicate", reportId: prior?.id ?? report?.id ?? null, traceId: prior?.trace_id ?? report?.trace_id ?? null };
      }
      if (exactReport === undefined) {
        await client.query("COMMIT");
        return { status: "pending_report", reportId: null, traceId: null };
      }
      const inbound: InboundMessageRow = {
        message_id: input.messageId, report_id: exactReport.id, recipient, status: "pending_report",
        external_report_id: input.discordReportId, external_status: input.externalStatus,
        encrypted_payload: input.encryptedPayload, received_at: new Date()
      };
      const applied = await this.applyInboundMessage(client, exactReport, inbound);
      await client.query("COMMIT");
      return applied === "deferred"
        ? { status: "pending_report", reportId: null, traceId: null }
        : { status: "accepted", reportId: exactReport.id, traceId: exactReport.trace_id };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      (client).release();
    }
  }

  public async reconcilePendingInboundMessages(limit = 100): Promise<InboundReconciliationResult> {
    // Reconcile in one-report transactions. Holding several report/message
    // rows before writing the first event can invert the event feed's global
    // publication lock when a transaction later needs another report.
    const ambiguousReports = await this.pool.query<{ id: string }>(
      `SELECT report.id
       FROM account_reports AS report
       WHERE report.discord_report_id IS NULL
         AND report.error_code = 'ambiguous_submission_state'
         AND report.submission_started_at IS NOT NULL
         AND EXISTS (
           SELECT 1 FROM account_inbound_messages AS message
           WHERE message.recipient = report.reporter_email
             AND message.status = 'pending_report'
             AND message.external_status IS DISTINCT FROM 'review_received'
             AND message.external_report_id IS NOT NULL
         )
       ORDER BY report.created_at, report.id`
    );
    for (const candidate of ambiguousReports.rows) {
      const client = await this.pool.connect();
      try {
        await client.query("BEGIN");
        if (!(await lockReportMutationParents(client, candidate.id))) {
          await client.query("COMMIT");
          continue;
        }
        const current = await client.query<{
          id: string; account_id: string; lifecycle_attempt: number; reporter_email: string;
        }>(
          `SELECT id, account_id, lifecycle_attempt, reporter_email
           FROM account_reports
           WHERE id = $1 AND discord_report_id IS NULL
             AND error_code = 'ambiguous_submission_state'
             AND submission_started_at IS NOT NULL`,
          [candidate.id]
        );
        const report = current.rows[0];
        if (report === undefined) {
          await client.query("COMMIT");
          continue;
        }
        const oldest = await client.query<{ message_id: string; external_report_id: string }>(
          `SELECT message_id, external_report_id FROM account_inbound_messages
           WHERE recipient = $1 AND status = 'pending_report'
             AND external_status IS DISTINCT FROM 'review_received'
             AND external_report_id IS NOT NULL
           ORDER BY received_at, message_id LIMIT 1 FOR UPDATE`,
          [report.reporter_email]
        );
        const message = oldest.rows[0];
        if (message !== undefined) {
          await this.adoptAmbiguousReport(
            client, report.id, report.account_id, report.lifecycle_attempt, message.external_report_id
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

    const boundedLimit = Math.max(1, Math.min(1000, Math.floor(limit)));
    const candidates = await this.pool.query<{
      id: string; report_id: string; recipient: string; external_report_id: string | null;
    }>(
      `SELECT message.message_id AS id, report.id AS report_id,
              message.recipient, message.external_report_id
       FROM account_inbound_messages AS message
       JOIN account_reports AS report
         ON report.discord_report_id = message.external_report_id
        AND report.reporter_email = message.recipient
       WHERE message.status = 'pending_report'
       ORDER BY message.received_at, message.message_id
       LIMIT $1`,
      [boundedLimit]
    );
    let processed = 0;
    for (const candidate of candidates.rows) {
      const client = await this.pool.connect();
      try {
        await client.query("BEGIN");
        if (!(await lockReportMutationParents(client, candidate.report_id))) {
          await client.query("COMMIT");
          continue;
        }
        const current = await client.query<AccountReportRow>(
          `SELECT * FROM account_reports
           WHERE id = $1 AND reporter_email = $2 AND discord_report_id = $3`,
          [candidate.report_id, candidate.recipient, candidate.external_report_id]
        );
        const report = current.rows[0];
        if (report === undefined) {
          await client.query("COMMIT");
          continue;
        }
        const pending = await client.query<InboundMessageRow>(
          `SELECT message_id, report_id, recipient, status, external_report_id, external_status,
                  encrypted_payload, received_at
           FROM account_inbound_messages
           WHERE message_id = $1 AND status = 'pending_report'
           FOR UPDATE`,
          [candidate.id]
        );
        const message = pending.rows[0];
        if (message !== undefined && (await this.applyInboundMessage(client, report, message)) !== "deferred") {
          processed += 1;
        }
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    }

    const backlog = await this.pool.query<{ remaining: string; oldest_ms: string | null }>(
      `SELECT count(*)::text AS remaining,
              extract(epoch FROM (now() - min(received_at))) * 1000 AS oldest_ms
       FROM account_inbound_messages WHERE status = 'pending_report'`
    );
    return {
      processed,
      remaining: count(backlog.rows[0]?.remaining),
      oldestPendingAgeMs: age(backlog.rows[0]?.oldest_ms)
    };
  }
}

interface LockedCreditRow extends QueryResultRow {
  account_id: string;
  credit_chain_id: string;
  credit_state: "available" | "reserved" | "consumed" | "released";
  account_status: "active" | "suspended";
  status: ReportStatus;
  lifecycle_attempt: number;
  flow: CreateReportInput["flow"];
  session_state: string | null;
  use_ai: boolean;
  request_input: CreateReportInput;
  prepared_input: Record<string, unknown> | null;
  legal_reference: string | null;
  research_summary: string | null;
  research_sources: unknown[];
  retry_sequence: number;
  submission_started_at: Date | null;
  discord_report_id: string | null;
  successor_report_id: string | null;
  automatic_network_restarts: number;
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
  if (!(await lockReportMutationParents(client, job.report_id))) return false;
  const result = await client.query(
    `SELECT 1 FROM account_report_jobs
     WHERE id = $1 AND report_id = $2 AND kind = $3 AND attempts = $4 AND state = 'running'
     FOR UPDATE`,
    [job.id, job.report_id, job.kind, job.execution_token]
  );
  return result.rowCount === 1;
}

async function settleSupersededRequestJob(
  client: PoolClient,
  job: LifecycleJob,
  report: LockedCreditRow,
  encryptedSession?: string,
  allowPending = false
): Promise<boolean> {
  if (
    job.kind !== "request_code" ||
    (report.status === "requesting_verification" && report.submission_started_at === null)
  ) return false;

  if (
    report.status === "verification_received" && report.submission_started_at === null &&
    report.session_state === null && encryptedSession !== undefined
  ) {
    await client.query(
      `UPDATE account_reports SET session_state = COALESCE(session_state, $2), updated_at = now()
       WHERE id = $1 AND status = 'verification_received' AND submission_started_at IS NULL`,
      [job.report_id, encryptedSession]
    );
  }
  const completed = await client.query(
    `UPDATE account_report_jobs SET state = 'completed', locked_at = NULL, updated_at = now()
     WHERE id = $1 AND report_id = $2 AND attempts = $3
       AND (state = 'running' OR ($4::boolean AND state = 'pending')) RETURNING id`,
    [job.id, job.report_id, job.execution_token, allowPending]
  );
  if (completed.rowCount !== 1) throw new Error("Superseded request-code job could not be completed.");
  return true;
}

async function ownsPreparationJob(
  client: PoolClient,
  jobId: string,
  reportId: string,
  executionToken: number
): Promise<boolean> {
  if (!(await lockReportMutationParents(client, reportId))) return false;
  const result = await client.query(
    `SELECT 1 FROM account_report_jobs
     WHERE id = $1 AND report_id = $2 AND attempts = $3
       AND kind = 'prepare_report' AND state = 'running'
     FOR UPDATE`,
    [jobId, reportId, executionToken]
  );
  return result.rowCount === 1;
}

/**
 * Lock every parent row before taking a worker job lock or writing a lifecycle
 * event. The event trigger takes FK KEY SHARE locks on the account and report
 * before the global publication advisory lock; NO KEY UPDATE keeps those
 * checks compatible while serializing non-key mutations on the same rows.
 */
async function lockReportMutationParents(client: PoolClient, reportId: string): Promise<boolean> {
  const owner = await client.query<{ account_id: string; credit_chain_id: string }>(
    "SELECT account_id, credit_chain_id FROM account_reports WHERE id = $1",
    [reportId]
  );
  const row = owner.rows[0];
  if (row === undefined) return false;

  const account = await client.query(
    "SELECT 1 FROM api_accounts WHERE id = $1 FOR NO KEY UPDATE",
    [row.account_id]
  );
  if (account.rowCount !== 1) return false;
  const report = await client.query(
    `SELECT 1 FROM account_reports
     WHERE id = $1 AND account_id = $2 AND credit_chain_id = $3
     FOR NO KEY UPDATE`,
    [reportId, row.account_id, row.credit_chain_id]
  );
  if (report.rowCount !== 1) return false;
  const chain = await client.query(
    `SELECT 1 FROM report_credit_chains
     WHERE id = $1 AND account_id = $2 FOR NO KEY UPDATE`,
    [row.credit_chain_id, row.account_id]
  );
  return chain.rowCount === 1;
}

async function duplicateInboundReport(client: PoolClient, messageId: string): Promise<{ id: string; trace_id: string } | undefined> {
  const result = await client.query<{ id: string; trace_id: string }>(
    `SELECT report.id, report.trace_id
     FROM account_inbound_messages AS message
     JOIN account_reports AS report ON report.id = message.report_id
     WHERE message.message_id = $1`,
    [messageId]
  );
  return result.rows[0];
}

type InboundExternalStatus = DiscordReportStatus | "review_received";
type InboundApplicationResult = "applied" | "consumed" | "deferred";

interface InboundMessageRow extends QueryResultRow {
  message_id: string;
  report_id: string | null;
  recipient: string;
  status: string;
  external_report_id: string | null;
  external_status: InboundExternalStatus | null;
  encrypted_payload: string | null;
  received_at: Date;
}

export interface InboundReconciliationResult {
  processed: number;
  remaining: number;
  oldestPendingAgeMs: number | null;
}

async function lockReportCredit(client: PoolClient, reportId: string): Promise<LockedCreditRow | undefined> {
  const result = await client.query<LockedCreditRow>(
    `SELECT report.account_id, report.credit_chain_id, report.status, report.lifecycle_attempt,
            report.flow, report.session_state, report.use_ai, report.request_input, report.prepared_input,
            report.legal_reference, report.research_summary, report.research_sources,
            report.retry_sequence, report.submission_started_at, report.discord_report_id,
            report.successor_report_id, report.automatic_network_restarts,
            chain.state AS credit_state, account.status AS account_status
     FROM account_reports AS report
     JOIN report_credit_chains AS chain ON chain.id = report.credit_chain_id
     JOIN api_accounts AS account ON account.id = report.account_id
     WHERE report.id = $1`,
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

async function eligibleAutomaticNetworkRestart(
  client: PoolClient,
  job: LifecycleJob,
  report: LockedCreditRow,
  code: string
): Promise<boolean> {
  if (
    (job.kind !== "request_code" && job.kind !== "verify_submit") ||
    report.account_status !== "active" ||
    (job.kind === "request_code" && report.status !== "requesting_verification") ||
    (job.kind === "verify_submit" && report.status !== "verifying") ||
    report.submission_started_at !== null ||
    report.discord_report_id !== null ||
    report.successor_report_id !== null ||
    report.automatic_network_restarts !== 0 ||
    (report.credit_state !== "reserved" && report.credit_state !== "consumed") ||
    !isSafePreparedInput(report.prepared_input) ||
    !(code === "discord_network_error" || /^discord_http_5\d\d$/.test(code))
  ) {
    return false;
  }
  const owned = await client.query<{ kind: string; attempts: number; max_attempts: number }>(
    `SELECT kind, attempts, max_attempts FROM account_report_jobs
     WHERE id = $1 AND report_id = $2 AND kind = $3 AND attempts = $4
       AND max_attempts = $5 AND state = 'running' FOR UPDATE`,
    [job.id, job.report_id, job.kind, job.attempts, job.max_attempts]
  );
  const actual = owned.rows[0];
  return actual !== undefined && actual.kind === job.kind &&
    actual.attempts >= actual.max_attempts && actual.attempts === job.attempts && job.attempts >= job.max_attempts;
}

function isSafePreparedInput(value: Record<string, unknown> | null): boolean {
  return value !== null &&
    typeof value.country === "string" &&
    typeof value.category === "string" &&
    typeof value.description === "string" &&
    typeof value.finalText === "string";
}

async function createAutomaticNetworkSuccessor(
  client: PoolClient,
  job: LifecycleJob,
  predecessor: LockedCreditRow,
  code: string,
  message: string
): Promise<boolean> {
  const reportId = randomUUID();
  const traceId = randomUUID();
  const idempotencyKey = `automatic-network-restart:${job.report_id}`;
  const requestHash = createHash("sha256")
    .update(JSON.stringify({ predecessorReportId: job.report_id, automaticNetworkRestart: true }))
    .digest("hex");
  const recovery: ReportConnectionRecovery = {
    state: "restarting",
    attempt: job.attempts,
    maxAttempts: job.max_attempts,
    retryAt: null,
    successorReportId: reportId
  };
  const failed = await client.query(
    `UPDATE account_reports
     SET status = 'failed', failure_stage = status, error_code = $2, error_message = $3,
         connection_recovery = $4::jsonb,
         updated_at = now()
     WHERE id = $1 AND status <> 'failed' AND successor_report_id IS NULL
       AND automatic_network_restarts = 0 AND submission_started_at IS NULL
     RETURNING id`,
    [job.report_id, code, message, JSON.stringify(recovery)]
  );
  if (failed.rowCount !== 1) return false;
  const inserted = await client.query(
    `INSERT INTO account_reports
       (id, trace_id, account_id, idempotency_key, request_hash, flow, use_ai, request_input,
        prepared_input, legal_reference, research_summary, research_sources,
        credit_chain_id, predecessor_report_id, retry_mode, retry_sequence,
        lifecycle_attempt, status, automatic_network_restarts)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
             $13, $14, 'reuse', $15, $16, 'queued', 1)
     RETURNING id`,
    [
      reportId, traceId, predecessor.account_id, idempotencyKey, requestHash,
      predecessor.flow, predecessor.use_ai, predecessor.request_input, predecessor.prepared_input,
      predecessor.legal_reference, predecessor.research_summary, JSON.stringify(predecessor.research_sources),
      predecessor.credit_chain_id, job.report_id, predecessor.retry_sequence + 1,
      predecessor.lifecycle_attempt + 1
    ]
  );
  if (inserted.rowCount !== 1) throw new Error("Automatic network retry successor was not created.");
  const linked = await client.query(
    `UPDATE account_reports SET successor_report_id = $2, updated_at = now()
     WHERE id = $1 AND successor_report_id IS NULL AND automatic_network_restarts = 0
     RETURNING id`,
    [job.report_id, reportId]
  );
  if (linked.rowCount !== 1) throw new Error("Automatic network retry successor could not be linked.");
  await client.query(
    `UPDATE account_report_jobs SET state = 'failed', locked_at = NULL,
       last_error = $2, updated_at = now()
     WHERE report_id = $1 AND kind IN ('request_code', 'verify_submit')
       AND state IN ('pending', 'running')`,
    [job.report_id, code]
  );
  await client.query(
    `INSERT INTO account_report_jobs (report_id, kind, dedupe_key, max_attempts)
     VALUES ($1, 'prepare_report', $2, 3)`,
    [reportId, `prepare:${reportId}`]
  );
  await insertEvent(client, predecessor.account_id, job.report_id, "report_connection_restarting", predecessor.lifecycle_attempt, {
    attempt: job.attempts,
    maxAttempts: job.max_attempts,
    successorReportId: reportId
  });
  await insertEvent(client, predecessor.account_id, reportId, "report_queued", predecessor.lifecycle_attempt + 1, {
    retryMode: "reuse",
    predecessorReportId: job.report_id,
    automaticNetworkRestart: true
  });
  return true;
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

function diagnosticTimestamp(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const timestamp = value instanceof Date ? value : new Date(value);
  return Number.isNaN(timestamp.getTime()) ? null : timestamp.toISOString();
}

function safeDiagnosticLabel(value: string, allowed: readonly string[]): string {
  return allowed.includes(value) ? value : "other";
}

function safeDiagnosticJobKind(value: string): string {
  return safeDiagnosticLabel(value, ["prepare_report", "request_code", "verify_submit", "submit_review"]);
}

function safeDiagnosticJobState(value: string): string {
  return safeDiagnosticLabel(value, ["pending", "running", "completed", "failed"]);
}

function safeDiagnosticErrorCategory(value: string | null): string | null {
  return value === null ? null : safeDiagnosticLabel(value, [
    "account_suspended", "ambiguous_submission", "preparation_failure", "review_failure",
    "discord_http_failure", "discord_network_failure", "discord_lifecycle_failure", "worker_failure"
  ]);
}

function safeDiagnosticInboundStatus(value: string): string {
  return safeDiagnosticLabel(value, ["pending_report", "accepted", "unknown_recipient"]);
}

function safeDiagnosticExternalStatus(value: string | null): string | null {
  return value === null ? null : safeDiagnosticLabel(value, [
    "received", "actioned", "closed_no_action", "review_not_approved", "review_received"
  ]);
}

function safeDiagnosticReviewStatus(value: string | null): string | null {
  return value === null ? null : safeDiagnosticLabel(value, [
    "queued", "requested", "received", "confirmation_timeout", "request_failed", "ineligible",
    "request_ambiguous", "approved", "not_approved"
  ]);
}

function safeDiagnosticCreditState(value: string): string {
  return safeDiagnosticLabel(value, ["available", "reserved", "consumed", "released"]);
}

function safeDiagnosticStatus(value: string): string {
  return safeDiagnosticLabel(value, [
    "queued", "planning", "researching", "writing", "preparing", "requesting_verification",
    "awaiting_verification", "verification_received", "verifying", "submitting", "submitted", "failed"
  ]);
}

function safeDiagnosticErrorCode(value: string | null): string | null {
  return value === null ? null : /^[a-z0-9_.-]{1,80}$/.test(value) ? value : "other";
}

function safeDiagnosticExternalReportId(value: string | null): string | null {
  return value !== null && /^\d{1,32}$/.test(value) ? value : null;
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
  successor_report_id?: string | null;
}): Array<"reuse" | "regenerate" | "rewrite_ai" | "edit_manual"> {
  if (report.successor_report_id != null) return [];
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

function isAdoptableAmbiguousReport(report: {
  discord_report_id: string | null;
  error_code: string | null;
  submission_started_at: Date | null;
}): boolean {
  return report.discord_report_id === null
    && report.error_code === "ambiguous_submission_state"
    && report.submission_started_at !== null;
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
  kind: "report_mutation",
  window: "minute",
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
