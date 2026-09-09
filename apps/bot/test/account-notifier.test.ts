import type { ReportDetail } from "@nreport/contracts";
import { describe, expect, it, vi } from "vitest";

import { AccountNotificationWorker } from "../src/account-notifier.js";
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

function harness(hash: string | null = null) {
  const message = { edit: vi.fn().mockResolvedValue(undefined), reply: vi.fn().mockResolvedValue(undefined) };
  const dm = { messages: { fetch: vi.fn().mockResolvedValue(message) }, send: vi.fn() };
  const database = {
    claimNotification: vi.fn().mockResolvedValue({ event_id: "event", event_type: "report_failed", report_id: report.reportId,
      discord_user_id: "user", encrypted_api_key: "unused", encrypted_target_context: null,
      dm_message_id: "original-card", visible_payload_hash: hash }),
    notificationPreferences: vi.fn().mockResolvedValue({ decisionEnabled: true, reportDeniedEnabled: false, problemEnabled: true }),
    completeCardUpdate: vi.fn(), completeNotification: vi.fn(), retryNotification: vi.fn(), claimDmCard: vi.fn().mockResolvedValue(false)
  };
  const api = { report: vi.fn().mockResolvedValue(report) };
  const client = { users: { fetch: vi.fn().mockResolvedValue({ createDM: vi.fn().mockResolvedValue(dm) }) } };
  const worker = new AccountNotificationWorker(database as never, client as never, {} as never, () => api as never);
  return { worker, database, api, message, dm };
}

describe("notification delivery against an existing report card", () => {
  it("edits the original card and replies to it before completing the event", async () => {
    const h = harness();
    await h.worker.processOne();
    expect(h.dm.messages.fetch).toHaveBeenCalledWith("original-card");
    expect(h.message.edit).toHaveBeenCalledOnce();
    expect(h.message.reply).toHaveBeenCalledOnce();
    expect(JSON.stringify(h.message.reply.mock.calls)).toContain("Report preparation timed out.");
    expect(h.dm.send).not.toHaveBeenCalled();
    expect(h.database.completeNotification).toHaveBeenCalledWith("event");
    expect(h.message.reply.mock.invocationCallOrder[0]).toBeLessThan(h.database.completeNotification.mock.invocationCallOrder[0]!);
  });

  it("skips an unchanged edit but still sends the terminal reply", async () => {
    const h = harness(visibleStatusHash(report, targetContextFromReport(report)));
    await h.worker.processOne();
    expect(h.message.edit).not.toHaveBeenCalled();
    expect(h.message.reply).toHaveBeenCalledOnce();
  });

  it.each(["edit", "reply"] as const)("keeps a rejected Discord %s retryable", async (operation) => {
    const h = harness();
    h.message[operation].mockRejectedValue(new Error("Discord unavailable"));
    await h.worker.processOne();
    expect(h.database.retryNotification).toHaveBeenCalledWith("event", "Error");
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
