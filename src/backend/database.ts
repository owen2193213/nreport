import { Pool } from "pg";
import type { PoolClient, QueryResultRow } from "pg";

import type { ReportFlow } from "../types.js";
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

export interface ReportRow extends QueryResultRow {
  id: string;
  idempotency_key: string;
  request_hash: string;
  flow: ReportFlow;
  country: string;
  report_type: string;
  reporter_legal_name: string;
  reporter_email: string;
  timezone: string;
  proxy_session_id: string;
  status: ReportStatus;
  input: CreateReportInput;
  session_state: string | null;
  discord_report_id: string | null;
  error_code: string | null;
  error_message: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface JobRow extends QueryResultRow {
  id: string;
  report_id: string;
  kind: "request_code" | "verify_submit";
  payload: Record<string, unknown>;
  attempts: number;
  max_attempts: number;
}

export interface CreateReportRecord {
  id: string;
  idempotencyKey: string;
  requestHash: string;
  input: CreateReportInput;
  legalName: string;
  email: string;
  timezone: string;
  proxySessionId: string;
}

export interface CreateReportResult {
  created: boolean;
  report: ReportRow;
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS reports (
  id text PRIMARY KEY,
  idempotency_key text NOT NULL UNIQUE,
  request_hash text NOT NULL,
  flow text NOT NULL CHECK (flow IN ('user_urf', 'message_urf', 'guild_urf')),
  country char(2) NOT NULL,
  report_type text NOT NULL,
  reporter_legal_name text NOT NULL,
  reporter_email text NOT NULL UNIQUE,
  timezone text NOT NULL,
  proxy_session_id text NOT NULL,
  status text NOT NULL,
  input jsonb NOT NULL,
  session_state text,
  discord_report_id text,
  error_code text,
  error_message text,
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
  kind text NOT NULL CHECK (kind IN ('request_code', 'verify_submit')),
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
  received_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS report_jobs_claim_idx ON report_jobs(state, run_at, id);
CREATE INDEX IF NOT EXISTS report_events_report_idx ON report_events(report_id, created_at);
CREATE INDEX IF NOT EXISTS reports_email_status_idx ON reports(reporter_email, status);
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
               updated_at = now()
           WHERE id = $1 AND status <> 'submitted'`,
          [row.report_id]
        );
        await this.event(client, row.report_id, "report_failed", {
          errorCode: "ambiguous_submission_state"
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

  public async close(): Promise<void> {
    await this.pool.end();
  }

  private async event(
    client: PoolClient,
    reportId: string,
    eventType: string,
    metadata: Record<string, unknown> = {}
  ): Promise<void> {
    await client.query(
      "INSERT INTO report_events (report_id, event_type, metadata) VALUES ($1, $2, $3)",
      [reportId, eventType, metadata]
    );
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
          reporter_legal_name, reporter_email, timezone, proxy_session_id, status, input
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'queued', $11)
        RETURNING *`,
        [
          record.id,
          record.idempotencyKey,
          record.requestHash,
          record.input.flow,
          record.input.country,
          record.input.reportType,
          record.legalName,
          record.email,
          record.timezone,
          record.proxySessionId,
          record.input
        ]
      );
      await client.query(
        `INSERT INTO report_jobs (report_id, kind, dedupe_key, max_attempts)
         VALUES ($1, 'request_code', $2, 2)`,
        [record.id, `${record.id}:request-code`]
      );
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
         SET status = $2, error_code = NULL, error_message = NULL, updated_at = now()
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
    encryptedSessionState: string
  ): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `UPDATE reports
         SET status = 'awaiting_verification', session_state = $2, updated_at = now()
         WHERE id = $1`,
        [reportId, encryptedSessionState]
      );
      await this.event(client, reportId, "verification_requested");
      await client.query("COMMIT");
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
  }): Promise<"accepted" | "duplicate" | "unknown_recipient"> {
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
        return "duplicate";
      }
      if (!report) {
        await client.query("COMMIT");
        return "unknown_recipient";
      }
      await client.query(
        `INSERT INTO report_jobs (report_id, kind, dedupe_key, payload, max_attempts, run_at)
         VALUES ($1, 'verify_submit', $2, $3, 3, now() + interval '3 seconds')
         ON CONFLICT (dedupe_key) DO UPDATE
         SET payload = EXCLUDED.payload, state = 'pending', run_at = now(), updated_at = now()
         WHERE report_jobs.state = 'pending'`,
        [report.id, `${report.id}:verify-submit`, { encryptedCode: input.encryptedCode }]
      );
      await client.query(
        "UPDATE reports SET status = 'verification_received', updated_at = now() WHERE id = $1",
        [report.id]
      );
      await this.event(client, report.id, "verification_email_received");
      await client.query("COMMIT");
      return "accepted";
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

  public async failJobAndReport(
    job: JobRow,
    errorCode: string,
    message: string
  ): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "UPDATE report_jobs SET state = 'failed', last_error = $2, updated_at = now() WHERE id = $1",
        [job.id, message]
      );
      await client.query(
        `UPDATE reports
         SET status = 'failed', error_code = $2, error_message = $3, updated_at = now()
         WHERE id = $1`,
        [job.report_id, errorCode, message]
      );
      await this.event(client, job.report_id, "report_failed", { errorCode });
      await client.query("COMMIT");
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
             error_code = NULL, error_message = NULL, updated_at = now()
         WHERE id = $1`,
        [reportId, discordReportId]
      );
      await this.event(client, reportId, "report_submitted", { discordReportId });
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
