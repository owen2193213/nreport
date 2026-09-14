import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";

import { ACCOUNT_SCHEMA_SQL } from "../src/accounts.js";
import { REPORT_SCHEMA_SQL, ReportRepository } from "../src/report-repository.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const suite = databaseUrl === undefined ? describe.skip : describe;
const schema = `inbound_email_${randomUUID().replaceAll("-", "")}`;
let pool = databaseUrl === undefined ? undefined : new Pool({ connectionString: databaseUrl });
let repositoryPool: Pool | undefined;

async function seedReport(overrides: Partial<{ status: string; reporterEmail: string; discordReportId: string | null }> = {}) {
  const accountId = randomUUID();
  const chainId = randomUUID();
  const reportId = randomUUID();
  const reporterEmail = overrides.reporterEmail ?? `alias-${reportId}@reports.example.test`;
  await pool!.query(
    "INSERT INTO api_accounts (id, username, username_normalized) VALUES ($1, $2, $2)",
    [accountId, `test-${accountId.slice(0, 8)}`]
  );
  await pool!.query("INSERT INTO report_credit_chains (id, account_id, state) VALUES ($1, $2, 'reserved')", [chainId, accountId]);
  await pool!.query(
    `INSERT INTO account_reports
       (id, account_id, idempotency_key, request_hash, flow, use_ai, request_input, credit_chain_id,
        status, reporter_email, discord_report_id)
     VALUES ($1, $2, $3, 'test', 'message', false, '{}'::jsonb, $4, $5, $6, $7)`,
    [reportId, accountId, `test:${reportId}`, chainId, overrides.status ?? "submitted", reporterEmail, overrides.discordReportId ?? null]
  );
  return { accountId, reportId, reporterEmail };
}

suite("inbound email PostgreSQL migration", () => {
  beforeAll(async () => {
    const client = await pool!.connect();
    try {
      await client.query(`CREATE SCHEMA ${schema}`);
      await client.query(`SET search_path TO ${schema}`);
      await client.query(ACCOUNT_SCHEMA_SQL);
      await client.query(REPORT_SCHEMA_SQL);
    } finally {
      client.release();
    }
    await pool!.end();
    pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
    repositoryPool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
  });

  afterAll(async () => {
    if (pool === undefined) return;
    await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await repositoryPool?.end();
    await pool.end();
  });

  it("creates the exact pending-correlation partial index", async () => {
    const result = await pool!.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes WHERE schemaname = $1 AND indexname = 'account_inbound_messages_pending_correlation_idx'`,
      [schema]
    );
    expect(result.rows[0]?.indexdef).toContain("(external_report_id, recipient, received_at, message_id)");
    expect(result.rows[0]?.indexdef).toContain("WHERE (status = 'pending_report'::text)");
  });

  it("replays a pending receipt when submission commits after the email", async () => {
    const externalId = "1548921252872462416";
    const seeded = await seedReport({ status: "submitting" });
    const job = await pool!.query<{ id: string }>(
      `INSERT INTO account_report_jobs (report_id, kind, dedupe_key, state, attempts)
       VALUES ($1, 'verify_submit', $2, 'running', 1) RETURNING id`,
      [seeded.reportId, `verify:${seeded.reportId}`]
    );
    await pool!.query(
      `INSERT INTO account_inbound_messages (message_id, recipient, status, external_report_id, external_status)
       VALUES ($1, $2, 'pending_report', $3, 'received')`,
      [`mail-${seeded.reportId}`, seeded.reporterEmail, externalId]
    );

    const repository = new ReportRepository(repositoryPool!);
    await expect(repository.markSubmitted({
      id: job.rows[0]!.id, report_id: seeded.reportId, kind: "verify_submit", payload: {}, attempts: 1,
      max_attempts: 1, execution_token: 1, trace_id: randomUUID()
    }, externalId)).resolves.toBe(true);

    await expect(pool!.query("SELECT discord_status, receipt_deadline FROM account_reports WHERE id = $1", [seeded.reportId]))
      .resolves.toMatchObject({ rows: [{ discord_status: "received", receipt_deadline: null }] });
    await expect(pool!.query("SELECT status FROM account_inbound_messages WHERE message_id = $1", [`mail-${seeded.reportId}`]))
      .resolves.toMatchObject({ rows: [{ status: "accepted" }] });
  });

  it("reconciliation preserves actioned state when a lower-priority closure is pending", async () => {
    const externalId = "1548921252872462417";
    const seeded = await seedReport({ discordReportId: externalId });
    await pool!.query(
      `INSERT INTO account_inbound_messages (message_id, recipient, status, external_report_id, external_status)
       VALUES ($1, $2, 'pending_report', $3, $4), ($5, $2, 'pending_report', $3, 'closed_no_action')`,
      [`actioned-${seeded.reportId}`, seeded.reporterEmail, externalId, "actioned", `closed-${seeded.reportId}`]
    );

    const result = await new ReportRepository(repositoryPool!).reconcilePendingInboundMessages();
    expect(result.processed).toBe(2);
    await expect(pool!.query("SELECT discord_status FROM account_reports WHERE id = $1", [seeded.reportId]))
      .resolves.toMatchObject({ rows: [{ discord_status: "actioned" }] });
    await expect(pool!.query("SELECT count(*)::int AS count FROM account_report_jobs WHERE report_id = $1 AND kind = 'submit_review'", [seeded.reportId]))
      .resolves.toMatchObject({ rows: [{ count: 0 }] });
  });

  it("leaves a recipient or report-ID mismatch pending without associating it", async () => {
    const seeded = await seedReport({ discordReportId: "1548921252872462418" });
    await pool!.query(
      `INSERT INTO account_inbound_messages (message_id, recipient, status, external_report_id, external_status)
       VALUES ($1, $2, 'pending_report', '1548921252872462499', 'received')`,
      [`mismatch-${seeded.reportId}`, seeded.reporterEmail]
    );
    await new ReportRepository(repositoryPool!).reconcilePendingInboundMessages();
    await expect(pool!.query("SELECT report_id, status FROM account_inbound_messages WHERE message_id = $1", [`mismatch-${seeded.reportId}`]))
      .resolves.toMatchObject({ rows: [{ report_id: null, status: "pending_report" }] });
  });
});
