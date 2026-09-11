import type { ReportDetail } from "@nreport/contracts";
import { describe, expect, it, vi } from "vitest";

import { AccountNotificationWorker, reportRecoveryDelaySeconds } from "../src/account-notifier.js";
import { targetContextFromReport, visibleStatusHash } from "../src/report-ui.js";

const report: ReportDetail = {
  reportId: "11111111-1111-4111-8111-111111111111", accountId: "account", flow: "message", useAi: true,
  status: "failed", creditState: "consumed", lifecycleAttempt: 1, country: "DE", category: null, description: null,
  discordReportId: null, discordStatus: null, reviewStatus: null, predecessorReportId: null, successorReportId: null,
  retryableModes: ["regenerate"], createdAt: "2026-09-09T00:00:00Z", updatedAt: "2026-09-09T00:01:00Z",
  target: { messageUrl: "https://discord.com/channels/@me/123456789012345678/123456789012345679" },
  finalText: null, legalReference: null, researchSummary: null, sources: [], timeline: [],
  failure: { stage: "writing", code: "preparation_timeout", message: "Report preparation timed out." }
};

describe("report recovery scheduling", () => {
  it("uses the bounded transient-failure schedule and slows down API throttling", () => {
    expect([1, 2, 3, 4, 5, 6, 7].map((attempt) => reportRecoveryDelaySeconds(attempt, false)))
      .toEqual([5, 15, 30, 60, 120, 300, 300]);
    expect(reportRecoveryDelaySeconds(1, true)).toBe(120);
  });
});

function harness(hash: string | null = null, eventId = "event") {
  const message = { edit: vi.fn().mockResolvedValue(undefined), reply: vi.fn().mockResolvedValue(undefined) };
  const dm = { messages: { fetch: vi.fn().mockResolvedValue(message) }, send: vi.fn() };
  const database = {
    claimNotification: vi.fn().mockResolvedValue({ event_id: eventId, event_type: "report_failed", report_id: report.reportId,
      trace_id: "33333333-3333-4333-8333-333333333333",
      attempts: 1,
      discord_user_id: "user", encrypted_api_key: "unused", encrypted_target_context: null,
      dm_message_id: "original-card", visible_payload_hash: hash }),
    notificationPreferences: vi.fn().mockResolvedValue({ decisionEnabled: true, reportDeniedEnabled: false, problemEnabled: true }),
    completeCardUpdate: vi.fn(), completeNotification: vi.fn(), retryNotification: vi.fn(), claimDmCard: vi.fn().mockResolvedValue(false)
  };
  const api = { report: vi.fn().mockResolvedValue(report) };
  const client = { users: { fetch: vi.fn().mockResolvedValue({ createDM: vi.fn().mockResolvedValue(dm) }) } };
  const logger = vi.fn<(event: string, fields?: Record<string, unknown>, level?: "info" | "warn" | "error") => void>();
  const worker = new AccountNotificationWorker(database as never, client as never, {} as never, () => api as never, undefined, logger);
  return { worker, database, api, message, dm, logger };
}

describe("notification delivery against an existing report card", () => {
  it("edits the original card and replies to it before completing the event", async () => {
    const h = harness();
    await h.worker.processOne();
    expect(h.dm.messages.fetch).toHaveBeenCalledWith("original-card");
    expect(h.message.edit).toHaveBeenCalledOnce();
    expect(h.message.edit).toHaveBeenCalledWith(expect.objectContaining({ content: null, embeds: [] }));
    expect(h.message.reply).toHaveBeenCalledOnce();
    expect(h.message.reply).toHaveBeenCalledWith(expect.objectContaining({
      nonce: "nreport-b8e1f80bd70ae078",
      enforceNonce: true
    }));
    expect(JSON.stringify(h.message.reply.mock.calls)).toContain("Report preparation timed out.");
    expect(h.dm.send).not.toHaveBeenCalled();
    expect(h.database.completeNotification).toHaveBeenCalledWith("event");
    expect(h.message.reply.mock.invocationCallOrder[0]).toBeLessThan(h.database.completeNotification.mock.invocationCallOrder[0]!);
  });

  it("uses the same event-only nonce for retries and a different nonce for another event", async () => {
    const first = harness(null, "event");
    const retry = harness(null, "event");
    const different = harness(null, "event-2");

    await first.worker.processOne();
    await retry.worker.processOne();
    await different.worker.processOne();

    expect(first.message.reply.mock.calls[0]?.[0]).toMatchObject({ nonce: "nreport-b8e1f80bd70ae078", enforceNonce: true });
    expect(retry.message.reply.mock.calls[0]?.[0]).toMatchObject({ nonce: "nreport-b8e1f80bd70ae078", enforceNonce: true });
    expect(different.message.reply.mock.calls[0]?.[0]).toMatchObject({ nonce: "nreport-b4e3d14e7519279e", enforceNonce: true });
  });

  it("logs claimed and completed outcomes without durable or Discord identifiers", async () => {
    const h = harness();

    await h.worker.processOne();

    expect(h.logger).toHaveBeenCalledWith("account_notification_claimed", {
      traceId: "33333333-3333-4333-8333-333333333333", eventType: "report_failed", attempts: 1,
      stage: "notification", outcome: "claimed", durationMs: 0
    });
    expect(h.logger).toHaveBeenCalledWith("account_notification_completed", {
      traceId: "33333333-3333-4333-8333-333333333333", eventType: "report_failed", attempts: 1,
      stage: "notification", outcome: "completed", durationMs: expect.any(Number) as number
    });
    const serializedLogs = JSON.stringify(h.logger.mock.calls);
    expect(serializedLogs).not.toContain("11111111-1111-4111-8111-111111111111");
    expect(serializedLogs).not.toContain("original-card");
    expect(serializedLogs).not.toContain("user");
    expect(serializedLogs).not.toContain("event\"");
  });

  it("skips an unchanged edit but still sends the terminal reply", async () => {
    const h = harness(visibleStatusHash(report, targetContextFromReport(report)));
    await h.worker.processOne();
    expect(h.message.edit).not.toHaveBeenCalled();
    expect(h.message.reply).toHaveBeenCalledOnce();
  });

  it.each(["edit", "reply"] as const)("keeps a rejected Discord %s retryable", async (operation) => {
    const h = harness();
    h.message[operation].mockRejectedValue(new Error("Discord unavailable canary-secret"));
    await h.worker.processOne();
    expect(h.database.retryNotification).toHaveBeenCalledWith("event", "unexpected");
    expect(h.logger).toHaveBeenCalledWith("account_notification_retry", {
      traceId: "33333333-3333-4333-8333-333333333333", eventType: "report_failed", attempts: 1,
      stage: "notification", outcome: "retry", durationMs: expect.any(Number) as number,
      deliveryStage: operation === "edit" ? "edit_card" : "reply",
      errorName: "Error", failureCategory: "unexpected"
    }, "warn");
    expect(JSON.stringify(h.logger.mock.calls)).not.toContain("canary-secret");
    expect(h.database.completeNotification).not.toHaveBeenCalled();
    if (operation === "edit") expect(h.message.reply).not.toHaveBeenCalled();
  });

  it("does not create a duplicate card while another worker owns its claim", async () => {
    const h = harness();
    h.dm.messages.fetch.mockRejectedValue(new Error("Unknown Message"));
    await h.worker.processOne();
    expect(h.dm.send).not.toHaveBeenCalled();
    expect(h.database.retryNotification).toHaveBeenCalledWith("event", "status_card_creation_in_progress");
    expect(h.database.completeNotification).not.toHaveBeenCalled();
  });

  it("does no API or Discord work when the outbox is empty", async () => {
    const h = harness();
    h.database.claimNotification.mockResolvedValue(null);
    expect(await h.worker.processOne()).toBe(false);
    expect(h.api.report).not.toHaveBeenCalled();
    expect(h.dm.messages.fetch).not.toHaveBeenCalled();
  });
});
