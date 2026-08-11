import { describe, expect, it } from "vitest";

import {
  classifyCaseOutcome,
  durationMetric,
  rateMetric,
  recurringPatterns,
  resolveAnalyticsInterval,
  sanitizePatternText,
  suppressCommunityBreakdown
} from "../src/analytics.js";

describe("analytics rules", () => {
  it("resolves a seven-day interval in UTC", () => {
    const interval = resolveAnalyticsInterval("7d", new Date("2026-08-11T12:00:00.000Z"));

    expect(interval).toMatchObject({
      startAt: "2026-08-04T12:00:00.000Z",
      endAt: "2026-08-11T12:00:00.000Z",
      timezone: "UTC"
    });
  });

  it("starts a YTD interval at the UTC new year", () => {
    expect(resolveAnalyticsInterval("ytd", new Date("2026-08-11T12:00:00.000Z"))).toMatchObject({
      startAt: "2026-01-01T00:00:00.000Z",
      timezone: "UTC"
    });
  });

  it("classifies action after appeal separately", () => {
    expect(classifyCaseOutcome([
      { type: "discord_status_updated", discordStatus: "closed_no_action" },
      { type: "review_requested", discordStatus: null },
      { type: "discord_status_updated", discordStatus: "actioned" }
    ])).toBe("appeal_actioned");
  });

  it("does not classify an action without an earlier closure as appeal actioned", () => {
    expect(classifyCaseOutcome([
      { type: "review_requested", discordStatus: null },
      { type: "discord_status_updated", discordStatus: "actioned" }
    ])).toBe("direct_actioned");
  });

  it("does not let an out-of-order review request rewrite a direct action", () => {
    expect(classifyCaseOutcome([
      { type: "discord_status_updated", discordStatus: "actioned" },
      { type: "review_requested", discordStatus: null }
    ])).toBe("direct_actioned");
  });

  it("uses a later appeal denial as the current terminal outcome", () => {
    expect(classifyCaseOutcome([
      { type: "discord_status_updated", discordStatus: "closed_no_action" },
      { type: "review_requested", discordStatus: null },
      { type: "discord_status_updated", discordStatus: "actioned" },
      { type: "discord_status_updated", discordStatus: "review_not_approved" }
    ])).toBe("appeal_denied");
  });

  it("does not turn an empty denominator into zero percent", () => {
    expect(rateMetric(0, 0)).toEqual({ numerator: 0, denominator: 0, percentage: null });
  });

  it("calculates percentile durations from sorted numeric samples", () => {
    expect(durationMetric([90, 10, 20, 30, 40])).toEqual({
      sampleSize: 5,
      medianSeconds: 30,
      p90Seconds: 90
    });
  });

  it("uses the mean of both middle duration samples", () => {
    expect(durationMetric([10, 20])).toMatchObject({ medianSeconds: 15 });
  });

  it("suppresses a community bucket represented by too few users", () => {
    expect(suppressCommunityBreakdown([
      { key: "message_urf", label: "Message", reportCount: 8, userCount: 5 },
      { key: "guild_urf", label: "Server", reportCount: 2, userCount: 2 }
    ])).toEqual([{ key: "message_urf", label: "Message", count: 8, percentage: 100 }]);
  });

  it("keeps a community bucket at the three-report and three-user boundary", () => {
    expect(suppressCommunityBreakdown([
      { key: "message_urf", label: "Message", reportCount: 3, userCount: 3 },
      { key: "guild_urf", label: "Server", reportCount: 2, userCount: 3 }
    ])).toEqual([{ key: "message_urf", label: "Message", count: 3, percentage: 100 }]);
  });

  it("removes links, snowflakes, mentions, and rare phrases", () => {
    const patterns = recurringPatterns([
      { userId: "u1", text: "Repeated hateful threat https://example.test/1197857362942378017" },
      { userId: "u2", text: "Repeated hateful threat <@1197857362942378017>" },
      { userId: "u3", text: "Repeated hateful threat" },
      { userId: "u4", text: "Repeated hateful threat" },
      { userId: "u5", text: "Repeated hateful threat" }
    ], "community");

    expect(patterns[0]).toMatchObject({ phrase: "repeated hateful threat", reportCount: 5 });
    expect(JSON.stringify(patterns)).not.toContain("1197857362942378017");
  });

  it("removes email-like values, punctuation, standalone numbers, and stop words", () => {
    expect(sanitizePatternText("The !!! user@example.test 42 repeated threats")).toEqual([
      "repeated",
      "threats"
    ]);
  });

  it("removes bare-domain and non-HTTP URLs without removing ordinary words", () => {
    expect(sanitizePatternText("ordinary www.example.test/path ftp://files.example.test/item harmless")).toEqual([
      "ordinary",
      "harmless"
    ]);
  });

  it("removes a bare domain with a path while preserving ordinary dotted punctuation", () => {
    expect(sanitizePatternText("ordinary example.test/path harmless. e.g., still here")).toEqual([
      "ordinary",
      "harmless",
      "e",
      "g",
      "still",
      "here"
    ]);
  });

  it("requires three distinct users for a community pattern", () => {
    expect(recurringPatterns([
      { userId: "u1", text: "coordinated threat" },
      { userId: "u1", text: "coordinated threat" },
      { userId: "u2", text: "coordinated threat" },
      { userId: "u2", text: "coordinated threat" },
      { userId: "u2", text: "coordinated threat" }
    ], "community")).toEqual([]);
  });

  it("allows personal patterns after two reports", () => {
    expect(recurringPatterns([
      { userId: "u1", text: "repeated threat" },
      { userId: "u1", text: "repeated threat" }
    ], "personal")).toContainEqual({ phrase: "repeated threat", reportCount: 2 });
  });
});
