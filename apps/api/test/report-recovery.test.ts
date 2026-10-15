/* eslint-disable @typescript-eslint/require-await, @typescript-eslint/no-unused-vars */
import { describe, expect, it, vi } from "vitest";

import { REPORT_SCHEMA_SQL, ReportRepository } from "../src/report-repository.js";

describe("report worker recovery", () => {
  it("takes the event advisory lock after the event foreign keys are checked", () => {
    expect(REPORT_SCHEMA_SQL).toContain("pg_advisory_xact_lock");
    expect(REPORT_SCHEMA_SQL).toContain("AFTER INSERT ON account_report_events");
  });

  it("builds age-gated recovery queries and records mocked ambiguous submissions", async () => {
    const client = {
      query: vi.fn(async (sql: string, _values?: unknown[]) => {
        if (sql.includes("RETURNING report.id") && sql.includes("ambiguous_submission_state")) {
          return { rows: [{ id: "report-2", trace_id: "trace-2", account_id: "account-1", lifecycle_attempt: 1 }], rowCount: 1 };
        }
        if (sql.includes("RETURNING report.id") && sql.includes("review_request_ambiguous")) {
          return { rows: [{ id: "report-3", trace_id: "trace-3", account_id: "account-1", lifecycle_attempt: 2 }], rowCount: 1 };
        }
        return { rows: [], rowCount: 1 };
      }),
      release: vi.fn()
    };
    const repository = new ReportRepository({ connect: async () => client } as never);

    await expect(repository.recoverInterruptedJobs()).resolves.toEqual([
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

    const runningQueries = client.query.mock.calls.filter(([sql]) => String(sql).includes("job.state = 'running'"));
    expect(runningQueries.every(([sql]) => String(sql).includes("locked_at < now() - interval"))).toBe(true);
    expect(runningQueries.some(([sql]) => String(sql).includes("'6 minutes'"))).toBe(true);
    expect(client.query.mock.calls.some(([sql]) => String(sql).includes("submission_started_at IS NULL") && String(sql).includes("state = 'pending'"))).toBe(true);
    expect(client.query.mock.calls.some(([sql]) => String(sql).includes("ambiguous_submission_state") && String(sql).includes("submission_started_at IS NOT NULL"))).toBe(true);
    expect(client.query.mock.calls.some(([sql, values]) => String(sql).includes("account_report_events") && values?.includes("report_failed"))).toBe(true);
    expect(client.query).toHaveBeenCalledWith("COMMIT");
  });
});
