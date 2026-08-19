import { describe, expect, it, vi } from "vitest";
import type { Client, Interaction } from "discord.js";
import type { DsaApi } from "@discord-dsa/contracts";

import {
  allowsLifecycleNotification,
  notificationCategory,
  type NotificationPreferences
} from "../src/notification-preferences.js";
import { BotDatabase } from "../src/database.js";
import type { BotConfig } from "../src/config.js";
import { NotificationWorker } from "../src/notifier.js";
import type { ServerResolver } from "../src/server-resolver.js";
import { notificationSettingsView } from "../src/settings-ui.js";
import { COMMANDS } from "../src/commands.js";
import { InteractionHandler } from "../src/interactions.js";
import type { MessageResolver } from "../src/message-resolver.js";
import type { ProfileResolver } from "../src/profile-resolver.js";
import type { ReportWriter } from "../src/report-writer.js";

function interactionHandler(database: BotDatabase): InteractionHandler {
  return new InteractionHandler({
    api: {} as DsaApi,
    config: { adminUserIds: new Set<string>(), whitelistEnabled: false } as unknown as BotConfig,
    countries: ["DE"],
    database,
    messageResolver: {} as MessageResolver,
    profileResolver: {} as ProfileResolver,
    reportWriter: {} as ReportWriter,
    serverResolver: {} as ServerResolver
  });
}

const preferences: NotificationPreferences = {
  submissionResults: true,
  actioned: false,
  declined: true,
  appealProgress: false,
  digestFrequency: "weekly"
};

describe("notification preferences", () => {
  it.each([
    ["report_submitted", "submission_results"], ["report_failed", "submission_results"],
    ["discord:received", "submission_results"], ["discord:actioned", "actioned"],
    ["discord:closed_no_action", "declined"], ["discord:review_not_approved", "declined"],
    ["review_requested", "appeal_progress"], ["review_received", "appeal_progress"],
    ["review_confirmation_timeout", "appeal_progress"], ["review_request_failed", "appeal_progress"],
    ["review_ineligible", "appeal_progress"], ["review_request_ambiguous", "appeal_progress"]
  ])("maps %s to %s", (eventType, category) => {
    expect(notificationCategory(eventType)).toBe(category);
  });

  it("checks the matching current preference and rejects unknown events", () => {
    expect(allowsLifecycleNotification("discord:actioned", preferences)).toBe(false);
    expect(allowsLifecycleNotification("discord:closed_no_action", preferences)).toBe(true);
    expect(allowsLifecycleNotification("review_requested", preferences)).toBe(false);
    expect(allowsLifecycleNotification("unknown", preferences)).toBe(false);
  });

  it("registers both settings areas and renders complete weekly defaults", () => {
    const command = COMMANDS.find((candidate) => candidate.name === "settings");
    expect(command?.options?.map((option) => option.name)).toEqual(["country", "notifications"]);
    const text = JSON.stringify(notificationSettingsView({
      submissionResults: true,
      actioned: true,
      declined: true,
      appealProgress: true,
      digestFrequency: "weekly"
    }));
    expect(text).toContain("Submission results");
    expect(text).toContain("Actioned");
    expect(text).toContain("Declined");
    expect(text).toContain("Appeal progress");
    expect(text).toContain("Weekly");
  });

  it("persists only the fixed preference column and returns the complete state", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{
        notify_submission_results: true, notify_actioned: false, notify_declined: true,
        notify_appeal_progress: true, digest_frequency: "weekly"
      }] });
    const database = new BotDatabase("postgres://unused", { query } as never);

    await expect(database.setNotificationPreference("user-1", "actioned", false)).resolves.toMatchObject({
      actioned: false, digestFrequency: "weekly"
    });
    expect(String(query.mock.calls[1]?.[0])).toContain("SET notify_actioned = $2");
    expect(query.mock.calls[1]?.[1]).toEqual(["user-1", false]);
  });

  it("edits the status embed but suppresses replies when category is disabled", async () => {
    const completeNotification = vi.fn().mockResolvedValue(undefined);
    const getNotificationPreferences = vi.fn().mockResolvedValue(preferences);
    const claimedPreferences = { ...preferences, actioned: true };
    const edit = vi.fn().mockResolvedValue(undefined);
    const reply = vi.fn().mockResolvedValue(undefined);
    const send = vi.fn().mockResolvedValue(undefined);
    const database = {
      claimDueTrackings: vi.fn().mockResolvedValue([]),
      reconciliationCursor: vi.fn().mockResolvedValue("0"),
      setReconciliationCursor: vi.fn(),
      claimNotifications: vi.fn().mockResolvedValue([{
        id: "41",
        tracking_id: "tracking-1",
        discord_user_id: "1197857362942378017",
        payload: {
          eventId: "42",
          eventType: "discord:actioned",
          internalReportId: "report-1",
          occurredAt: "2026-08-11T00:00:00.000Z"
        },
        attempts: 1,
        preferences: claimedPreferences
      }]),
      getNotificationPreferences,
      statusDmMessageId: vi.fn().mockResolvedValue("dm-message-1"),
      aiDecisions: vi.fn().mockResolvedValue([]),
      serverSnapshot: vi.fn().mockResolvedValue(null),
      completeNotification,
      failNotification: vi.fn().mockResolvedValue(undefined)
    } as unknown as BotDatabase;
    const report = {
      internalReportId: "report-1",
      country: "DE" as const,
      flow: "message_urf" as const,
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
      status: "submitted" as const,
      discordReportId: "1527695430949798110",
      discordStatus: "actioned" as const,
      discordStatusUpdatedAt: "2026-07-20T00:00:00.000Z",
      reviewStatus: null,
      reviewStatusUpdatedAt: null,
      reviewError: null,
      appealRetryable: false,
      resubmittable: false,
      error: null,
      timeline: [],
      createdAt: "2026-07-19T00:00:00.000Z",
      updatedAt: "2026-07-20T00:00:00.000Z",
      reportedDetails: {
        kind: "message" as const,
        messageUrl: "https://discord.com/channels/@me/123456789012345678/123456789012345679",
        messageEvidence: {
          source: "context_menu" as const,
          guildId: null,
          channelId: "123456789012345678",
          messageId: "123456789012345679",
          author: {
            id: "123456789012345680",
            username: "reported-user",
            displayName: "Reported User"
          },
          content: "Bad message",
          attachments: []
        }
      }
    };
    const reportFn = vi.fn().mockResolvedValue(report);
    const worker = new NotificationWorker(
      database,
      { lifecycleEvents: vi.fn().mockResolvedValue({ events: [] }), report: reportFn } as unknown as DsaApi,
      {
        users: {
          fetch: vi.fn().mockResolvedValue({
            createDM: vi.fn().mockResolvedValue({
              messages: {
                fetch: vi.fn().mockResolvedValue({ edit, reply })
              }
            }),
            send
          })
        }
      } as unknown as Client,
      {} as BotConfig,
      {} as ServerResolver
    );

    await worker.tick();

    expect(getNotificationPreferences).toHaveBeenCalledWith("1197857362942378017");
    expect(reportFn).toHaveBeenCalledWith("report-1");
    expect(edit).toHaveBeenCalledOnce();
    expect(reply).not.toHaveBeenCalled();
    expect(completeNotification).toHaveBeenCalledWith("41");
  });

  it("toggles Actioned for only the interaction user", async () => {
    const setNotificationPreference = vi.fn().mockResolvedValue({ ...preferences, actioned: false });
    const editReply = vi.fn().mockResolvedValue(undefined);
    const interaction = {
      isAutocomplete: () => false, isMessageContextMenuCommand: () => false,
      isChatInputCommand: () => false, isModalSubmit: () => false,
      isStringSelectMenu: () => false, isButton: () => true, isRepliable: () => true,
      customId: "settings:notifications:toggle:actioned:false",
      user: { id: "1197857362942378017" },
      deferUpdate: vi.fn().mockResolvedValue(undefined), editReply,
      deferred: false, replied: false
    } as unknown as Interaction;

    await interactionHandler({ setNotificationPreference } as unknown as BotDatabase).handle(interaction);

    expect(setNotificationPreference).toHaveBeenCalledWith("1197857362942378017", "actioned", false);
    expect(editReply).toHaveBeenCalledWith(expect.objectContaining({ allowedMentions: { parse: [] } }));
  });

  it("selects Monthly for only the interaction user", async () => {
    const setDigestFrequency = vi.fn().mockResolvedValue({ ...preferences, digestFrequency: "monthly" });
    const interaction = {
      isAutocomplete: () => false, isMessageContextMenuCommand: () => false,
      isChatInputCommand: () => false, isModalSubmit: () => false,
      isStringSelectMenu: () => true, isButton: () => false, isRepliable: () => true,
      customId: "settings:notifications:digest", values: ["monthly"],
      user: { id: "1197857362942378017" },
      deferUpdate: vi.fn().mockResolvedValue(undefined), editReply: vi.fn().mockResolvedValue(undefined),
      deferred: false, replied: false
    } as unknown as Interaction;

    await interactionHandler({ setDigestFrequency } as unknown as BotDatabase).handle(interaction);

    expect(setDigestFrequency).toHaveBeenCalledWith("1197857362942378017", "monthly");
  });
});
