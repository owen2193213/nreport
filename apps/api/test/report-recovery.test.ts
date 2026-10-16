/* eslint-disable @typescript-eslint/require-await */
import { describe, expect, it, vi } from "vitest";

import { ReportRepository } from "../src/report-repository.js";

describe("report worker recovery", () => {
  it("reports each recovered failure only after its per-report commit", async () => {
    let committedTransactions = 0;
    const client = {
      query: vi.fn(async (sql: string, values?: unknown[]) => {
        if (sql === "COMMIT") committedTransactions += 1;
        if (sql.includes("SELECT account_id, credit_chain_id FROM account_reports")) {
          return { rows: [{ account_id: "account-1", credit_chain_id: "chain-1" }], rowCount: 1 };
        }
        if (sql.includes("FROM account_reports AS report") && sql.includes("JOIN account_report_jobs AS job") && sql.includes("FOR UPDATE OF job")) {
          const id = values?.[0];
          return {
            rows: id === "report-2"
              ? [{ id, trace_id: "trace-2", account_id: "account-1", lifecycle_attempt: 1 }]
              : [{ id: "report-3", trace_id: "trace-3", account_id: "account-1", lifecycle_attempt: 2 }],
            rowCount: 1
          };
        }
        if (sql.includes("INSERT INTO account_report_events")) return { rows: [{ id: "event-1" }], rowCount: 1 };
        return { rows: [], rowCount: 1 };
      }),
      release: vi.fn()
    };
    const pool = {
      connect: async () => client,
      query: vi.fn(async (sql: string) => {
        if (sql.includes("SELECT report.id FROM account_reports AS report") && sql.includes("verify_submit")) {
          return { rows: [{ id: "report-2" }], rowCount: 1 };
        }
        if (sql.includes("SELECT report.id FROM account_reports AS report") && sql.includes("submit_review")) {
          return { rows: [{ id: "report-3" }], rowCount: 1 };
        }
        return { rows: [], rowCount: 1 };
      })
    };
    const repository = new ReportRepository(pool as never);
    const captures: Array<{ reportId: string; committedTransactions: number }> = [];

    await expect(repository.recoverInterruptedJobs((failure) => {
      captures.push({ reportId: failure.reportId, committedTransactions });
    })).resolves.toEqual([
      {
        reportId: "report-2", traceId: "trace-2", lifecycleAttempt: 1,
        stage: "submitting", eventType: "report_failed", outcome: "ambiguous",
        errorCategory: "ambiguous_submission_state"
      },
      {
        reportId: "report-3", traceId: "trace-3", lifecycleAttempt: 2,
        stage: "review_submission", eventType: "review_request_ambiguous", outcome: "ambiguous",
        errorCategory: "review_request_ambiguous"
      }
    ]);

    expect(captures).toEqual([
      { reportId: "report-2", committedTransactions: 2 },
      { reportId: "report-3", committedTransactions: 3 }
    ]);
    expect(client.query.mock.calls.filter(([sql]) => sql === "COMMIT")).toHaveLength(3);
    expect(client.query.mock.calls.some(([sql]) => String(sql).includes("'6 minutes'"))).toBe(true);
    expect(client.query.mock.calls.some(([sql]) => String(sql).includes("'2 minutes'"))).toBe(true);
  });
});
