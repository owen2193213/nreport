import { describe, expect, it, vi } from "vitest";
import { AccountBotDatabase, BOT_ACCOUNT_SCHEMA_SQL } from "../src/account-database.js";
import { botLog, setBotDiagnosticSink } from "../src/observability.js";

describe("bot diagnostics", () => {
  it("feeds direct bot logs to the configured diagnostic sink", () => {
    const events: unknown[] = [];
    setBotDiagnosticSink((event, fields) => events.push({ event, fields }));
    botLog("interaction_failed", { reportId: "report-1" });
    setBotDiagnosticSink(undefined);
    expect(events).toEqual([{ event: "interaction_failed", fields: { reportId: "report-1" } }]);
  });

  it("keeps logging alive when fields contain cycles or bigint values", () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const fields: Record<string, unknown> = { count: 4n };
    fields.self = fields;

    expect(() => botLog("diagnostic_serialization_test", fields)).not.toThrow();

    const record = JSON.parse(String(write.mock.calls[0]?.[0])) as Record<string, unknown>;
    expect(record).toMatchObject({ count: "4", self: "[circular]" });
    write.mockRestore();
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

  it("purges settled lifecycle inbox rows past retention", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 });
    const database = new AccountBotDatabase({ query } as never);

    await database.purgeLifecycleInbox();

    expect(query).toHaveBeenCalledWith(expect.stringMatching(/state IN \('sent', 'ignored'\).*created_at < now\(\) - interval '30 days'/s));
  });

  it("declares the coalescing and card-repair lookup indexes on lifecycle_inbox", () => {
    expect(BOT_ACCOUNT_SCHEMA_SQL).toContain("ON lifecycle_inbox(account_id, report_id, event_id)");
    expect(BOT_ACCOUNT_SCHEMA_SQL).toContain("ON lifecycle_inbox(report_id, created_at DESC)");
  });

  it("returns aggregate age and count metrics for pending notifications and card work", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{
      pending_notification_count: "4",
      oldest_pending_notification_age_ms: "360000",
      pending_card_update_count: "2",
      oldest_pending_card_update_age_ms: "420000"
    }], rowCount: 1 });
    const database = new AccountBotDatabase({ query } as never);

    await expect(database.notificationHealthSnapshot()).resolves.toEqual({
      pendingNotificationCount: 4,
      oldestPendingNotificationAgeMs: 360_000,
      pendingCardUpdateCount: 2,
      oldestPendingCardUpdateAgeMs: 420_000
    });
    expect(String(query.mock.calls[0]?.[0])).toContain("FROM lifecycle_inbox");
    expect(String(query.mock.calls[0]?.[0])).toContain("FROM bot_report_links");
    expect(String(query.mock.calls[0]?.[0])).toContain("JOIN api_connections");
    expect(String(query.mock.calls[0]?.[0])).toContain("superseded_by_report_id IS NULL");
    expect(String(query.mock.calls[0]?.[0])).toContain("last_card_edit_at");
    expect(String(query.mock.calls[0]?.[0])).not.toMatch(/discord_user_id|encrypted_api_key|target_context/iu);
  });

  it("does not claim lifecycle events for disconnected accounts", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 });
    const database = new AccountBotDatabase({ query } as never);

    await expect(database.claimNotification()).resolves.toBeNull();

    expect(String(query.mock.calls[0]?.[0])).toContain("EXISTS (SELECT 1 FROM api_connections");
  });
});
