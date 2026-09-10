/* eslint-disable @typescript-eslint/require-await, @typescript-eslint/no-unused-vars */
import { describe, expect, it, vi } from "vitest";

import { REPORT_SCHEMA_SQL, ReportRepository } from "../src/report-repository.js";

describe("report worker recovery", () => {
  it("declares an event-insert advisory-lock trigger in the schema", () => {
    expect(REPORT_SCHEMA_SQL).toContain("pg_advisory_xact_lock");
    expect(REPORT_SCHEMA_SQL).toContain("BEFORE INSERT ON account_report_events");
  });

  it("builds age-gated recovery queries and records mocked ambiguous submissions", async () => {
    const client = {
      query: vi.fn(async (sql: string, _values?: unknown[]) => {
        if (sql.includes("RETURNING report.id") && sql.includes("ambiguous_submission_state")) {
          return { rows: [{ id: "report-2", account_id: "account-1", lifecycle_attempt: 1 }], rowCount: 1 };
        }
        return { rows: [], rowCount: 1 };
      }),
      release: vi.fn()
    };
    const repository = new ReportRepository({ connect: async () => client } as never);

    await repository.recoverInterruptedJobs();

    const runningQueries = client.query.mock.calls.filter(([sql]) => String(sql).includes("job.state = 'running'"));
    expect(runningQueries.every(([sql]) => String(sql).includes("locked_at < now() - interval"))).toBe(true);
    expect(runningQueries.some(([sql]) => String(sql).includes("'6 minutes'"))).toBe(true);
    expect(client.query.mock.calls.some(([sql]) => String(sql).includes("submission_started_at IS NULL") && String(sql).includes("state = 'pending'"))).toBe(true);
    expect(client.query.mock.calls.some(([sql]) => String(sql).includes("ambiguous_submission_state") && String(sql).includes("submission_started_at IS NOT NULL"))).toBe(true);
    expect(client.query.mock.calls.some(([sql, values]) => String(sql).includes("account_report_events") && values?.includes("report_failed"))).toBe(true);
    expect(client.query).toHaveBeenCalledWith("COMMIT");
  });
});
