import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";

import { ACCOUNT_SCHEMA_SQL } from "../src/accounts.js";
import { REPORT_SCHEMA_SQL, ReportMutationError, ReportRepository } from "../src/report-repository.js";
import type { LifecycleJob } from "../src/lifecycle-runner-v2.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const suite = databaseUrl === undefined ? describe.skip : describe;
const schema = `report_concurrency_${randomUUID().replaceAll("-", "")}`;
const adminPool = databaseUrl === undefined ? undefined : new Pool({ connectionString: databaseUrl });
let pool: Pool | undefined;
let repository: ReportRepository | undefined;

const createInput = {
  flow: "message" as const,
  useAi: true as const,
  target: {
    messageUrl: "https://discord.com/channels/@me/123456789012345678/123456789012345679"
  },
  description: "Controlled PostgreSQL integration fixture."
};

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
       VALUES ($1, 'grant', $2, 0, 'PostgreSQL integration fixture')`,
      [accountId, availableCredits]
    );
  }
  return accountId;
}

suite("report mutation PostgreSQL concurrency", () => {
  beforeAll(async () => {
    await adminPool!.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
    await pool.query(ACCOUNT_SCHEMA_SQL);
    await pool.query(REPORT_SCHEMA_SQL);
    repository = new ReportRepository(pool);
  });

  afterAll(async () => {
    await pool?.end();
    if (adminPool !== undefined) {
      await adminPool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await adminPool.end();
    }
  });

  it("serializes concurrent same-key creates into one report and one reservation", async () => {
    const accountId = await seedAccount(1);
    const results = await Promise.all(
      Array.from({ length: 8 }, () => repository!.create(accountId, "same-create-key", createInput))
    );

    expect(results.filter((result) => result.created)).toHaveLength(1);
    expect(new Set(results.map((result) => result.report.id)).size).toBe(1);
    expect(results.filter((result) => !result.created)).toHaveLength(7);

    const state = await pool!.query<{
      available_credits: number; reserved_credits: number; state: string; successor_report_id: string | null;
      reports: number; successors: number; reuse_entries: number; reservations: number;
    }>(
      `SELECT account.available_credits, account.reserved_credits,
              (SELECT count(*)::int FROM account_reports WHERE account_id = account.id) AS reports,
              (SELECT count(*)::int FROM report_credit_chains WHERE account_id = account.id) AS chains,
              (SELECT count(*)::int FROM credit_ledger WHERE account_id = account.id AND kind = 'reservation') AS reservations,
              (SELECT count(*)::int FROM account_report_jobs AS job
               JOIN account_reports AS report ON report.id = job.report_id
               WHERE report.account_id = account.id AND job.kind = 'prepare_report') AS preparation_jobs,
              (SELECT count(*)::int FROM account_report_events WHERE account_id = account.id AND event_type = 'report_queued') AS queued_events
       FROM api_accounts AS account WHERE account.id = $1`,
      [accountId]
    );
    expect(state.rows[0]).toMatchObject({
      available_credits: 0, reserved_credits: 1, reports: 1, chains: 1,
      reservations: 1, preparation_jobs: 1, queued_events: 1
    });
  });

  it("allows only one of two different creates to reserve the last credit", async () => {
    const accountId = await seedAccount(1);
    const results = await Promise.allSettled([
      repository!.create(accountId, "create-left", createInput),
      repository!.create(accountId, "create-right", createInput)
    ]);

    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result) => result.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    if (rejected[0]?.status === "rejected") {
      expect(rejected[0].reason).toBeInstanceOf(ReportMutationError);
      expect(rejected[0].reason).toMatchObject({ code: "credits_exhausted" });
    }

    const state = await pool!.query(
      `SELECT available_credits, reserved_credits,
              (SELECT count(*)::int FROM account_reports WHERE account_id = $1) AS reports,
              (SELECT count(*)::int FROM credit_ledger WHERE account_id = $1 AND kind = 'reservation') AS reservations
       FROM api_accounts WHERE id = $1`,
      [accountId]
    );
    expect(state.rows[0]).toMatchObject({ available_credits: 0, reserved_credits: 1, reports: 1, reservations: 1 });
  });

  it("creates one retry successor under concurrent requests without spending another consumed-chain credit", async () => {
    const accountId = await seedAccount(1);
    const reportId = randomUUID();
    const chainId = randomUUID();
    const predecessorInput = {
      flow: "message",
      useAi: true,
      target: createInput.target,
      description: "Controlled PostgreSQL integration fixture."
    };
    await pool!.query(
      "INSERT INTO report_credit_chains (id, account_id, state) VALUES ($1, $2, 'consumed')",
      [chainId, accountId]
    );
    await pool!.query(
      `INSERT INTO account_reports
         (id, account_id, idempotency_key, request_hash, flow, use_ai, request_input,
          prepared_input, credit_chain_id, status, error_code)
       VALUES ($1, $2, 'original-create', 'original-hash', 'message', true, $3, $4, $5,
               'failed', 'preparation_timeout')`,
      [reportId, accountId, predecessorInput, {
        country: "DE", category: "illegal", description: "Fixture", finalText: "Fixture report"
      }, chainId]
    );
    await pool!.query("UPDATE report_credit_chains SET original_report_id = $2 WHERE id = $1", [chainId, reportId]);

    const results = await Promise.allSettled([
      repository!.retry(accountId, reportId, "retry-left", { mode: "reuse" }),
      repository!.retry(accountId, reportId, "retry-right", { mode: "reuse" })
    ]);
    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result) => result.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    if (rejected[0]?.status === "rejected") {
      expect(rejected[0].reason).toBeInstanceOf(ReportMutationError);
      expect(rejected[0].reason).toMatchObject({ code: "invalid_retry" });
    }

    const state = await pool!.query<{
      available_credits: number; reserved_credits: number; state: string; successor_report_id: string | null;
      reports: number; successors: number; reuse_entries: number; reservations: number;
    }>(
      `SELECT account.available_credits, account.reserved_credits, chain.state,
              predecessor.successor_report_id,
              (SELECT count(*)::int FROM account_reports WHERE account_id = account.id) AS reports,
              (SELECT count(*)::int FROM account_reports WHERE predecessor_report_id = predecessor.id) AS successors,
              (SELECT count(*)::int FROM credit_ledger WHERE account_id = account.id AND kind = 'retry_chain_reuse') AS reuse_entries,
              (SELECT count(*)::int FROM credit_ledger WHERE account_id = account.id AND kind = 'reservation') AS reservations
       FROM api_accounts AS account
       JOIN report_credit_chains AS chain ON chain.account_id = account.id
       JOIN account_reports AS predecessor ON predecessor.id = chain.original_report_id
       WHERE account.id = $1`,
      [accountId]
    );
    expect(state.rows[0]).toMatchObject({
      available_credits: 1, reserved_credits: 0, state: "consumed",
      reports: 2, successors: 1, reuse_entries: 1, reservations: 0
    });
    expect(state.rows[0]?.successor_report_id).toBeTruthy();
  });

  it("keeps report pagination complete when rows share a millisecond but differ in PostgreSQL microseconds", async () => {
    const accountId = await seedAccount(3);
    const created = await Promise.all(
      ["page-one", "page-two", "page-three"].map((key) => repository!.create(accountId, key, createInput))
    );
    const ids = created.map((result) => result.report.id);
    for (const [index, id] of ids.entries()) {
      await pool!.query("UPDATE account_reports SET created_at = $2::timestamptz WHERE id = $1", [
        id,
        `2026-10-15T10:00:00.12300${index + 1}Z`
      ]);
    }

    const pages: string[] = [];
    let after: string | null = null;
    for (let pageNumber = 0; pageNumber < ids.length + 1; pageNumber += 1) {
      const page = await repository!.listOwned(accountId, after, 1);
      pages.push(...page.rows.map((row) => row.id));
      after = page.next;
      if (after === null) break;
    }

    expect(pages).toEqual([...ids].reverse());
  });

  it("applies a matching Discord email whether it races ahead of or follows submission persistence", async () => {
    const accountId = await seedAccount(1);
    const created = await repository!.create(accountId, "email-race-create", createInput);
    const reportId = created.report.id;
    const reporterEmail = `alias-${reportId}@reports.example.test`;
    const discordReportId = "1548921252872462491";
    const jobResult = await pool!.query<{ id: string }>(
      `INSERT INTO account_report_jobs (report_id, kind, dedupe_key, state, attempts, max_attempts)
       VALUES ($1, 'verify_submit', $2, 'running', 1, 1) RETURNING id`,
      [reportId, `verify:${reportId}`]
    );
    await pool!.query(
      `UPDATE account_reports SET status = 'verifying', reporter_email = $2,
         prepared_input = '{"country":"DE","category":"illegal","description":"Fixture","finalText":"Fixture"}'::jsonb
       WHERE id = $1`,
      [reportId, reporterEmail]
    );
    const job: LifecycleJob = {
      id: jobResult.rows[0]!.id,
      report_id: reportId,
      kind: "verify_submit",
      payload: {},
      attempts: 1,
      max_attempts: 1,
      execution_token: 1,
      trace_id: created.report.trace_id
    };
    expect(await repository!.beginSubmission(job)).toBe(true);

    const [email, submitted] = await Promise.all([
      repository!.registerReportUpdateEmail({
        messageId: `email-race-${reportId}`,
        recipient: reporterEmail,
        discordReportId,
        discordStatus: "received"
      }),
      repository!.markSubmitted(job, discordReportId)
    ]);

    expect(submitted).toBe(true);
    expect(email.status).toMatch(/^(accepted|pending_report)$/u);
    const state = await pool!.query(
      `SELECT report.status, report.discord_report_id, report.discord_status,
              report.receipt_deadline, chain.state AS credit_state,
              account.available_credits, account.reserved_credits, message.report_id AS email_report_id,
              message.status AS email_status
       FROM account_reports AS report
       JOIN report_credit_chains AS chain ON chain.id = report.credit_chain_id
       JOIN api_accounts AS account ON account.id = report.account_id
       JOIN account_inbound_messages AS message ON message.message_id = $2
       WHERE report.id = $1`,
      [reportId, `email-race-${reportId}`]
    );
    expect(state.rows[0]).toMatchObject({
      status: "submitted", discord_report_id: discordReportId, discord_status: "received",
      receipt_deadline: null, credit_state: "consumed", available_credits: 0,
      reserved_credits: 0, email_report_id: reportId, email_status: "accepted"
    });
  });
});
