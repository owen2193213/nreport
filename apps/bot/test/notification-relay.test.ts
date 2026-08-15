import { describe, expect, it, vi } from "vitest";
import type { ReportDetail } from "@discord-dsa/contracts";
import { EmbedBuilder, WebhookClient } from "discord.js";

import {
  isReportedMessageAuthor,
  relayNotificationToWebhook
} from "../src/notification-relay.js";

function reportFixture(overrides: Partial<ReportDetail> = {}): ReportDetail {
  return {
    internalReportId: "test-report-1",
    country: "DE",
    flow: "message_urf",
    reportType: "sub_other_hate_speech",
    submitterDiscordUserId: "1197857362942378017",
    pseudonym: "hidden",
    email: "hidden@example.invalid",
    locale: "de-DE",
    timezone: "Europe/Berlin",
    lifecycleAttempt: 1,
    retryable: false,
    retryOfReportId: null,
    retriedAsReportId: null,
    retrySequence: 0,
    failureStage: null,
    status: "submitted",
    discordReportId: "1527695430949798110",
    discordStatus: "actioned",
    discordStatusUpdatedAt: "2026-07-20T00:00:00.000Z",
    reviewStatus: null,
    reviewStatusUpdatedAt: null,
    reviewError: null,
    appealRetryable: false,
    resubmittable: false,
    error: null,
    createdAt: "2026-07-19T00:00:00.000Z",
    updatedAt: "2026-07-20T00:00:00.000Z",
    reportedDetails: {
      kind: "message",
      messageUrl: "https://discord.com/channels/1/2/3",
      messageEvidence: {
        source: "context_menu",
        status: "captured",
        capturedAt: "2026-07-19T00:00:01.000Z",
        snapshot: {
          messageId: "3",
          channelId: "2",
          channelName: "general",
          serverId: "1",
          serverName: "Server",
          authorId: "504116640007323648",
          authorUsername: "target_user",
          authorDisplayName: "Target User",
          authorAvatarUrl: null,
          authorBot: false,
          content: "Reported message text",
          createdAt: "2026-07-19T00:00:00.000Z",
          attachments: [],
          embeds: []
        }
      },
      reportReason: "Hate speech",
      context: "context"
    },
    timeline: [],
    ...overrides
  };
}

describe("notification-relay", () => {
  it("matches when message report has captured snapshot author matching target ID", () => {
    const report = reportFixture();
    expect(isReportedMessageAuthor(report, "504116640007323648")).toBe(true);
  });

  it("does not match when message report author is different", () => {
    const report = reportFixture();
    expect(isReportedMessageAuthor(report, "999999999999999999")).toBe(false);
  });

  it("does not match when message evidence status is unavailable", () => {
    const report = reportFixture({
      reportedDetails: {
        kind: "message",
        messageUrl: "https://discord.com/channels/1/2/3",
        messageEvidence: {
          source: "message_link",
          status: "unavailable",
          attemptedAt: "2026-07-19T00:00:00.000Z"
        }
      }
    });
    expect(isReportedMessageAuthor(report, "504116640007323648")).toBe(false);
  });

  it("does not match profile reports", () => {
    const report = reportFixture({
      reportedDetails: {
        kind: "profile",
        reportedUsername: "target_user",
        reportedUserId: "504116640007323648",
        profileElements: ["name"]
      }
    });
    expect(isReportedMessageAuthor(report, "504116640007323648")).toBe(false);
  });

  it("does not match server reports", () => {
    const report = reportFixture({
      reportedDetails: {
        kind: "server",
        guildIdOrInviteCode: "1535781932585984090",
        guildElements: ["name"]
      }
    });
    expect(isReportedMessageAuthor(report, "504116640007323648")).toBe(false);
  });

  it("sends notification embed and decision to webhook client", async () => {
    const send = vi.fn().mockResolvedValue({ id: "webhook-msg-1" });
    const destroy = vi.fn();
    vi.spyOn(WebhookClient.prototype, "send").mockImplementation(send);
    vi.spyOn(WebhookClient.prototype, "destroy").mockImplementation(destroy);

    const embed = new EmbedBuilder().setTitle("Report Status");
    const decision = new EmbedBuilder().setTitle("Decision");

    await relayNotificationToWebhook(
      "https://discord.com/api/webhooks/123456789012345678/dummy_test_token_abcdefghijklmnop",
      embed,
      decision,
      "Report accepted."
    );

    expect(send).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith({
      content: "Report accepted.",
      embeds: [embed, decision],
      allowedMentions: { parse: [] }
    });
    expect(destroy).toHaveBeenCalledOnce();
  });
});
