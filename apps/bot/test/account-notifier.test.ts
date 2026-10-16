import type { ReportDetail } from "@nreport/contracts";
import type * as ObservabilityPackage from "@nreport/observability";
import { describe, expect, it, vi } from "vitest";

const captureLifecycleFailureMock = vi.hoisted(() => vi.fn());
vi.mock("@nreport/observability", async (importOriginal) => {
  const actual = await importOriginal<typeof ObservabilityPackage>();
  return { ...actual, captureLifecycleFailure: captureLifecycleFailureMock };
});

import { AccountNotificationWorker, cardNonce, reportRecoveryDelaySeconds } from "../src/account-notifier.js";
import type { ReportCardState } from "../src/account-database.js";
import { targetContextFromReport, visibleStatusHash } from "../src/report-ui.js";

const report: ReportDetail = {
  reportId: "11111111-1111-4111-8111-111111111111", traceId: "33333333-3333-4333-8333-333333333333", accountId: "account", flow: "message", useAi: true,
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

function harness(hash: string | null = null, eventId = "event", dmMessageId: string | null = "original-card") {
  const message = { edit: vi.fn().mockResolvedValue(undefined), reply: vi.fn().mockResolvedValue(undefined) };
  const dm = { messages: { fetch: vi.fn().mockResolvedValue(message) }, send: vi.fn() };
  const database = {
    claimNotification: vi.fn().mockResolvedValue(notificationItem(eventId, "report_failed", report.reportId, dmMessageId, hash)),
    notificationPreferences: vi.fn().mockResolvedValue({ decisionEnabled: true, reportDeniedEnabled: false, problemEnabled: true }),
    completeCardUpdate: vi.fn(), completeNotification: vi.fn(), retryNotification: vi.fn(), ignoreNotification: vi.fn(),
    cleanupExpiredForms: vi.fn().mockResolvedValue(undefined),
    adoptAutomaticNetworkRetry: vi.fn<() => Promise<"adopted" | "busy" | "unavailable" | "conflict">>().mockResolvedValue("unavailable"),
    reportCardState: vi.fn<(accountId: string, reportId: string) => Promise<ReportCardState | null>>().mockResolvedValue(null),
    connections: vi.fn().mockResolvedValue([]),
    pendingReportLinks: vi.fn().mockResolvedValue([]),
    dueCardRepairs: vi.fn().mockResolvedValue([]),
    rescheduleCardRepair: vi.fn().mockResolvedValue(undefined),
    notificationHealthSnapshot: vi.fn().mockResolvedValue({
      pendingNotificationCount: 0, oldestPendingNotificationAgeMs: null,
      pendingCardUpdateCount: 0, oldestPendingCardUpdateAgeMs: null
    }),
    claimDmCard: vi.fn().mockResolvedValue(null), setDmMapping: vi.fn().mockResolvedValue(undefined),
    releaseDmCard: vi.fn(), terminalCardRepair: vi.fn(), clearStaleDmMapping: vi.fn().mockResolvedValue(true)
  };
  const api = { report: vi.fn<(reportId: string) => Promise<ReportDetail>>().mockResolvedValue(report) };
  const client = { user: { id: "bot-user" }, users: { fetch: vi.fn().mockResolvedValue({ createDM: vi.fn().mockResolvedValue(dm) }) } };
  const logger = vi.fn<(event: string, fields?: Record<string, unknown>, level?: "info" | "warn" | "error") => void>();
  const worker = new AccountNotificationWorker(database as never, client as never, {} as never, () => api as never, undefined, logger);
  return { worker, database, api, message, dm, logger };
}

function notificationItem(
  eventId: string,
  eventType: string,
  reportId: string,
  dmMessageId: string | null,
  visiblePayloadHash: string | null
) {
  return {
    event_id: eventId,
    event_type: eventType,
    report_id: reportId,
    trace_id: report.traceId,
    account_id: report.accountId,
    lifecycle_attempt: report.lifecycleAttempt,
    attempts: 1,
    discord_user_id: "user",
    encrypted_api_key: "unused",
    dm_channel_id: dmMessageId === null ? null : "dm-channel",
    dm_message_id: dmMessageId,
    encrypted_target_context: null,
    visible_payload_hash: visiblePayloadHash,
    last_card_edit_at: null
  };
}

describe("notification delivery against an existing report card", () => {
  const predecessorId = report.reportId;
  const automaticChildId = "44444444-4444-4444-8444-444444444444";
  const manualChildId = "55555555-5555-4555-8555-555555555555";
  const restartingParent: ReportDetail = {
    ...report,
    status: "failed",
    connectionRecovery: {
      state: "restarting", attempt: 3, maxAttempts: 3, retryAt: null, successorReportId: automaticChildId
    },
    successorReportId: automaticChildId
  };
  const automaticChild: ReportDetail = {
    ...report,
    reportId: automaticChildId,
    status: "queued",
    predecessorReportId: predecessorId,
    automaticNetworkRetry: true,
    connectionRecovery: null,
    failure: null
  };
  const adoptedCardState: ReportCardState = {
    report_id: automaticChildId,
    discord_user_id: "user",
    account_id: report.accountId,
    superseded_by_report_id: null,
    dm_channel_id: "dm-channel",
    dm_message_id: "original-card",
    encrypted_target_context: null,
    visible_payload_hash: null,
    dm_card_nonce: cardNonce(predecessorId),
    dm_card_origin_report_id: predecessorId,
    dm_card_origin_claimed_at: new Date(Date.now() - 180_000)
  };

  it("adopts the direct child when the predecessor restarting event arrives first", async () => {
    const h = harness();
    h.database.claimNotification.mockResolvedValue(
      notificationItem("restart-event", "report_connection_restarting", predecessorId, "predecessor-card", "old-hash")
    );
    h.api.report.mockImplementation((reportId: string) => Promise.resolve(reportId === predecessorId ? restartingParent : automaticChild));
    h.database.adoptAutomaticNetworkRetry.mockResolvedValue("adopted");
    h.database.reportCardState.mockResolvedValue(adoptedCardState);

    await h.worker.processOne();

    expect(h.api.report.mock.calls.map(([id]) => id)).toEqual([predecessorId, automaticChildId]);
    expect(h.database.adoptAutomaticNetworkRetry).toHaveBeenCalledWith(report.accountId, predecessorId, automaticChildId);
    expect(h.dm.messages.fetch).toHaveBeenCalledWith("original-card");
    expect(h.message.edit).toHaveBeenCalledOnce();
    expect(h.dm.send).not.toHaveBeenCalled();
    expect(h.message.reply).not.toHaveBeenCalled();
    expect(h.database.completeNotification).toHaveBeenCalledWith("restart-event", 1);
  });

  it("adopts an automatic child when its event arrives before the predecessor restart event", async () => {
    const h = harness();
    h.database.claimNotification.mockResolvedValue(
      notificationItem("child-event", "report_queued", automaticChildId, null, null)
    );
    h.api.report.mockResolvedValue(automaticChild);
    h.database.adoptAutomaticNetworkRetry.mockResolvedValue("adopted");
    h.database.reportCardState.mockResolvedValue(adoptedCardState);

    await h.worker.processOne();

    expect(h.api.report).toHaveBeenCalledOnce();
    expect(h.api.report).toHaveBeenCalledWith(automaticChildId);
    expect(h.database.adoptAutomaticNetworkRetry).toHaveBeenCalledWith(report.accountId, predecessorId, automaticChildId);
    expect(h.dm.messages.fetch).toHaveBeenCalledWith("original-card");
    expect(h.message.edit).toHaveBeenCalledOnce();
    expect(h.dm.send).not.toHaveBeenCalled();
    expect(h.message.reply).not.toHaveBeenCalled();
  });

  it("does not send the predecessor's failure event as a terminal DM for the child", async () => {
    const h = harness();
    h.database.claimNotification.mockResolvedValue(
      notificationItem("late-parent-failure", "report_failed", predecessorId, "predecessor-card", null)
    );
    const failedChild: ReportDetail = {
      ...automaticChild,
      status: "failed",
      failure: { stage: "requesting_verification", code: "network_unavailable", message: "Connection failed." }
    };
    h.api.report.mockImplementation((reportId: string) => Promise.resolve(reportId === predecessorId ? restartingParent : failedChild));
    h.database.adoptAutomaticNetworkRetry.mockResolvedValue("adopted");
    h.database.reportCardState.mockResolvedValue(adoptedCardState);

    await h.worker.processOne();

    expect(h.message.edit).toHaveBeenCalledOnce();
    expect(h.message.reply).not.toHaveBeenCalled();
    expect(h.database.completeNotification).toHaveBeenCalledWith("late-parent-failure", 1);
  });

  it("ignores a delayed predecessor event when its automatic child was manually superseded", async () => {
    const h = harness();
    h.database.claimNotification.mockResolvedValue(
      notificationItem("late-restart-event", "report_connection_restarting", predecessorId, "predecessor-card", null)
    );
    const manuallySupersededChild = { ...automaticChild, successorReportId: manualChildId };
    h.api.report.mockImplementation((reportId: string) => Promise.resolve(reportId === predecessorId ? restartingParent : manuallySupersededChild));

    await h.worker.processOne();

    expect(h.database.adoptAutomaticNetworkRetry).not.toHaveBeenCalled();
    expect(h.api.report.mock.calls.map(([id]) => id)).toEqual([predecessorId, automaticChildId]);
    expect(h.api.report).not.toHaveBeenCalledWith(manualChildId);
    expect(h.database.reportCardState).not.toHaveBeenCalled();
    expect(h.message.edit).not.toHaveBeenCalled();
    expect(h.message.reply).not.toHaveBeenCalled();
    expect(h.dm.send).not.toHaveBeenCalled();
    expect(h.database.completeNotification).toHaveBeenCalledWith("late-restart-event", 1);
  });

  it("adopts a restarting predecessor during card repair before sending another card", async () => {
    const h = harness();
    h.database.connections.mockResolvedValue([{
      discord_user_id: "user", account_id: report.accountId, encrypted_api_key: "unused",
      username: "fixture", key_prefix: "dsa_fixture", event_cursor: "0", connected_at: new Date()
    }]);
    h.database.dueCardRepairs.mockResolvedValue([{
      report_id: predecessorId, discord_user_id: "user", encrypted_target_context: null,
      card_repair_attempts: 1, trace_id: report.traceId
    }]);
    h.api.report.mockImplementation((reportId: string) => Promise.resolve(reportId === predecessorId ? restartingParent : automaticChild));
    h.database.adoptAutomaticNetworkRetry.mockResolvedValue("adopted");
    h.database.reportCardState.mockResolvedValue(adoptedCardState);

    await h.worker.recoverOnce();

    expect(h.api.report.mock.calls.map(([id]) => id)).toEqual([predecessorId, automaticChildId]);
    expect(h.database.adoptAutomaticNetworkRetry).toHaveBeenCalledWith(report.accountId, predecessorId, automaticChildId);
    expect(h.dm.messages.fetch).toHaveBeenCalledWith("original-card");
    expect(h.message.edit).toHaveBeenCalledOnce();
    expect(h.dm.send).not.toHaveBeenCalled();
    expect(h.database.completeCardUpdate).toHaveBeenCalledWith(
      automaticChildId, expect.any(String)
    );
  });

  it("reconciles an accepted predecessor card after a lost mapping before sending the automatic child", async () => {
    const h = harness(null, "lost-parent-card", null);
    const identity = {
      nonce: cardNonce(predecessorId),
      originReportId: predecessorId,
      originClaimedAt: new Date(Date.now() - 180_000),
      relatedReportIds: [predecessorId, automaticChildId],
      relatedReportIdsComplete: true
    };
    const acceptedParentCard = {
      id: "accepted-parent-card",
      channelId: "dm-channel",
      author: { id: "bot-user" },
      nonce: null,
      content: "",
      components: [{ components: [{ content: `Report ID: \`${predecessorId}\`` }] }],
      createdTimestamp: Date.now() - 179_000,
      edit: vi.fn().mockResolvedValue(undefined)
    };
    const acceptedMessages = new Map([[acceptedParentCard.id, acceptedParentCard]]);
    const originalSend = vi.fn((payload: { nonce: string }) => {
      expect(payload.nonce).toBe(identity.nonce);
      return Promise.resolve(acceptedParentCard);
    });
    await originalSend({ nonce: identity.nonce });
    h.database.claimNotification.mockResolvedValue(
      notificationItem("lost-parent-card", "report_connection_restarting", predecessorId, null, null)
    );
    h.api.report.mockImplementation((reportId: string) => Promise.resolve(reportId === predecessorId ? restartingParent : automaticChild));
    h.database.adoptAutomaticNetworkRetry.mockResolvedValue("adopted");
    h.database.reportCardState.mockResolvedValue({
      ...adoptedCardState,
      dm_channel_id: null,
      dm_message_id: null,
      dm_card_nonce: identity.nonce,
      dm_card_origin_report_id: identity.originReportId,
      dm_card_origin_claimed_at: identity.originClaimedAt
    });
    h.database.claimDmCard.mockResolvedValue(identity);
    h.dm.messages.fetch.mockImplementation((query: unknown) => {
      if (typeof query === "object" && query !== null && "limit" in query) {
        return Promise.resolve(acceptedMessages) as never;
      }
      return Promise.resolve(acceptedParentCard) as never;
    });

    await h.worker.processOne();

    expect(h.database.claimDmCard).toHaveBeenCalledWith(automaticChildId);
    expect(h.database.setDmMapping).toHaveBeenCalledWith(automaticChildId, "dm-channel", "accepted-parent-card");
    expect(acceptedParentCard.edit).toHaveBeenCalledOnce();
    expect(h.dm.send).not.toHaveBeenCalled();
    expect(h.database.completeNotification).toHaveBeenCalledWith("lost-parent-card", 1);
    expect(h.dm.messages.fetch).toHaveBeenCalledWith({ limit: 100 });
    expect(originalSend).toHaveBeenCalledOnce();
    expect(acceptedMessages.size).toBe(1);
    expect(acceptedMessages.has(acceptedParentCard.id)).toBe(true);
  });

  it("finds an accepted automatic-child card by its footer after manual transfer when history omits the nonce", async () => {
    const h = harness(null, "manual-child-card", null);
    const manualChild = {
      ...automaticChild, reportId: manualChildId, predecessorReportId: automaticChildId,
      automaticNetworkRetry: false, successorReportId: null
    };
    const identity = {
      nonce: cardNonce(predecessorId),
      originReportId: predecessorId,
      originClaimedAt: new Date(Date.now() - 180_000),
      relatedReportIds: [predecessorId, automaticChildId, manualChildId],
      relatedReportIdsComplete: true
    };
    const acceptedAutomaticCard = {
      id: "accepted-automatic-card",
      channelId: "dm-channel",
      author: { id: "bot-user" },
      nonce: null,
      content: "",
      components: [{ components: [{ content: `Report ID: \`${automaticChildId}\`\nReporter email: \`redacted@example.test\`` }] }],
      createdTimestamp: Date.now() - 120_000,
      edit: vi.fn().mockResolvedValue(undefined)
    };
    h.database.claimNotification.mockResolvedValue(
      notificationItem("manual-child-card", "report_queued", manualChildId, null, null)
    );
    h.api.report.mockResolvedValue(manualChild);
    h.database.claimDmCard.mockResolvedValue(identity);
    h.dm.messages.fetch.mockImplementation((query: unknown) => {
      if (typeof query === "object" && query !== null && "limit" in query) {
        return Promise.resolve(new Map([[acceptedAutomaticCard.id, acceptedAutomaticCard]])) as never;
      }
      return Promise.resolve(acceptedAutomaticCard) as never;
    });

    await h.worker.processOne();

    expect(h.database.setDmMapping).toHaveBeenCalledWith(manualChildId, "dm-channel", "accepted-automatic-card");
    expect(acceptedAutomaticCard.edit).toHaveBeenCalledOnce();
    expect(h.dm.send).not.toHaveBeenCalled();
    expect(h.database.completeNotification).toHaveBeenCalledWith("manual-child-card", 1);
  });

  it("defers an uncertain child card send when the bounded DM scan cannot cover the original claim", async () => {
    const h = harness(null, "uncovered-parent-card", null);
    const claimedAt = new Date(Date.now() - 180_000);
    const identity = {
      nonce: cardNonce(predecessorId),
      originReportId: predecessorId,
      originClaimedAt: claimedAt,
      relatedReportIds: [predecessorId, automaticChildId],
      relatedReportIdsComplete: true
    };
    const history = new Map(Array.from({ length: 100 }, (_, index) => [`newer-${index}`, {
      id: `newer-${index}`,
      channelId: "dm-channel",
      author: { id: "bot-user" },
      nonce: null,
      content: "unrelated",
      components: [],
      createdTimestamp: claimedAt.getTime() + 10_000 + index
    }]));
    h.database.claimNotification.mockResolvedValue(
      notificationItem("uncovered-parent-card", "report_connection_restarting", predecessorId, null, null)
    );
    h.api.report.mockImplementation((reportId: string) => Promise.resolve(reportId === predecessorId ? restartingParent : automaticChild));
    h.database.adoptAutomaticNetworkRetry.mockResolvedValue("adopted");
    h.database.reportCardState.mockResolvedValue({
      ...adoptedCardState,
      dm_channel_id: null,
      dm_message_id: null,
      dm_card_nonce: identity.nonce,
      dm_card_origin_report_id: identity.originReportId,
      dm_card_origin_claimed_at: claimedAt
    });
    h.database.claimDmCard.mockResolvedValue(identity);
    h.dm.messages.fetch.mockResolvedValue(history);

    await h.worker.processOne();

    expect(h.dm.send).not.toHaveBeenCalled();
    expect(h.database.releaseDmCard).toHaveBeenCalledWith(automaticChildId);
    expect(h.database.retryNotification).toHaveBeenCalledWith(
      "uncovered-parent-card", "uncertain_card_delivery_history_incomplete", 1
    );
    expect(h.logger.mock.calls.some(([event]) => event === "account_card_delivery_uncertain")).toBe(true);
  });

  it("does not send when the persisted identity lineage exceeds its bounded report-ID set", async () => {
    const h = harness(null, "truncated-card-lineage", null);
    const claimedAt = new Date(Date.now() - 180_000);
    h.database.claimNotification.mockResolvedValue(
      notificationItem("truncated-card-lineage", "report_queued", report.reportId, null, null)
    );
    h.database.claimDmCard.mockResolvedValue({
      nonce: cardNonce(report.reportId),
      originReportId: report.reportId,
      originClaimedAt: claimedAt,
      relatedReportIds: [report.reportId],
      relatedReportIdsComplete: false
    });
    h.dm.messages.fetch.mockResolvedValue(new Map([["unrelated", {
      id: "unrelated", channelId: "dm-channel", author: { id: "bot-user" }, nonce: null,
      content: "unrelated message", components: [], embeds: [], createdTimestamp: Date.now()
    }]]));

    await h.worker.processOne();

    expect(h.dm.send).not.toHaveBeenCalled();
    expect(h.database.retryNotification).toHaveBeenCalledWith(
      "truncated-card-lineage", "uncertain_card_delivery_history_incomplete", 1
    );
  });

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
    expect(h.database.completeNotification).toHaveBeenCalledWith("event", 1);
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

  it("replays a terminal DM after completion persistence fails without creating a duplicate", async () => {
    const h = harness();
    const item = {
      event_id: "event", event_type: "report_failed", report_id: report.reportId,
      trace_id: report.traceId, account_id: report.accountId,
      lifecycle_attempt: 1, discord_user_id: "user",
      encrypted_api_key: "unused", encrypted_target_context: null,
      dm_message_id: "original-card", visible_payload_hash: null
    };
    h.database.claimNotification
      .mockResolvedValueOnce({ ...item, attempts: 1 })
      .mockResolvedValueOnce({ ...item, attempts: 2 });
    h.database.completeNotification.mockRejectedValueOnce(new Error("Database write failed after Discord accepted the reply."));

    const acceptedNonces = new Set<string>();
    let createdMessages = 0;
    h.message.reply.mockImplementation((payload: Record<string, unknown>) => {
      const nonce = String(payload.nonce);
      if (!acceptedNonces.has(nonce)) {
        acceptedNonces.add(nonce);
        createdMessages += 1;
      }
    });

    await h.worker.processOne();
    expect(h.database.retryNotification).toHaveBeenCalledWith("event", "unexpected", 1);
    expect(h.logger.mock.calls.some(([event]) => event === "account_notification_completed")).toBe(false);

    await h.worker.processOne();

    expect(createdMessages).toBe(1);
    expect(h.message.reply).toHaveBeenCalledTimes(2);
    expect(h.message.reply.mock.calls[0]?.[0]).toMatchObject({
      nonce: "nreport-b8e1f80bd70ae078", enforceNonce: true
    });
    expect(h.message.reply.mock.calls[1]?.[0]).toMatchObject({
      nonce: "nreport-b8e1f80bd70ae078", enforceNonce: true
    });
    expect(h.database.completeNotification).toHaveBeenLastCalledWith("event", 2);
  });

  it("uses a deterministic Discord-valid nonce when it must create a status card", async () => {
    const first = harness(null, "event", null);
    const retry = harness(null, "event", null);
    const created = { channelId: "dm", id: "card" };
    const identity = {
      nonce: cardNonce(report.reportId), originReportId: report.reportId, originClaimedAt: new Date(),
      relatedReportIds: [report.reportId], relatedReportIdsComplete: true
    };
    first.database.claimDmCard.mockResolvedValue(identity);
    retry.database.claimDmCard.mockResolvedValue(identity);
    first.dm.send.mockResolvedValue(created);
    retry.dm.send.mockResolvedValue(created);

    await first.worker.processOne();
    await retry.worker.processOne();

    const firstPayload = first.dm.send.mock.calls[0]?.[0] as { nonce?: string; enforceNonce?: boolean } | undefined;
    const retryPayload = retry.dm.send.mock.calls[0]?.[0] as { nonce?: string } | undefined;
    const firstNonce = firstPayload?.nonce;
    const retryNonce = retryPayload?.nonce;
    expect(firstNonce).toBe("card-bd7662a5eeb41614");
    expect(firstNonce).toHaveLength(21);
    expect(retryNonce).toBe(firstNonce);
    expect(firstPayload).toMatchObject({ enforceNonce: true });
  });

  it("logs claimed and completed outcomes with internal report correlation only", async () => {
    const h = harness();

    await h.worker.processOne();

    expect(h.logger).toHaveBeenCalledWith("account_notification_claimed", {
      reportId: report.reportId,
      traceId: "33333333-3333-4333-8333-333333333333", eventType: "report_failed", attempts: 1,
      stage: "notification", outcome: "claimed", durationMs: 0
    });
    const completedLog = h.logger.mock.calls.find(([event]) => event === "account_notification_completed");
    expect(completedLog?.[1]).toMatchObject({
      reportId: report.reportId,
      traceId: "33333333-3333-4333-8333-333333333333", eventType: "report_failed", attempts: 1,
      stage: "notification", outcome: "completed"
    });
    expect(typeof completedLog?.[1]?.durationMs).toBe("number");
    const serializedLogs = JSON.stringify(h.logger.mock.calls);
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
    h.message[operation].mockRejectedValue(new Error("Discord unavailable: https://user:password@discord.example.test/api"));
    await h.worker.processOne();
    expect(h.database.retryNotification).toHaveBeenCalledWith("event", "unexpected", 1);
    const retryLog = h.logger.mock.calls.find(([event]) => event === "account_notification_retry");
    expect(retryLog?.[1]).toMatchObject({
      reportId: report.reportId,
      traceId: "33333333-3333-4333-8333-333333333333", eventType: "report_failed", attempts: 1,
      stage: "notification", outcome: "retry",
      deliveryStage: operation === "edit" ? "edit_card" : "reply",
      errorName: "Error", failureCategory: "unexpected"
    });
    expect(typeof retryLog?.[1]?.durationMs).toBe("number");
    expect(retryLog?.[2]).toBe("warn");
    expect(JSON.stringify(h.logger.mock.calls)).not.toContain("user:password@discord.example.test");
    expect(JSON.stringify(h.logger.mock.calls)).toContain("[REDACTED_URL]");
    expect(h.database.completeNotification).not.toHaveBeenCalled();
    if (operation === "edit") expect(h.message.reply).not.toHaveBeenCalled();
  });

  it("captures the original actionable failure once with report, trace, attempt, stage, and status context", async () => {
    captureLifecycleFailureMock.mockClear();
    const h = harness();
    const error = Object.assign(new Error("Discord REST request failed"), {
      name: "DiscordAPIError", code: 50001, status: 503,
      cause: Object.assign(new Error("gateway unavailable"), { code: "ECONNRESET" })
    });
    h.message.edit.mockRejectedValue(error);

    await h.worker.processOne();
    await h.worker.processOne();

    expect(captureLifecycleFailureMock).toHaveBeenCalledOnce();
    expect(captureLifecycleFailureMock).toHaveBeenCalledWith(error, expect.objectContaining({
      service: "bot",
      operation: "lifecycle_notification_delivery",
      reportId: report.reportId,
      traceId: report.traceId,
      eventType: "report_failed",
      lifecycleAttempt: 1,
      deliveryStage: "edit_card",
      attempt: 1,
      outcome: "retrying",
      discordErrorCode: 50001,
      discordHttpStatus: 503
    }));
  });

  it("does not send expected card-claim contention to Sentry", async () => {
    captureLifecycleFailureMock.mockClear();
    const h = harness(null, "event", null);
    h.dm.messages.fetch.mockRejectedValue({ code: 10008 });
    h.database.claimDmCard.mockResolvedValue(null);

    await h.worker.processOne();

    expect(captureLifecycleFailureMock).not.toHaveBeenCalled();
    expect(h.logger).toHaveBeenCalledWith("account_notification_retry", expect.objectContaining({
      failureCategory: "card_claim_busy", outcome: "retry"
    }), "warn");
  });

  it("stops a Discord validation failure and records safe send-card diagnostics", async () => {
    const h = harness(null, "event", null);
    h.database.claimDmCard.mockResolvedValue({
      nonce: cardNonce(report.reportId), originReportId: report.reportId, originClaimedAt: new Date(),
      relatedReportIds: [report.reportId], relatedReportIdsComplete: true
    });
    h.dm.send.mockRejectedValue(Object.assign(new Error("Invalid Form Body"), {
      code: 50035,
      status: 400,
      rawError: {
        message: "Invalid Form Body",
        errors: { nonce: { _errors: [{ code: "BASE_TYPE_MAX_LENGTH", message: "Must be 25 or fewer in length." }] } }
      }
    }));

    await h.worker.processOne();

    expect(h.database.ignoreNotification).toHaveBeenCalledWith("event", "discord_validation_50035", 1);
    expect(h.database.retryNotification).not.toHaveBeenCalled();
    expect(h.logger).toHaveBeenCalledWith("account_notification_ignored", expect.objectContaining({
      reportId: report.reportId,
      deliveryStage: "send_card",
      errorCode: "50035",
      httpStatus: 400,
      discordValidation: { message: "Invalid Form Body", paths: ["nonce:BASE_TYPE_MAX_LENGTH"] },
      payload: expect.objectContaining({ nonceLength: 21 }) as Record<string, unknown>
    }), "warn");
  });

  it("does not create a duplicate card while another worker owns its claim", async () => {
    const h = harness();
    h.dm.messages.fetch.mockRejectedValue({ code: 10008 });
    await h.worker.processOne();
    expect(h.dm.send).not.toHaveBeenCalled();
    expect(h.database.retryNotification).toHaveBeenCalledWith("event", "status_card_creation_in_progress", 1);
    expect(h.database.completeNotification).not.toHaveBeenCalled();
  });

  it("does no API or Discord work when the outbox is empty", async () => {
    const h = harness();
    h.database.claimNotification.mockResolvedValue(null);
    expect(await h.worker.processOne()).toBe(false);
    expect(h.api.report).not.toHaveBeenCalled();
    expect(h.dm.messages.fetch).not.toHaveBeenCalled();
  });

  it("alerts only after sustained backlog and re-arms after sustained recovery", async () => {
    captureLifecycleFailureMock.mockClear();
    const h = harness();
    h.database.notificationHealthSnapshot
      .mockResolvedValueOnce({ pendingNotificationCount: 1, oldestPendingNotificationAgeMs: 360_000, pendingCardUpdateCount: 0, oldestPendingCardUpdateAgeMs: null })
      .mockResolvedValueOnce({ pendingNotificationCount: 1, oldestPendingNotificationAgeMs: 420_000, pendingCardUpdateCount: 1, oldestPendingCardUpdateAgeMs: 360_000 })
      .mockResolvedValueOnce({ pendingNotificationCount: 1, oldestPendingNotificationAgeMs: 420_000, pendingCardUpdateCount: 1, oldestPendingCardUpdateAgeMs: 420_000 })
      .mockResolvedValueOnce({ pendingNotificationCount: 0, oldestPendingNotificationAgeMs: null, pendingCardUpdateCount: 0, oldestPendingCardUpdateAgeMs: null })
      .mockResolvedValueOnce({ pendingNotificationCount: 0, oldestPendingNotificationAgeMs: null, pendingCardUpdateCount: 0, oldestPendingCardUpdateAgeMs: null })
      .mockResolvedValueOnce({ pendingNotificationCount: 1, oldestPendingNotificationAgeMs: 360_000, pendingCardUpdateCount: 0, oldestPendingCardUpdateAgeMs: null })
      .mockResolvedValueOnce({ pendingNotificationCount: 1, oldestPendingNotificationAgeMs: 360_000, pendingCardUpdateCount: 0, oldestPendingCardUpdateAgeMs: null });

    await h.worker.sampleNotificationHealthOnce();
    expect(captureLifecycleFailureMock).not.toHaveBeenCalled();
    await h.worker.sampleNotificationHealthOnce();
    expect(captureLifecycleFailureMock).toHaveBeenCalledTimes(1);
    await h.worker.sampleNotificationHealthOnce();
    expect(captureLifecycleFailureMock).toHaveBeenCalledTimes(2);
    expect(captureLifecycleFailureMock).toHaveBeenNthCalledWith(1, expect.any(Error), expect.objectContaining({
      operation: "notification_backlog", queueCount: 1, oldestAgeMs: 420_000
    }));
    expect(captureLifecycleFailureMock).toHaveBeenNthCalledWith(2, expect.any(Error), expect.objectContaining({
      operation: "stuck_card_updates", queueCount: 1, oldestAgeMs: 420_000
    }));

    await h.worker.sampleNotificationHealthOnce();
    await h.worker.sampleNotificationHealthOnce();
    await h.worker.sampleNotificationHealthOnce();
    expect(captureLifecycleFailureMock).toHaveBeenCalledTimes(2);
    await h.worker.sampleNotificationHealthOnce();
    expect(captureLifecycleFailureMock).toHaveBeenCalledTimes(3);
  });

  it("does not alert on one transient high sample", async () => {
    captureLifecycleFailureMock.mockClear();
    const h = harness();
    h.database.notificationHealthSnapshot
      .mockResolvedValueOnce({ pendingNotificationCount: 1, oldestPendingNotificationAgeMs: 360_000, pendingCardUpdateCount: 0, oldestPendingCardUpdateAgeMs: null })
      .mockResolvedValueOnce({ pendingNotificationCount: 0, oldestPendingNotificationAgeMs: null, pendingCardUpdateCount: 0, oldestPendingCardUpdateAgeMs: null });

    await h.worker.sampleNotificationHealthOnce();
    await h.worker.sampleNotificationHealthOnce();

    expect(captureLifecycleFailureMock).not.toHaveBeenCalled();
  });
});
