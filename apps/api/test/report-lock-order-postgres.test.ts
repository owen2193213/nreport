import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool, type QueryResult, type QueryResultRow } from "pg";

import { ACCOUNT_SCHEMA_SQL, AccountRepository } from "../src/accounts.js";
import { REPORT_SCHEMA_SQL, ReportRepository } from "../src/report-repository.js";
import type { LifecycleFailureSignal, LifecycleJob } from "../src/lifecycle-runner-v2.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const suite = databaseUrl === undefined ? describe.skip : describe;
const schema = `report_lock_order_${randomUUID().replaceAll("-", "")}`;
const adminPool = databaseUrl === undefined ? undefined : new Pool({ connectionString: databaseUrl });
let pool: Pool | undefined;

const createInput = {
  flow: "message" as const,
  useAi: true as const,
  target: {
    messageUrl: "https://discord.com/channels/@me/123456789012345678/123456789012345679"
  },
  description: "Controlled PostgreSQL lock-order fixture."
};

interface SubmissionStateRow extends QueryResultRow {
  status: string;
  submission_started_at: Date | null;
  credit_state: string;
  available_credits: number;
  reserved_credits: number;
  job_state: string;
  consumptions: number;
  releases: number;
}

interface Gate {
  reached: Promise<void>;
  release(): void;
}

function createGate(): { gate: Gate; arrive(): Promise<void> } {
  let markReached!: () => void;
  let release!: () => void;
  const reached = new Promise<void>((resolve) => { markReached = resolve; });
  const released = new Promise<void>((resolve) => { release = resolve; });
  return {
    gate: { reached, release },
    arrive: async () => {
      markReached();
      await released;
    }
  };
}

function instrumentPool(
  base: Pool,
  options: {
    pauseAfter?: (sql: string) => boolean;
    arrive?: () => Promise<void>;
  } = {}
): { pool: Pick<Pool, "connect" | "query">; connected: Promise<number> } {
  let markConnected!: (pid: number) => void;
  const connected = new Promise<number>((resolve) => { markConnected = resolve; });
  const baseQuery = base.query.bind(base);
  const instrumented: Pick<Pool, "connect" | "query"> = {
    query: baseQuery,
    connect: async () => {
      const client = await base.connect();
      const pidResult = await client.query<{ pid: number } & QueryResultRow>("SELECT pg_backend_pid() AS pid");
      const pid = pidResult.rows[0]?.pid;
      if (pid === undefined) throw new Error("PostgreSQL did not return a backend PID.");
      markConnected(pid);
      const originalQuery = client.query.bind(client);
      client.query = (async (...args: unknown[]): Promise<QueryResult> => {
        const result = await Reflect.apply(originalQuery, client, args) as QueryResult;
        const sql = typeof args[0] === "string" ? args[0] : "";
        if (options.pauseAfter?.(sql) === true) await options.arrive?.();
        return result;
      }) as typeof client.query;
      return client;
    }
  };
  return { pool: instrumented, connected };
}

async function waitForBlockedBackend(pid: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const result = await pool!.query<{ blockers: number[] }>(
      "SELECT pg_blocking_pids($1::int) AS blockers",
      [pid]
    );
    if ((result.rows[0]?.blockers.length ?? 0) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`PostgreSQL backend ${pid} did not reach a lock wait.`);
}

async function seedAccount(availableCredits: number): Promise<string> {
  const accountId = randomUUID();
  await pool!.query(
    `INSERT INTO api_accounts (id, username, username_normalized, available_credits)
     VALUES ($1, $2, $2, $3)`,
    [accountId, `test-${accountId.slice(0, 8)}`, availableCredits]
  );
  if (availableCredits > 0) {
    await pool!.query(
      `INSERT INTO credit_ledger (account_id, kind, available_delta, reserved_delta, reason)
       VALUES ($1, 'grant', $2, 0, 'PostgreSQL lock-order fixture')`,
      [accountId, availableCredits]
    );
  }
  return accountId;
}

async function seedVerifyingReport(accountId: string): Promise<{ reportId: string; job: LifecycleJob }> {
  const repository = new ReportRepository(pool!);
  const created = await repository.create(accountId, `create-${randomUUID()}`, createInput);
  await pool!.query("UPDATE account_reports SET status = 'verifying' WHERE id = $1", [created.report.id]);
  const jobResult = await pool!.query<{ id: string } & QueryResultRow>(
    `INSERT INTO account_report_jobs (report_id, kind, dedupe_key, state, attempts, max_attempts)
     VALUES ($1, 'verify_submit', $2, 'running', 1, 3) RETURNING id`,
    [created.report.id, `verify-${created.report.id}`]
  );
  return {
    reportId: created.report.id,
    job: {
      id: jobResult.rows[0]!.id,
      report_id: created.report.id,
      kind: "verify_submit",
      payload: {},
      attempts: 1,
      max_attempts: 3,
      execution_token: 1,
      trace_id: created.report.trace_id
    }
  };
}

async function prepareReportForConnectionRetry(reportId: string): Promise<void> {
  await pool!.query("UPDATE account_report_jobs SET state = 'completed' WHERE report_id = $1 AND kind = 'prepare_report'", [reportId]);
  await pool!.query(
    `UPDATE account_reports SET status = 'requesting_verification',
       prepared_input = $2, legal_reference = 'Prepared legal reference',
       research_summary = 'Prepared research', research_sources = $3,
       reporter_legal_name = 'Generated Name', reporter_email = $4,
       locale = 'de-DE', timezone = 'Europe/Berlin', language = 'de',
       proxy_session_id = 'old-proxy-session'
     WHERE id = $1`,
    [reportId, JSON.stringify({
      country: "DE", category: "sub_other_hate_speech",
      description: "Prepared description", finalText: "Prepared report text."
    }), JSON.stringify([{ title: "EUR-Lex", url: "https://eur-lex.europa.eu/" }]), `old-${reportId}@example.test`]
  );
}

async function seedLifecycleJob(
  reportId: string,
  traceId: string,
  kind: LifecycleJob["kind"],
  attempts = 3
): Promise<LifecycleJob> {
  const inserted = await pool!.query<{ id: string } & QueryResultRow>(
    `INSERT INTO account_report_jobs (report_id, kind, dedupe_key, state, attempts, max_attempts, locked_at)
     VALUES ($1, $2, $3, 'running', $4, 3, now()) RETURNING id`,
    [reportId, kind, `connection-recovery-${randomUUID()}`, attempts]
  );
  const id = inserted.rows[0]!.id;
  return {
    id, report_id: reportId, kind, payload: {}, attempts, max_attempts: 3,
    execution_token: attempts, trace_id: traceId
  };
}

async function delayOtherPendingLifecycleJobs(jobId: string): Promise<void> {
  await pool!.query(
    `UPDATE account_report_jobs
     SET run_at = now() + interval '1 day'
     WHERE id <> $1 AND kind <> 'prepare_report' AND state = 'pending'`,
    [jobId]
  );
}

suite("report mutation PostgreSQL lock ordering", () => {
  beforeAll(async () => {
    await adminPool!.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
    await pool.query(ACCOUNT_SCHEMA_SQL);
    await pool.query(REPORT_SCHEMA_SQL);
  });

  afterAll(async () => {
    await pool?.end();
    if (adminPool !== undefined) {
      await adminPool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await adminPool.end();
    }
  });

  it.each(["reserved", "consumed"] as const)(
    "atomically creates one prepared-content successor while retaining a %s entitlement",
    async (creditState) => {
      const accountId = await seedAccount(1);
      const reportRepository = new ReportRepository(pool!);
      const created = await reportRepository.create(accountId, `create-${randomUUID()}`, createInput);
      const reportId = created.report.id;
      await prepareReportForConnectionRetry(reportId);
      const job = await seedLifecycleJob(reportId, created.report.trace_id, "request_code");
      if (creditState === "consumed") {
        await pool!.query(
          "UPDATE report_credit_chains SET state = 'consumed' WHERE id = $1",
          [created.report.credit_chain_id]
        );
        await pool!.query(
          "UPDATE api_accounts SET reserved_credits = 0 WHERE id = $1",
          [accountId]
        );
        await pool!.query(
          `INSERT INTO credit_ledger (account_id, credit_chain_id, kind, available_delta, reserved_delta, reason)
           VALUES ($1, $2, 'consumption', 0, -1, 'Controlled retry fixture')`,
          [accountId, created.report.credit_chain_id]
        );
      }

      const outcomes = await Promise.all([
        reportRepository.failBeforeSubmission(job, "discord_network_error", "Discord preparation failed safely.", true),
        reportRepository.failBeforeSubmission(job, "discord_network_error", "Discord preparation failed safely.", true)
      ]);

      expect(outcomes.sort()).toEqual([false, "restarted"]);
      const predecessorResult = await pool!.query<{
        successor_report_id: string; connection_recovery: unknown;
      }>(
        `SELECT report.status, report.error_code, report.successor_report_id,
                report.connection_recovery, report.automatic_network_restarts,
                chain.state AS credit_state, account.available_credits, account.reserved_credits,
                job.state AS job_state,
                (SELECT count(*)::int FROM account_report_events
                 WHERE report_id = report.id AND event_type = 'report_failed') AS failures,
                (SELECT count(*)::int FROM account_report_events
                 WHERE report_id = report.id AND event_type = 'report_connection_restarting') AS restarting_events,
                (SELECT count(*)::int FROM credit_ledger
                 WHERE account_id = account.id AND kind = 'reservation') AS reservations,
                (SELECT count(*)::int FROM credit_ledger
                 WHERE account_id = account.id AND kind = 'release') AS releases,
                (SELECT count(*)::int FROM credit_ledger
                 WHERE account_id = account.id AND kind = 'consumption') AS consumptions
         FROM account_reports AS report
         JOIN report_credit_chains AS chain ON chain.id = report.credit_chain_id
         JOIN api_accounts AS account ON account.id = report.account_id
         JOIN account_report_jobs AS job ON job.id = $2
         WHERE report.id = $1`,
        [reportId, job.id]
      );
      const predecessor = predecessorResult.rows[0]!;
      expect(predecessor).toMatchObject({
        status: "failed", error_code: "discord_network_error", automatic_network_restarts: 0,
        credit_state: creditState, available_credits: 0,
        reserved_credits: creditState === "reserved" ? 1 : 0,
        job_state: "failed", failures: 0, restarting_events: 1, reservations: 1, releases: 0,
        consumptions: creditState === "consumed" ? 1 : 0
      });
      expect(predecessor.successor_report_id).toEqual(expect.any(String));
      expect(predecessor.connection_recovery).toMatchObject({
        state: "restarting", attempt: 3, maxAttempts: 3, retryAt: null,
        successorReportId: predecessor.successor_report_id
      });

      const successorResult = await pool!.query<{
        id: string; trace_id: string; research_sources: unknown;
      }>(
        `SELECT report.id, report.trace_id, report.status, report.retry_mode,
                report.predecessor_report_id, report.prepared_input, report.legal_reference,
                report.research_summary, report.research_sources, report.automatic_network_restarts,
                report.connection_recovery,
                (SELECT count(*)::int FROM account_report_jobs
                 WHERE report_id = report.id AND kind = 'prepare_report' AND state = 'pending') AS pending_preparations,
                (SELECT count(*)::int FROM account_report_events
                 WHERE report_id = report.id AND event_type = 'report_queued') AS queued_events
         FROM account_reports AS report WHERE report.id = $1`,
        [predecessor.successor_report_id]
      );
      const successor = successorResult.rows[0]!;
      expect(successor).toMatchObject({
        status: "queued", retry_mode: "reuse", predecessor_report_id: reportId,
        prepared_input: {
          country: "DE", category: "sub_other_hate_speech",
          description: "Prepared description", finalText: "Prepared report text."
        },
        legal_reference: "Prepared legal reference", research_summary: "Prepared research",
        automatic_network_restarts: 1, connection_recovery: null,
        pending_preparations: 1, queued_events: 1
      });
      expect(successor.id).not.toBe(reportId);
      expect(successor.trace_id).not.toBe(created.report.trace_id);
      expect(successor.research_sources).toEqual([{ title: "EUR-Lex", url: "https://eur-lex.europa.eu/" }]);
    },
    15_000
  );

  it("persists retry progress and clears it when the verification request succeeds", async () => {
    const accountId = await seedAccount(1);
    const reportRepository = new ReportRepository(pool!);
    const created = await reportRepository.create(accountId, `create-${randomUUID()}`, createInput);
    await prepareReportForConnectionRetry(created.report.id);
    const job = await seedLifecycleJob(created.report.id, created.report.trace_id, "request_code", 1);

    expect(await reportRepository.retryLifecycleJob(job, "discord_network_error", 8, {
      recordConnectionProgress: true
    })).toBe(true);
    const progress = await pool!.query<{ connection_recovery: Record<string, unknown> }>(
      "SELECT connection_recovery FROM account_reports WHERE id = $1",
      [created.report.id]
    );
    expect(progress.rows[0]?.connection_recovery).toMatchObject({
      state: "retrying", attempt: 2, maxAttempts: 3, successorReportId: null
    });
    expect(progress.rows[0]?.connection_recovery.retryAt).toEqual(expect.any(String));
    const retryEvent = await pool!.query<{ event_type: string; metadata: Record<string, unknown> }>(
      `SELECT event_type, metadata FROM account_report_events
       WHERE report_id = $1 AND event_type = 'report_connection_retry'`,
      [created.report.id]
    );
    expect(retryEvent.rows).toHaveLength(1);
    expect(retryEvent.rows[0]).toMatchObject({
      event_type: "report_connection_retry",
      metadata: { attempt: 2, maxAttempts: 3, retryAt: progress.rows[0]?.connection_recovery.retryAt }
    });

    await pool!.query(
      "UPDATE account_report_jobs SET state = 'running', attempts = 2, locked_at = now() WHERE id = $1",
      [job.id]
    );
    const reclaimed = { ...job, attempts: 2, execution_token: 2 };
    expect(await reportRepository.saveAwaitingVerification(reclaimed, "encrypted-fresh-session")).toBe(true);

    const completed = await pool!.query<{ connection_recovery: unknown; event_count: number }>(
      `SELECT report.connection_recovery,
              (SELECT count(*)::int FROM account_report_events
               WHERE report_id = report.id AND event_type = 'awaiting_verification') AS event_count
       FROM account_reports AS report WHERE report.id = $1`,
      [created.report.id]
    );
    expect(completed.rows[0]).toEqual({ connection_recovery: null, event_count: 1 });
  }, 15_000);

  it("settles a request-code retry without resending after verification email arrival", async () => {
    const accountId = await seedAccount(1);
    const reportRepository = new ReportRepository(pool!);
    const created = await reportRepository.create(accountId, `create-${randomUUID()}`, createInput);
    await prepareReportForConnectionRetry(created.report.id);
    await pool!.query(
      "UPDATE account_reports SET status = 'verification_received', session_state = NULL WHERE id = $1",
      [created.report.id]
    );
    await pool!.query(
      `INSERT INTO account_report_jobs (report_id, kind, dedupe_key, payload, max_attempts)
       VALUES ($1, 'verify_submit', $2, $3, 3)`,
      [created.report.id, `verify-${created.report.id}`, { encryptedCode: "encrypted-code" }]
    );
    const job = await seedLifecycleJob(created.report.id, created.report.trace_id, "request_code", 1);

    expect(await reportRepository.retryLifecycleJob(job, "discord_network_error", 8, {
      recordConnectionProgress: true,
      encryptedSession: "initialized-session"
    })).toBe("superseded");

    const result = await pool!.query(
      `SELECT report.status, report.session_state, report.connection_recovery,
              request_job.state AS request_job_state,
              (SELECT count(*)::int FROM account_report_jobs
               WHERE report_id = report.id AND kind = 'request_code' AND state = 'pending') AS pending_requests,
              (SELECT count(*)::int FROM account_report_events
               WHERE report_id = report.id AND event_type = 'report_connection_retry') AS retry_events
       FROM account_reports AS report
       JOIN account_report_jobs AS request_job ON request_job.id = $2
       WHERE report.id = $1`,
      [created.report.id, job.id]
    );
    expect(result.rows[0]).toEqual({
      status: "verification_received", session_state: "initialized-session", connection_recovery: null,
      request_job_state: "completed", pending_requests: 0, retry_events: 0
    });
  }, 15_000);

  it("keeps a verification that advanced during the final request-code failure", async () => {
    const accountId = await seedAccount(1);
    const reportRepository = new ReportRepository(pool!);
    const created = await reportRepository.create(accountId, `create-${randomUUID()}`, createInput);
    await prepareReportForConnectionRetry(created.report.id);
    const recovery = {
      state: "retrying", attempt: 2, maxAttempts: 3,
      retryAt: "2026-10-15T12:00:00.000Z", successorReportId: null
    };
    await pool!.query(
      `UPDATE account_reports SET status = 'verifying', verification_deadline = NULL,
         session_state = 'newer-verification-session', connection_recovery = $2::jsonb WHERE id = $1`,
      [created.report.id, JSON.stringify(recovery)]
    );
    await pool!.query(
      `INSERT INTO account_report_jobs (report_id, kind, dedupe_key, payload, max_attempts)
       VALUES ($1, 'verify_submit', $2, $3, 3)`,
      [created.report.id, `verify-${created.report.id}`, { encryptedCode: "encrypted-code" }]
    );
    const job = await seedLifecycleJob(created.report.id, created.report.trace_id, "request_code", 3);

    expect(await reportRepository.setStatus(job, "requesting_verification")).toBe(false);
    expect(await reportRepository.failBeforeSubmission(
      job, "discord_network_error", "Discord preparation failed safely.", true, "encrypted-initialized-session"
    )).toBe("superseded");

    const state = await pool!.query(
      `SELECT report.status, report.session_state, report.connection_recovery,
              chain.state AS credit_state, account.available_credits, account.reserved_credits,
              request_job.state AS request_job_state,
              verify_job.state AS verify_job_state,
              (SELECT count(*)::int FROM account_report_events
               WHERE report_id = report.id AND event_type = 'report_failed') AS failures
       FROM account_reports AS report
       JOIN report_credit_chains AS chain ON chain.id = report.credit_chain_id
       JOIN api_accounts AS account ON account.id = report.account_id
       JOIN account_report_jobs AS request_job ON request_job.id = $2
       JOIN account_report_jobs AS verify_job ON verify_job.report_id = report.id AND verify_job.kind = 'verify_submit'
       WHERE report.id = $1`,
      [created.report.id, job.id]
    );
    expect(state.rows[0]).toEqual({
      status: "verifying", session_state: "newer-verification-session", connection_recovery: recovery,
      credit_state: "reserved", available_credits: 0, reserved_credits: 1,
      request_job_state: "completed", verify_job_state: "pending", failures: 0
    });
  }, 15_000);

  it("settles late request-code jobs after submission begins without mutating the report", async () => {
    const accountId = await seedAccount(2);
    const reportRepository = new ReportRepository(pool!);
    const recovery = {
      state: "retrying", attempt: 3, maxAttempts: 3,
      retryAt: "2026-10-15T12:00:00.000Z", successorReportId: null
    };

    const failedLate = await seedVerifyingReport(accountId);
    const failedLateRequest = await seedLifecycleJob(
      failedLate.reportId, failedLate.job.trace_id, "request_code"
    );
    expect(await reportRepository.beginSubmission(failedLate.job)).toBe(true);
    await pool!.query(
      `UPDATE account_reports SET session_state = 'verified-session', connection_recovery = $2::jsonb
       WHERE id = $1`,
      [failedLate.reportId, JSON.stringify(recovery)]
    );
    expect(await reportRepository.failBeforeSubmission(
      failedLateRequest, "discord_network_error", "Late request-code failure.", true,
      "stale-request-session"
    )).toBe("superseded");

    const successfulLate = await seedVerifyingReport(accountId);
    const successfulLateRequest = await seedLifecycleJob(
      successfulLate.reportId, successfulLate.job.trace_id, "request_code"
    );
    expect(await reportRepository.beginSubmission(successfulLate.job)).toBe(true);
    await pool!.query(
      `UPDATE account_reports SET session_state = 'newer-verified-session', connection_recovery = $2::jsonb
       WHERE id = $1`,
      [successfulLate.reportId, JSON.stringify(recovery)]
    );
    expect(await reportRepository.saveAwaitingVerification(
      successfulLateRequest, "stale-request-session"
    )).toBe("superseded");

    const settled = await pool!.query(
      `SELECT report.status, report.session_state, report.connection_recovery,
              report.submission_started_at IS NOT NULL AS boundary_crossed,
              chain.state AS credit_state, account.reserved_credits,
              request_job.state AS request_job_state,
              (SELECT count(*)::int FROM credit_ledger
               WHERE credit_chain_id = chain.id AND kind = 'consumption') AS consumptions,
              (SELECT count(*)::int FROM credit_ledger
               WHERE credit_chain_id = chain.id AND kind = 'release') AS releases,
              (SELECT count(*)::int FROM account_report_events
               WHERE report_id = report.id AND event_type = 'report_failed') AS failures
       FROM account_reports AS report
       JOIN report_credit_chains AS chain ON chain.id = report.credit_chain_id
       JOIN api_accounts AS account ON account.id = report.account_id
       JOIN account_report_jobs AS request_job ON request_job.id = $2
       WHERE report.id = $1`,
      [failedLate.reportId, failedLateRequest.id]
    );
    const saved = await pool!.query(
      `SELECT report.status, report.session_state, report.connection_recovery,
              report.submission_started_at IS NOT NULL AS boundary_crossed,
              chain.state AS credit_state, account.reserved_credits,
              request_job.state AS request_job_state,
              (SELECT count(*)::int FROM credit_ledger
               WHERE credit_chain_id = chain.id AND kind = 'consumption') AS consumptions,
              (SELECT count(*)::int FROM credit_ledger
               WHERE credit_chain_id = chain.id AND kind = 'release') AS releases,
              (SELECT count(*)::int FROM account_report_events
               WHERE report_id = report.id AND event_type = 'report_failed') AS failures
       FROM account_reports AS report
       JOIN report_credit_chains AS chain ON chain.id = report.credit_chain_id
       JOIN api_accounts AS account ON account.id = report.account_id
       JOIN account_report_jobs AS request_job ON request_job.id = $2
       WHERE report.id = $1`,
      [successfulLate.reportId, successfulLateRequest.id]
    );
    const expected = {
      status: "submitting", boundary_crossed: true, credit_state: "consumed",
      reserved_credits: 0, request_job_state: "completed", consumptions: 1, releases: 0, failures: 0
    };
    expect(settled.rows[0]).toEqual({
      ...expected, session_state: "verified-session", connection_recovery: recovery
    });
    expect(saved.rows[0]).toEqual({
      ...expected, session_state: "newer-verified-session", connection_recovery: recovery
    });
  }, 15_000);

  it("serializes submission before suspension without deadlocking or releasing a consumed credit", async () => {
    const accountId = await seedAccount(1);
    const { reportId, job } = await seedVerifyingReport(accountId);
    const gateState = createGate();
    const reportsPool = instrumentPool(pool!, {
      pauseAfter: (sql) => sql.includes("FROM account_report_jobs") && sql.includes("FOR UPDATE"),
      arrive: () => gateState.arrive()
    });
    const accountsPool = instrumentPool(pool!);
    const reportRepository = new ReportRepository(reportsPool.pool);
    const accounts = new AccountRepository(accountsPool.pool, "fixture-pepper");
    const submission = reportRepository.beginSubmission(job);

    await gateState.gate.reached;
    const suspension = accounts.setAccountStatus(accountId, "suspended", "Controlled race fixture");
    let waitError: Error | undefined;
    try {
      await waitForBlockedBackend(await accountsPool.connected);
    } catch (error) {
      waitError = error instanceof Error ? error : new Error(String(error));
    } finally {
      gateState.gate.release();
    }

    const outcomes = await Promise.allSettled([submission, suspension]);
    if (waitError !== undefined) throw waitError;
    expect(outcomes.map((outcome) => outcome.status)).toEqual(["fulfilled", "fulfilled"]);
    if (outcomes[0]?.status !== "fulfilled" || outcomes[1]?.status !== "fulfilled") return;
    expect(outcomes[0].value).toBe(true);
    expect(outcomes[1].value.status).toBe("suspended");

    const state = await pool!.query<SubmissionStateRow>(
      `SELECT report.status, report.submission_started_at, chain.state AS credit_state,
              account.available_credits, account.reserved_credits, job.state AS job_state,
              (SELECT count(*)::int FROM credit_ledger
               WHERE account_id = account.id AND kind = 'consumption') AS consumptions,
              (SELECT count(*)::int FROM credit_ledger
               WHERE account_id = account.id AND kind = 'release') AS releases
       FROM account_reports AS report
       JOIN report_credit_chains AS chain ON chain.id = report.credit_chain_id
       JOIN api_accounts AS account ON account.id = report.account_id
       JOIN account_report_jobs AS job ON job.id = $2
       WHERE report.id = $1`,
      [reportId, job.id]
    );
    expect(state.rows[0]).toMatchObject({
      status: "submitting", credit_state: "consumed", available_credits: 0,
      reserved_credits: 0, job_state: "running", consumptions: 1, releases: 0
    });
    expect(state.rows[0]?.submission_started_at).not.toBeNull();
  }, 15_000);

  it("serializes suspension before submission and makes the released credit durable", async () => {
    const accountId = await seedAccount(1);
    const { reportId, job } = await seedVerifyingReport(accountId);
    const gateState = createGate();
    const accountsPool = instrumentPool(pool!, {
      pauseAfter: (sql) => sql.includes("UPDATE api_accounts SET status = $2"),
      arrive: () => gateState.arrive()
    });
    const reportPool = instrumentPool(pool!);
    const accounts = new AccountRepository(accountsPool.pool, "fixture-pepper");
    const reportRepository = new ReportRepository(reportPool.pool);
    const suspension = accounts.setAccountStatus(accountId, "suspended", "Controlled race fixture");

    await gateState.gate.reached;
    const submission = reportRepository.beginSubmission(job);
    let waitError: Error | undefined;
    try {
      await waitForBlockedBackend(await reportPool.connected);
    } catch (error) {
      waitError = error instanceof Error ? error : new Error(String(error));
    } finally {
      gateState.gate.release();
    }

    const outcomes = await Promise.allSettled([suspension, submission]);
    if (waitError !== undefined) throw waitError;
    expect(outcomes.map((outcome) => outcome.status)).toEqual(["fulfilled", "fulfilled"]);
    if (outcomes[0]?.status !== "fulfilled" || outcomes[1]?.status !== "fulfilled") return;
    expect(outcomes[0].value.status).toBe("suspended");
    expect(outcomes[1].value).toBe(false);

    const state = await pool!.query(
      `SELECT report.status, report.error_code, report.submission_started_at,
              chain.state AS credit_state, account.available_credits, account.reserved_credits,
              job.state AS job_state,
              (SELECT count(*)::int FROM credit_ledger
               WHERE account_id = account.id AND kind = 'release') AS releases,
              (SELECT count(*)::int FROM account_report_events
               WHERE report_id = report.id AND event_type = 'report_failed') AS failures
       FROM account_reports AS report
       JOIN report_credit_chains AS chain ON chain.id = report.credit_chain_id
       JOIN api_accounts AS account ON account.id = report.account_id
       JOIN account_report_jobs AS job ON job.id = $2
       WHERE report.id = $1`,
      [reportId, job.id]
    );
    expect(state.rows[0]).toMatchObject({
      status: "failed", error_code: "account_suspended", submission_started_at: null,
      credit_state: "released", available_credits: 1, reserved_credits: 0,
      job_state: "failed", releases: 1, failures: 1
    });
  }, 15_000);

  it("persists preparation failure and releases its reservation atomically", async () => {
    const accountId = await seedAccount(1);
    const reportRepository = new ReportRepository(pool!);
    const created = await reportRepository.create(accountId, `create-${randomUUID()}`, createInput);
    const prepJob = await pool!.query<{ id: string } & QueryResultRow>(
      `UPDATE account_report_jobs SET state = 'running', attempts = 1, locked_at = now()
       WHERE report_id = $1 AND kind = 'prepare_report' RETURNING id`,
      [created.report.id]
    );

    expect(await reportRepository.failPreparation(
      prepJob.rows[0]!.id, created.report.id, "preparation_timeout", "Preparation timed out.", 1
    )).toBe(true);

    const state = await pool!.query(
      `SELECT report.status, report.error_code, chain.state AS credit_state,
              account.available_credits, account.reserved_credits,
              job.state AS job_state, job.last_error,
              (SELECT count(*)::int FROM credit_ledger
               WHERE account_id = account.id AND kind = 'release') AS releases,
              (SELECT count(*)::int FROM account_report_events
               WHERE report_id = report.id AND event_type = 'report_failed') AS failures
       FROM account_reports AS report
       JOIN report_credit_chains AS chain ON chain.id = report.credit_chain_id
       JOIN api_accounts AS account ON account.id = report.account_id
       JOIN account_report_jobs AS job ON job.id = $2
       WHERE report.id = $1`,
      [created.report.id, prepJob.rows[0]!.id]
    );
    expect(state.rows[0]).toMatchObject({
      status: "failed", error_code: "preparation_timeout", credit_state: "released",
      available_credits: 1, reserved_credits: 0, job_state: "failed",
      last_error: "preparation_timeout", releases: 1, failures: 1
    });
  });

  it("does not persist or release credit when a preparation worker lost job ownership", async () => {
    const accountId = await seedAccount(1);
    const reportRepository = new ReportRepository(pool!);
    const created = await reportRepository.create(accountId, `create-${randomUUID()}`, createInput);
    const prepJob = await pool!.query<{ id: string } & QueryResultRow>(
      `UPDATE account_report_jobs SET state = 'running', attempts = 2, locked_at = now()
       WHERE report_id = $1 AND kind = 'prepare_report' RETURNING id`,
      [created.report.id]
    );

    expect(await reportRepository.failPreparation(
      prepJob.rows[0]!.id, created.report.id, "stale_failure", "Stale worker result.", 1
    )).toBe(false);

    const state = await pool!.query(
      `SELECT report.status, report.error_code, chain.state AS credit_state,
              account.available_credits, account.reserved_credits, job.state AS job_state,
              job.attempts,
              (SELECT count(*)::int FROM credit_ledger
               WHERE account_id = account.id AND kind = 'release') AS releases,
              (SELECT count(*)::int FROM account_report_events
               WHERE report_id = report.id AND event_type = 'report_failed') AS failures
       FROM account_reports AS report
       JOIN report_credit_chains AS chain ON chain.id = report.credit_chain_id
       JOIN api_accounts AS account ON account.id = report.account_id
       JOIN account_report_jobs AS job ON job.id = $2
       WHERE report.id = $1`,
      [created.report.id, prepJob.rows[0]!.id]
    );
    expect(state.rows[0]).toMatchObject({
      status: "queued", error_code: null, credit_state: "reserved",
      available_credits: 0, reserved_credits: 1, job_state: "running",
      attempts: 2, releases: 0, failures: 0
    });
  });

  it.each(["request_code", "verify_submit"] as const)(
    "terminally settles a stale exhausted %s worker without a fourth claim",
    async (kind) => {
      const accountId = await seedAccount(1);
      const reportRepository = new ReportRepository(pool!);
      const created = await reportRepository.create(accountId, `create-${randomUUID()}`, createInput);
      await prepareReportForConnectionRetry(created.report.id);
      await pool!.query(
        "UPDATE account_reports SET status = $2 WHERE id = $1",
        [created.report.id, kind === "request_code" ? "requesting_verification" : "verifying"]
      );
      const job = await seedLifecycleJob(created.report.id, created.report.trace_id, kind, 3);
      await pool!.query(
        "UPDATE account_report_jobs SET locked_at = now() - interval '3 minutes' WHERE id = $1",
        [job.id]
      );

      const failures: LifecycleFailureSignal[] = [];
      await Promise.all([
        reportRepository.recoverInterruptedJobs((failure) => failures.push(failure)),
        reportRepository.recoverInterruptedJobs((failure) => failures.push(failure))
      ]);

      await delayOtherPendingLifecycleJobs(job.id);
      await expect(reportRepository.claimLifecycleJob()).resolves.toBeNull();
      const state = await pool!.query(
        `SELECT report.status, report.error_code, report.connection_recovery,
                report.submission_started_at IS NOT NULL AS boundary_crossed,
                chain.state AS credit_state, account.available_credits, account.reserved_credits,
                job.state AS job_state, job.attempts, job.max_attempts, job.last_error,
                (SELECT count(*)::int FROM credit_ledger
                 WHERE credit_chain_id = chain.id AND kind = 'release') AS releases,
                (SELECT count(*)::int FROM account_report_events
                 WHERE report_id = report.id AND event_type = 'report_failed') AS failures
         FROM account_reports AS report
         JOIN report_credit_chains AS chain ON chain.id = report.credit_chain_id
         JOIN api_accounts AS account ON account.id = report.account_id
         JOIN account_report_jobs AS job ON job.id = $2
         WHERE report.id = $1`,
        [created.report.id, job.id]
      );

      expect(state.rows[0]).toEqual({
        status: "failed", error_code: "lifecycle_attempts_exhausted", connection_recovery: null,
        boundary_crossed: false, credit_state: "released", available_credits: 1, reserved_credits: 0,
        job_state: "failed", attempts: 3, max_attempts: 3, last_error: "lifecycle_attempts_exhausted",
        releases: 1, failures: 1
      });
      expect(failures).toEqual([{
        reportId: created.report.id,
        traceId: created.report.trace_id,
        lifecycleAttempt: 1,
        stage: "verification",
        eventType: "report_failed",
        outcome: "failed",
        errorCategory: "lifecycle_attempts_exhausted"
      }]);
    },
  );

  it("does not claim an already exhausted pending verification job", async () => {
    const accountId = await seedAccount(1);
    const reportRepository = new ReportRepository(pool!);
    const created = await reportRepository.create(accountId, `create-${randomUUID()}`, createInput);
    await prepareReportForConnectionRetry(created.report.id);
    const job = await seedLifecycleJob(created.report.id, created.report.trace_id, "request_code", 3);
    await pool!.query(
      `UPDATE account_report_jobs
       SET state = 'pending', locked_at = NULL, run_at = now() - interval '1 minute'
       WHERE id = $1`,
      [job.id]
    );

    await delayOtherPendingLifecycleJobs(job.id);
    await expect(reportRepository.claimLifecycleJob()).resolves.toBeNull();
    await reportRepository.recoverInterruptedJobs();

    const settled = await pool!.query(
      `SELECT report.status, job.state AS job_state, job.attempts,
              account.available_credits, account.reserved_credits,
              chain.state AS credit_state
       FROM account_reports AS report
       JOIN account_report_jobs AS job ON job.id = $2
       JOIN api_accounts AS account ON account.id = report.account_id
       JOIN report_credit_chains AS chain ON chain.id = report.credit_chain_id
       WHERE report.id = $1`,
      [created.report.id, job.id]
    );
    expect(settled.rows[0]).toEqual({
      status: "failed", job_state: "failed", attempts: 3,
      available_credits: 1, reserved_credits: 0, credit_state: "released"
    });
  }, 15_000);

  it("retains a consumed chain when an exhausted pre-boundary job is settled", async () => {
    const accountId = await seedAccount(1);
    const reportRepository = new ReportRepository(pool!);
    const created = await reportRepository.create(accountId, `create-${randomUUID()}`, createInput);
    await prepareReportForConnectionRetry(created.report.id);
    await pool!.query("UPDATE account_reports SET status = 'verifying' WHERE id = $1", [created.report.id]);
    const job = await seedLifecycleJob(created.report.id, created.report.trace_id, "verify_submit", 3);
    await pool!.query(
      "UPDATE account_report_jobs SET locked_at = now() - interval '3 minutes' WHERE id = $1",
      [job.id]
    );
    await pool!.query("UPDATE report_credit_chains SET state = 'consumed' WHERE id = $1", [created.report.credit_chain_id]);
    await pool!.query("UPDATE api_accounts SET reserved_credits = 0 WHERE id = $1", [accountId]);
    await pool!.query(
      `INSERT INTO credit_ledger (account_id, credit_chain_id, kind, available_delta, reserved_delta, reason)
       VALUES ($1, $2, 'consumption', 0, -1, 'Controlled exhausted lifecycle fixture')`,
      [accountId, created.report.credit_chain_id]
    );

    await reportRepository.recoverInterruptedJobs();

    const state = await pool!.query(
      `SELECT report.status, report.error_code, report.submission_started_at IS NOT NULL AS boundary_crossed,
              chain.state AS credit_state, account.available_credits, account.reserved_credits,
              job.state AS job_state,
              (SELECT count(*)::int FROM credit_ledger
               WHERE credit_chain_id = chain.id AND kind = 'consumption') AS consumptions,
              (SELECT count(*)::int FROM credit_ledger
               WHERE credit_chain_id = chain.id AND kind = 'release') AS releases
       FROM account_reports AS report
       JOIN report_credit_chains AS chain ON chain.id = report.credit_chain_id
       JOIN api_accounts AS account ON account.id = report.account_id
       JOIN account_report_jobs AS job ON job.id = $2
       WHERE report.id = $1`,
      [created.report.id, job.id]
    );
    expect(state.rows[0]).toEqual({
      status: "failed", error_code: "lifecycle_attempts_exhausted", boundary_crossed: false,
      credit_state: "consumed", available_credits: 0, reserved_credits: 0,
      job_state: "failed", consumptions: 1, releases: 0
    });
  }, 15_000);

  it("completes an exhausted request-code job superseded by submission without changing the report", async () => {
    const accountId = await seedAccount(1);
    const reportRepository = new ReportRepository(pool!);
    const { reportId, job: verifyJob } = await seedVerifyingReport(accountId);
    const requestJob = await seedLifecycleJob(reportId, verifyJob.trace_id, "request_code", 3);
    expect(await reportRepository.beginSubmission(verifyJob)).toBe(true);
    await pool!.query(
      "UPDATE account_report_jobs SET locked_at = now() - interval '3 minutes' WHERE id = $1",
      [requestJob.id]
    );
    const failures: LifecycleFailureSignal[] = [];

    await reportRepository.recoverInterruptedJobs((failure) => failures.push(failure));

    const state = await pool!.query(
      `SELECT report.status, report.submission_started_at IS NOT NULL AS boundary_crossed,
              chain.state AS credit_state, account.reserved_credits,
              request_job.state AS request_job_state, request_job.attempts,
              (SELECT count(*)::int FROM account_report_events
               WHERE report_id = report.id AND event_type = 'report_failed') AS failures
       FROM account_reports AS report
       JOIN report_credit_chains AS chain ON chain.id = report.credit_chain_id
       JOIN api_accounts AS account ON account.id = report.account_id
       JOIN account_report_jobs AS request_job ON request_job.id = $2
       WHERE report.id = $1`,
      [reportId, requestJob.id]
    );
    expect(state.rows[0]).toEqual({
      status: "submitting", boundary_crossed: true, credit_state: "consumed", reserved_credits: 0,
      request_job_state: "completed", attempts: 3, failures: 0
    });
    expect(failures).toEqual([]);
  }, 15_000);

  it.each(["verification_received", "submitted"] as const)(
    "completes an exhausted pending request-code row superseded by %s without changing report or credit state",
    async (status) => {
      const accountId = await seedAccount(1);
      const reportRepository = new ReportRepository(pool!);
      let reportId: string;
      let traceId: string;

      if (status === "verification_received") {
        const created = await reportRepository.create(accountId, `create-${randomUUID()}`, createInput);
        reportId = created.report.id;
        traceId = created.report.trace_id;
        await prepareReportForConnectionRetry(reportId);
        await pool!.query("UPDATE account_reports SET status = 'verification_received' WHERE id = $1", [reportId]);
      } else {
        const verifying = await seedVerifyingReport(accountId);
        reportId = verifying.reportId;
        traceId = verifying.job.trace_id;
        expect(await reportRepository.beginSubmission(verifying.job)).toBe(true);
        await pool!.query("UPDATE account_reports SET status = 'submitted' WHERE id = $1", [reportId]);
      }

      const requestJob = await seedLifecycleJob(reportId, traceId, "request_code", 3);
      await pool!.query(
        `UPDATE account_report_jobs SET state = 'pending', locked_at = NULL, run_at = now() - interval '1 minute'
         WHERE id = $1`,
        [requestJob.id]
      );
      const before = await pool!.query(
        `SELECT report.status, report.error_code, report.submission_started_at IS NOT NULL AS boundary_crossed,
                chain.state AS credit_state, account.available_credits, account.reserved_credits,
                (SELECT count(*)::int FROM credit_ledger
                 WHERE credit_chain_id = chain.id AND kind = 'release') AS releases,
                (SELECT count(*)::int FROM credit_ledger
                 WHERE credit_chain_id = chain.id AND kind = 'consumption') AS consumptions,
                (SELECT count(*)::int FROM account_report_events
                 WHERE report_id = report.id AND event_type = 'report_failed') AS failures
         FROM account_reports AS report
         JOIN report_credit_chains AS chain ON chain.id = report.credit_chain_id
         JOIN api_accounts AS account ON account.id = report.account_id
         WHERE report.id = $1`,
        [reportId]
      );

      await expect(reportRepository.recoverInterruptedJobs()).resolves.toEqual([]);

      const after = await pool!.query(
        `SELECT report.status, report.error_code, report.submission_started_at IS NOT NULL AS boundary_crossed,
                chain.state AS credit_state, account.available_credits, account.reserved_credits,
                (SELECT count(*)::int FROM credit_ledger
                 WHERE credit_chain_id = chain.id AND kind = 'release') AS releases,
                (SELECT count(*)::int FROM credit_ledger
                 WHERE credit_chain_id = chain.id AND kind = 'consumption') AS consumptions,
                (SELECT count(*)::int FROM account_report_events
                 WHERE report_id = report.id AND event_type = 'report_failed') AS failures,
                job.state AS job_state, job.attempts, job.max_attempts
         FROM account_reports AS report
         JOIN report_credit_chains AS chain ON chain.id = report.credit_chain_id
         JOIN api_accounts AS account ON account.id = report.account_id
         JOIN account_report_jobs AS job ON job.id = $2
         WHERE report.id = $1`,
        [reportId, requestJob.id]
      );

      expect(after.rows[0]).toMatchObject({
        ...before.rows[0], job_state: "completed", attempts: 3, max_attempts: 3
      });
    },
  );

  it("captures each interrupted-submission failure after its own commit", async () => {
    const accountId = await seedAccount(2);
    const reportRepository = new ReportRepository(pool!);
    const reports = await Promise.all([
      reportRepository.create(accountId, `create-${randomUUID()}`, createInput),
      reportRepository.create(accountId, `create-${randomUUID()}`, createInput)
    ]);
    const orderedIds = reports.map(({ report }) => report.id).sort();
    const committedReportId = orderedIds[0]!;
    const rejectedReportId = orderedIds[1]!;
    for (const reportId of orderedIds) {
      await pool!.query(
        `UPDATE account_reports
         SET status = 'failed', error_code = 'ambiguous_submission_state',
             submission_started_at = now() - interval '3 minutes'
         WHERE id = $1`,
        [reportId]
      );
      await pool!.query(
        `INSERT INTO account_report_jobs (report_id, kind, dedupe_key, state, attempts, max_attempts, locked_at)
         VALUES ($1, 'verify_submit', $2, 'running', 1, 3, now() - interval '3 minutes')`,
        [reportId, `verify-recovery-${reportId}`]
      );
    }

    await pool!.query(`
      CREATE FUNCTION ${schema}.reject_one_recovery_event() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.report_id = '${rejectedReportId}'::uuid THEN
          RAISE EXCEPTION 'controlled recovery event failure';
        END IF;
        RETURN NEW;
      END;
      $$;
      CREATE TRIGGER reject_one_recovery_event
        BEFORE INSERT ON account_report_events
        FOR EACH ROW EXECUTE FUNCTION ${schema}.reject_one_recovery_event();
    `);

    const captured: string[] = [];
    await expect(reportRepository.recoverInterruptedJobs((failure) => captured.push(failure.reportId)))
      .rejects.toThrow("controlled recovery event failure");

    expect(captured).toEqual([committedReportId]);
    const state = await pool!.query(
      `SELECT report.id, report.error_code, job.state AS job_state,
              (SELECT count(*)::int FROM account_report_events AS event
               WHERE event.report_id = report.id AND event.event_type = 'report_failed') AS failures
       FROM account_reports AS report
       JOIN account_report_jobs AS job ON job.report_id = report.id AND job.kind = 'verify_submit'
       WHERE report.id = ANY($1::uuid[]) ORDER BY report.id`,
      [orderedIds]
    );
    expect(state.rows).toEqual([
      { id: committedReportId, error_code: "ambiguous_submission_state", job_state: "failed", failures: 1 },
      { id: rejectedReportId, error_code: "ambiguous_submission_state", job_state: "running", failures: 0 }
    ]);
  }, 15_000);
});
