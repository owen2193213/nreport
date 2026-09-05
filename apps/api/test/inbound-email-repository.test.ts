/* eslint-disable @typescript-eslint/require-await, @typescript-eslint/no-unused-vars */
import { describe, expect, it, vi } from "vitest";

import { ReportRepository } from "../src/report-repository.js";

describe("account report email correlation", () => {
  it("correlates a verification email without exposing its code in an event", async () => {
    const client = {
      query: vi.fn(async (sql: string, _values?: unknown[]) => {
        if (sql.includes("reporter_email") && sql.includes("FOR UPDATE")) {
          return { rows: [{ id: "report-1", account_id: "account-1", lifecycle_attempt: 1 }], rowCount: 1 };
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

    expect(result).toEqual({ status: "accepted", reportId: "report-1" });
    expect(client.query.mock.calls.some(([sql, values]) => String(sql).includes("verify_submit") && JSON.stringify(values).includes("encrypted-code"))).toBe(true);
    const eventCall = client.query.mock.calls.find(([sql]) => String(sql).includes("INSERT INTO account_report_events"));
    expect(JSON.stringify(eventCall)).not.toContain("encrypted-code");
  });
});
