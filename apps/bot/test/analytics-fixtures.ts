import type { ReportAnalytics } from "@discord-dsa/contracts";

export function analyticsFixture(overrides: Partial<ReportAnalytics> = {}): ReportAnalytics {
  const base: ReportAnalytics = {
    availability: "available",
    scope: "personal",
    interval: {
      period: "7d", startAt: "2026-08-04T12:00:00.000Z", endAt: "2026-08-11T12:00:00.000Z",
      asOf: "2026-08-11T12:00:00.000Z", timezone: "UTC"
    },
    volume: { newCases: 3, attempts: 3, retries: 0, sentAttempts: 3, pendingAttempts: 0, failedAttempts: 0 },
    outcomes: {
      awaitingResponse: 0, awaitingDecision: 1, directActioned: 1, closedNoAction: 1,
      appealsStarted: 1, appealActioned: 0, appealsDenied: 0
    },
    rates: {
      submission: { numerator: 3, denominator: 3, percentage: 100 },
      action: { numerator: 1, denominator: 2, percentage: 50 },
      appealAction: { numerator: 0, denominator: 0, percentage: null }
    },
    timing: {
      reply: { sampleSize: 2, medianSeconds: 3_600, p90Seconds: 7_200 },
      decision: { sampleSize: 2, medianSeconds: 86_400, p90Seconds: 172_800 },
      appealDecision: { sampleSize: 0, medianSeconds: null, p90Seconds: null }
    },
    breakdowns: {
      flows: [{ key: "message_urf", label: "Message", count: 3, percentage: 100 }],
      categories: [{ key: "illegal_content", label: "Illegal content", count: 3, percentage: 100 }],
      countries: [{ key: "DE", label: "Germany", count: 3, percentage: 100 }]
    },
    series: [{ bucketStart: "2026-08-04T12:00:00.000Z", reportCount: 3, medianReplySeconds: 3_600 }],
    patterns: []
  };
  return { ...base, ...overrides };
}

export function communityFixture(overrides: Partial<ReportAnalytics> = {}): ReportAnalytics {
  return analyticsFixture({ scope: "community", ...overrides });
}
