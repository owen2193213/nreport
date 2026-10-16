import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool, type QueryResult, type QueryResultRow } from "pg";

import { ACCOUNT_SCHEMA_SQL, AccountRepository } from "../src/accounts.js";
import { REPORT_SCHEMA_SQL, ReportRepository } from "../src/report-repository.js";
import type { LifecycleJob } from "../src/lifecycle-runner-v2.js";

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
