import { describe, expect, it, vi } from "vitest";

import {
  allowsLifecycleNotification,
  notificationCategory,
  type NotificationPreferences
} from "../src/notification-preferences.js";
import { BotDatabase } from "../src/database.js";

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
});
