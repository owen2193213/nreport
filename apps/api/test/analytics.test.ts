import { describe, expect, it } from "vitest";

import {
  aggregateAnalyticsRows,
  classifyCaseOutcome,
  decodeActionHistoryCursor,
  digestEligible,
  durationMetric,
  encodeActionHistoryCursor,
  rateMetric,
  recurringPatterns,
  resolveAnalyticsInterval,
  sanitizePatternText,
  suppressCommunityBreakdown
} from "../src/analytics.js";

describe("analytics rules", () => {
  it.each([
    [2, 2, false], [3, 0, true], [0, 3, true]
  ])("uses only personal digest thresholds (%s reports, %s changes)", (reports, changes, eligible) => {
    expect(digestEligible(reports, changes)).toBe(eligible);
  });
  it("counts a retry chain as one case while retaining attempt reliability", () => {
    expect(aggregateAnalyticsRows({
      reports: [
        {
          id: "root-1",
          rootId: "root-1",
          retryOfReportId: null,
          createdAt: "2026-08-05T00:00:00.000Z",
          status: "failed",
          discordReportId: null,
          flow: "message",
          category: "illegal_content",
          country: "DE",
          accountId: "account-1",
          submittedText: "first attempt"
        },
        {
          id: "retry-1",
          rootId: "root-1",
          retryOfReportId: "root-1",
          createdAt: "2026-08-05T01:00:00.000Z",
          status: "submitted",
          discordReportId: "discord-1",
          flow: "message",
          category: "illegal_content",
          country: "DE",
          accountId: "account-1",
          submittedText: "second attempt"
        }
      ],
      events: [
        {
          reportId: "retry-1",
          type: "report_submitted",
          occurredAt: "2026-08-05T01:02:00.000Z",
          discordStatus: null
        },
        {
          reportId: "retry-1",
          type: "discord_status_updated",
          occurredAt: "2026-08-06T01:02:00.000Z",
          discordStatus: "actioned"
        }
      ]
    })).toMatchObject({
      volume: { newCases: 1, attempts: 2, retries: 1, sentAttempts: 1 },
      outcomes: { directActioned: 1, appealActioned: 0 }
    });
  });

  it("counts action after closure and review request as an appeal action", () => {
    expect(aggregateAnalyticsRows({
      reports: [
        {
          id: "root-1",
          rootId: "root-1",
          retryOfReportId: null,
          createdAt: "2026-08-05T00:00:00.000Z",
          status: "submitted",
          discordReportId: "discord-1",
          flow: "message",
          category: "illegal_content",
          country: "DE",
          accountId: "account-1",
          submittedText: "submitted explanation"
        }
      ],
      events: [
        {
          reportId: "root-1",
          type: "report_submitted",
          occurredAt: "2026-08-05T00:02:00.000Z",
          discordStatus: null
        },
        {
          reportId: "root-1",
          type: "discord_status_updated",
          occurredAt: "2026-08-06T00:02:00.000Z",
          discordStatus: "closed_no_action"
        },
        {
          reportId: "root-1",
          type: "review_requested",
          occurredAt: "2026-08-06T01:02:00.000Z",
          discordStatus: null
        },
        {
          reportId: "root-1",
          type: "discord_status_updated",
          occurredAt: "2026-08-07T01:02:00.000Z",
          discordStatus: "actioned"
        }
      ]
    })).toMatchObject({
      volume: { newCases: 1, attempts: 1, retries: 0, sentAttempts: 1 },
      outcomes: { directActioned: 0, appealActioned: 1 }
    });
  });

  it("withholds community analytics until the publication cohort is large enough", () => {
    const result = aggregateAnalyticsRows({
      scope: "community",
      reports: Array.from({ length: 9 }, (_, index) => ({
        id: `root-${index}`,
        rootId: `root-${index}`,
        retryOfReportId: null,
        createdAt: "2026-08-05T00:00:00.000Z",
        status: "submitted",
        discordReportId: `discord-${index}`,
        flow: "message" as const,
        category: "illegal_content",
        country: "DE",
        accountId: `account-${index % 5}`,
        submittedText: "repeated threat"
      })),
      events: []
    });

    expect(result.availability).toBe("insufficient_community_data");
    expect(result.volume.newCases).toBe(0);
    expect(result.breakdowns.flows).toEqual([]);
  });

  it("does not let unowned reports satisfy recurring-pattern user privacy", () => {
    const reports = Array.from({ length: 10 }, (_, index) => ({
      id: `root-${index}`,
      rootId: `root-${index}`,
      retryOfReportId: null,
      createdAt: "2026-08-05T00:00:00.000Z",
      status: "submitted" as const,
      discordReportId: `discord-${index}`,
      flow: "message" as const,
      category: "illegal_content",
      country: "DE",
      accountId: index < 3 ? null : `account-${index - 3}`,
      submittedText: index < 5 ? "coordinated hateful threat" : `unrelated report ${index}`
    }));
    const result = aggregateAnalyticsRows({
      scope: "community",
      reports,
      events: reports.map((report) => ({
        reportId: report.id,
        type: "discord_status_updated",
        occurredAt: "2026-08-06T00:00:00.000Z",
        discordStatus: "actioned"
      }))
    });

    expect(result.availability).toBe("available");
    expect(result.patterns).not.toContainEqual({
      phrase: "coordinated hateful threat",
      reportCount: 5
    });
  });

  it("round-trips an opaque action-history cursor and rejects malformed cursors", () => {
    const cursor = {
      actionedAt: "2026-08-05T00:00:00.000Z",
      id: "report-1"
    };

    expect(decodeActionHistoryCursor(encodeActionHistoryCursor(cursor))).toEqual(cursor);
    expect(() => decodeActionHistoryCursor("not-a-cursor")).toThrow(/Invalid action history cursor/);
  });

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

  it("removes a bare domain query suffix before tokenization", () => {
    expect(sanitizePatternText("ordinary example.test?secret=token harmless")).toEqual([
      "ordinary",
      "harmless"
    ]);
  });

  it("removes a bare domain fragment suffix before tokenization", () => {
    expect(sanitizePatternText("ordinary example.test#secret-fragment harmless")).toEqual([
      "ordinary",
      "harmless"
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

  it("generates 24 hourly zero-filled series buckets for 24h period", () => {
    const interval = resolveAnalyticsInterval("24h", new Date("2026-08-11T12:00:00.000Z"));
    const result = aggregateAnalyticsRows({
      reports: [
        {
          id: "r1",
          rootId: "r1",
          retryOfReportId: null,
          createdAt: "2026-08-10T14:30:00.000Z",
          status: "submitted",
          discordReportId: "d1",
          flow: "message",
          category: "illegal_content",
          country: "DE",
          accountId: "account-1",
          submittedText: "threat"
        },
        {
          id: "r2",
          rootId: "r2",
          retryOfReportId: null,
          createdAt: "2026-08-10T14:45:00.000Z",
          status: "submitted",
          discordReportId: "d2",
          flow: "message",
          category: "illegal_content",
          country: "DE",
          accountId: "account-1",
          submittedText: "threat 2"
        }
      ],
      events: [],
      interval
    });

    expect(result.series.length).toBeGreaterThanOrEqual(24);
    const hour14 = result.series.find((point) => point.bucketStart.includes("2026-08-10T14:00:00"));
    expect(hour14?.reportCount).toBe(2);
    const hour15 = result.series.find((point) => point.bucketStart.includes("2026-08-10T15:00:00"));
    expect(hour15?.reportCount).toBe(0);
  });

  it("generates 7 daily buckets for 7d period", () => {
    const interval = resolveAnalyticsInterval("7d", new Date("2026-08-11T12:00:00.000Z"));
    const result = aggregateAnalyticsRows({
      reports: [],
      events: [],
      interval
    });

    expect(result.series.length).toBeGreaterThanOrEqual(7);
  });
});

