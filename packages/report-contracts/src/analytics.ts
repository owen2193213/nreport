import type { ReportFlow } from "./types.js";

export const ANALYTICS_PERIODS = ["24h", "7d", "30d", "ytd", "365d", "all"] as const;
export type AnalyticsPeriod = (typeof ANALYTICS_PERIODS)[number];
export type AnalyticsScope = "personal" | "community";

export interface AnalyticsInterval {
  period: AnalyticsPeriod | "custom";
  startAt: string | null;
  endAt: string;
  asOf: string;
  timezone: "UTC";
}

export interface RateMetric {
  numerator: number;
  denominator: number;
  percentage: number | null;
}

export interface DurationMetric {
  sampleSize: number;
  medianSeconds: number | null;
  p90Seconds: number | null;
}

export interface AnalyticsBreakdownItem {
  key: string;
  label: string;
  count: number;
  percentage: number;
}

export interface AnalyticsSeriesPoint {
  bucketStart: string;
  reportCount: number;
  medianReplySeconds: number | null;
}

export interface AnalyticsPattern {
  phrase: string;
  reportCount: number;
}

export interface ReportAnalytics {
  availability: "available" | "insufficient_community_data";
  scope: AnalyticsScope;
  interval: AnalyticsInterval;
  volume: {
    newCases: number;
    attempts: number;
    retries: number;
    sentAttempts: number;
    pendingAttempts: number;
    failedAttempts: number;
  };
  outcomes: {
    awaitingResponse: number;
    awaitingDecision: number;
    directActioned: number;
    closedNoAction: number;
    appealsStarted: number;
    appealActioned: number;
    appealsDenied: number;
  };
  rates: {
    submission: RateMetric;
    action: RateMetric;
    appealAction: RateMetric;
  };
  timing: {
    reply: DurationMetric;
    decision: DurationMetric;
    appealDecision: DurationMetric;
  };
  breakdowns: {
    flows: AnalyticsBreakdownItem[];
    categories: AnalyticsBreakdownItem[];
    countries: AnalyticsBreakdownItem[];
  };
  series: AnalyticsSeriesPoint[];
  patterns: AnalyticsPattern[];
}

export interface ActionHistoryItem {
  internalReportId: string;
  discordReportId: string | null;
  flow: ReportFlow;
  category: string;
  country: string;
  submittedText: string;
  messageUrl: string | null;
  submittedAt: string;
  actionedAt: string;
  actionSource: "direct" | "appeal";
}

export interface ActionHistoryPage {
  interval: AnalyticsInterval;
  items: ActionHistoryItem[];
  nextCursor: string | null;
}

export interface DigestActivity {
  interval: AnalyticsInterval;
  newReports: number;
  outcomeChanges: {
    total: number;
    actioned: number;
    closedNoAction: number;
    appealActioned: number;
    appealDenied: number;
  };
  eligible: boolean;
}
