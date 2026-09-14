import { describe, expect, it, vi } from "vitest";
import { AccountBotDatabase } from "../src/account-database.js";
import { botLog, setBotDiagnosticSink } from "../src/observability.js";

describe("bot diagnostics", () => {
  it("feeds direct bot logs to the configured diagnostic sink", () => {
    const events: unknown[] = [];
    setBotDiagnosticSink((event, fields) => events.push({ event, fields }));
    botLog("interaction_failed", { reportId: "report-1" });
    setBotDiagnosticSink(undefined);
    expect(events).toEqual([{ event: "interaction_failed", fields: { reportId: "report-1" } }]);
  });

  it("persists report-scoped diagnostics and purges expired rows", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 1 });
    const database = new AccountBotDatabase({ query } as never);
    await database.recordDiagnostic({ reportId: "11111111-1111-4111-8111-111111111111", traceId: "22222222-2222-4222-8222-222222222222", service: "bot", severity: "warn", event: "card_update_failed", stage: "card", outcome: "retry", details: { stack: "x".repeat(70_000) } });
    await database.purgeDiagnostics();
    expect(query.mock.calls[0]?.[0]).toContain("bot_report_diagnostics");
    const params = query.mock.calls[0]?.[1] as unknown[];
    expect(JSON.stringify(params[7]).length).toBeLessThanOrEqual(65_536);
    expect(params[7]).toMatchObject({ truncated: true });
    expect(query.mock.calls[1]?.[0]).toContain("created_at < now() - interval '30 days'");
  });
});
