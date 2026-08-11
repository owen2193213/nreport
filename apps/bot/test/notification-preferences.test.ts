import { describe, expect, it, vi } from "vitest";
import type { Client } from "discord.js";
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

  it("suppresses a disabled category before any Discord or report fetch", async () => {
    const completeNotification = vi.fn().mockResolvedValue(undefined);
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
        preferences
      }]),
      completeNotification
    } as unknown as BotDatabase;
    const report = vi.fn();
    const fetch = vi.fn();
    const worker = new NotificationWorker(
      database,
      { lifecycleEvents: vi.fn().mockResolvedValue({ events: [] }), report } as unknown as DsaApi,
      { users: { fetch } } as unknown as Client,
      {} as BotConfig,
      {} as ServerResolver
    );

    await worker.tick();

    expect(completeNotification).toHaveBeenCalledWith("41");
    expect(report).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
});
