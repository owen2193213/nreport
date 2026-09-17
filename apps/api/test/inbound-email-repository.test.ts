/* eslint-disable @typescript-eslint/require-await, @typescript-eslint/no-unused-vars */
import { describe, expect, it, vi } from "vitest";

import { ReportRepository } from "../src/report-repository.js";

describe("account report email correlation", () => {
  it("correlates a verification email without exposing its code in an event", async () => {
    const client = {
      query: vi.fn(async (sql: string, _values?: unknown[]) => {
        if (sql.includes("reporter_email") && sql.includes("FOR UPDATE")) {
          return { rows: [{ id: "report-1", trace_id: "33333333-3333-4333-8333-333333333333", account_id: "account-1", lifecycle_attempt: 1 }], rowCount: 1 };
        }
        if (sql.includes("INSERT INTO account_inbound_messages")) return { rows: [{ message_id: "mail-1" }], rowCount: 1 };
        return { rows: [], rowCount: 1 };
      }),
      release: vi.fn()
    };
    const repository = new ReportRepository({ connect: async () => client } as never);

    const result = await repository.registerVerificationEmail({
      messageId: "mail-1", recipient: "ALIAS@example.test", encryptedCode: "encrypted-code"
    });

    expect(result).toEqual({ status: "accepted", reportId: "report-1", traceId: "33333333-3333-4333-8333-333333333333" });
    expect(client.query.mock.calls.some(([sql, values]) => String(sql).includes("verify_submit") && JSON.stringify(values).includes("encrypted-code"))).toBe(true);
    const eventCall = client.query.mock.calls.find(([sql]) => String(sql).includes("INSERT INTO account_report_events"));
    expect(JSON.stringify(eventCall)).not.toContain("encrypted-code");
  });

  it("keeps the stored report correlation for a duplicate verification message after lifecycle advancement", async () => {
    const client = {
      query: vi.fn(async (sql: string, _values?: unknown[]) => {
        if (sql.includes("reporter_email") && sql.includes("FOR UPDATE")) return { rows: [], rowCount: 0 };
        if (sql.includes("INSERT INTO account_inbound_messages")) return { rows: [], rowCount: 0 };
        if (sql.includes("FROM account_inbound_messages") && sql.includes("trace_id")) {
          return { rows: [{ id: "report-advanced", trace_id: "44444444-4444-4444-8444-444444444444" }], rowCount: 1 };
        }
        return { rows: [], rowCount: 1 };
      }),
      release: vi.fn()
    };
    const repository = new ReportRepository({ connect: async () => client } as never);

    await expect(repository.registerVerificationEmail({
      messageId: "duplicate-mail", recipient: "alias@example.test", encryptedCode: "encrypted-code"
    })).resolves.toEqual({
      status: "duplicate", reportId: "report-advanced", traceId: "44444444-4444-4444-8444-444444444444"
    });
  });

  it("locks the stable recipient before comparing a report receipt ID", async () => {
    const client = {
      query: vi.fn(async (sql: string, _values?: unknown[]) => {
        if (sql.includes("WHERE reporter_email = $1") && sql.includes("FOR UPDATE")) {
          return { rows: [], rowCount: 0 };
        }
        if (sql.includes("INSERT INTO account_inbound_messages")) return { rows: [{ message_id: "mail-race" }], rowCount: 1 };
        return { rows: [], rowCount: 1 };
      }),
      release: vi.fn()
    };
    const repository = new ReportRepository({ connect: async () => client } as never);

    await expect(repository.registerReportUpdateEmail({
      messageId: "mail-race", recipient: "Alias@Example.test", discordReportId: "1548921252872462416", discordStatus: "received"
    })).resolves.toMatchObject({ status: "pending_report" });

    expect(client.query).toHaveBeenCalledWith(
      expect.stringContaining("WHERE reporter_email = $1\n         FOR UPDATE"),
      ["alias@example.test"]
    );
  });

  it("adopts a report stuck as ambiguous_submission_state when a report-update email proves the submission reached Discord", async () => {
    const client = {
      query: vi.fn(async (sql: string, values?: unknown[]) => {
        if (sql.includes("WHERE reporter_email = $1") && sql.includes("FOR UPDATE") && !sql.includes("discord_report_id")) {
          return {
            rows: [{
              id: "report-1", account_id: "account-1", trace_id: "33333333-3333-4333-8333-333333333333",
              discord_report_id: null, error_code: "ambiguous_submission_state",
              submission_started_at: new Date("2026-09-01T00:00:00Z"), lifecycle_attempt: 1,
              reporter_email: "alias@example.test"
            }],
            rowCount: 1
          };
        }
        if (sql.startsWith("UPDATE account_reports SET discord_report_id")) {
          return {
            rows: [{
              id: "report-1", account_id: "account-1", trace_id: "33333333-3333-4333-8333-333333333333",
              discord_report_id: values?.[1], error_code: null, status: "submitted",
              discord_status: null, review_status: null, lifecycle_attempt: 1, reporter_email: "alias@example.test"
            }],
            rowCount: 1
          };
        }
        if (sql.includes("INSERT INTO account_inbound_messages")) return { rows: [{ message_id: "mail-recover" }], rowCount: 1 };
        if (sql.includes("INSERT INTO account_report_events")) return { rows: [{ id: "1" }], rowCount: 1 };
        return { rows: [], rowCount: 1 };
      }),
      release: vi.fn()
    };
    const repository = new ReportRepository({ connect: async () => client } as never);

    const result = await repository.registerReportUpdateEmail({
      messageId: "mail-recover", recipient: "alias@example.test",
      discordReportId: "1548921252872462416", discordStatus: "received"
    });

    expect(result).toMatchObject({ status: "accepted", reportId: "report-1" });
    const adopt = client.query.mock.calls.find(([sql]) => String(sql).startsWith("UPDATE account_reports SET discord_report_id"));
    expect(adopt?.[1]).toEqual(["report-1", "1548921252872462416"]);
    const event = client.query.mock.calls.find(([sql, values]) => String(sql).includes("INSERT INTO account_report_events") && values?.includes("report_receipt_recovered"));
    expect(event).toBeDefined();
  });

  it("does not adopt an ambiguous report from a review_received email", async () => {
    const client = {
      query: vi.fn(async (sql: string, _values?: unknown[]) => {
        if (sql.includes("WHERE reporter_email = $1") && sql.includes("FOR UPDATE") && !sql.includes("discord_report_id")) {
          return {
            rows: [{
              id: "report-1", account_id: "account-1", discord_report_id: null,
              error_code: "ambiguous_submission_state", submission_started_at: new Date("2026-09-01T00:00:00Z"),
              lifecycle_attempt: 1, reporter_email: "alias@example.test"
            }],
            rowCount: 1
          };
        }
        if (sql.includes("INSERT INTO account_inbound_messages")) return { rows: [{ message_id: "mail-review" }], rowCount: 1 };
        return { rows: [], rowCount: 1 };
      }),
      release: vi.fn()
    };
    const repository = new ReportRepository({ connect: async () => client } as never);

    await repository.registerReviewUpdateEmail({
      messageId: "mail-review", recipient: "alias@example.test", discordReportId: "1548921252872462416"
    });

    expect(client.query.mock.calls.some(([sql]) => String(sql).startsWith("UPDATE account_reports SET discord_report_id"))).toBe(false);
  });
});
