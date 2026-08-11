import type {
  AnalyticsBreakdownItem,
  AnalyticsInterval,
  AnalyticsPattern,
  AnalyticsPeriod,
  AnalyticsScope,
  DurationMetric,
  RateMetric
} from "@discord-dsa/contracts";

export interface AnalyticsEvent {
  type: string;
  discordStatus: string | null;
}

export type CaseOutcome =
  | "awaiting_response"
  | "awaiting_decision"
  | "direct_actioned"
  | "closed_no_action"
  | "appeal_pending"
  | "appeal_actioned"
  | "appeal_denied";

export interface PatternSource {
  userId: string;
  text: string;
}

export interface RawBreakdown {
  key: string;
  label: string;
  reportCount: number;
  userCount: number;
}

const PERIOD_MILLISECONDS: Partial<Record<AnalyticsPeriod, number>> = {
  "24h": 24 * 60 * 60 * 1_000,
  "7d": 7 * 24 * 60 * 60 * 1_000,
  "30d": 30 * 24 * 60 * 60 * 1_000,
  "365d": 365 * 24 * 60 * 60 * 1_000
};

const STOP_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "but", "by", "for", "from", "in", "is",
  "it", "of", "on", "or", "that", "the", "this", "to", "was", "were", "with", "you", "your"
]);

export function resolveAnalyticsInterval(period: AnalyticsPeriod, now = new Date()): AnalyticsInterval {
  const endAt = now.toISOString();
  let startAt: string | null = null;

  if (period === "ytd") {
    startAt = new Date(Date.UTC(now.getUTCFullYear(), 0, 1)).toISOString();
  } else {
    const milliseconds = PERIOD_MILLISECONDS[period];
    if (milliseconds !== undefined) startAt = new Date(now.getTime() - milliseconds).toISOString();
  }

  return { period, startAt, endAt, asOf: endAt, timezone: "UTC" };
}

export function classifyCaseOutcome(events: readonly AnalyticsEvent[]): CaseOutcome {
  const statuses = events
    .filter((event) => event.type === "discord_status_updated")
    .map((event) => event.discordStatus);
  const finalStatus = statuses.at(-1);
  let closedBeforeReview = false;
  let reviewAfterClosure = false;
  let appealActioned = false;

  for (const event of events) {
    if (event.type === "discord_status_updated" && event.discordStatus === "closed_no_action") {
      closedBeforeReview = true;
    } else if (event.type === "review_requested" && closedBeforeReview) {
      reviewAfterClosure = true;
    } else if (
      event.type === "discord_status_updated" &&
      event.discordStatus === "actioned" &&
      reviewAfterClosure
    ) {
      appealActioned = true;
    }
  }

  if (finalStatus === "review_not_approved") return "appeal_denied";
  if (appealActioned) return "appeal_actioned";
  if (finalStatus === "actioned") return "direct_actioned";
  if (reviewAfterClosure) return "appeal_pending";
  if (finalStatus === "closed_no_action") return "closed_no_action";
  return finalStatus === "received" ? "awaiting_decision" : "awaiting_response";
}

export function rateMetric(numerator: number, denominator: number): RateMetric {
  return {
    numerator,
    denominator,
    percentage: denominator === 0 ? null : Math.round((numerator / denominator) * 1000) / 10
  };
}

export function durationMetric(seconds: readonly number[]): DurationMetric {
  if (seconds.length === 0) return { sampleSize: 0, medianSeconds: null, p90Seconds: null };
  const sorted = [...seconds].sort((left, right) => left - right);
  const lowerMedianIndex = Math.floor((sorted.length - 1) / 2);
  const upperMedianIndex = Math.ceil((sorted.length - 1) / 2);
  const p90Index = Math.ceil(sorted.length * 0.9) - 1;

  return {
    sampleSize: sorted.length,
    medianSeconds: ((sorted[lowerMedianIndex] ?? 0) + (sorted[upperMedianIndex] ?? 0)) / 2,
    p90Seconds: sorted[p90Index] ?? null
  };
}

export function sanitizePatternText(value: string): string[] {
  const withoutSensitiveValues = value
    .replace(/\b(?:[a-z][a-z0-9+.-]*:\/\/|www\.)\S+/giu, " ")
    .replace(/\b[\w.+-]+@[\w.-]+\.[a-z]{2,}\b/giu, " ")
    .replace(/\b(?:[a-z0-9-]+\.)+[a-z]{2,63}(?:[/?#]\S*)?/giu, " ")
    .replace(/<@!?\d+>|<@&\d+>|<#\d+>/gu, " ")
    .replace(/\b\d{15,22}\b/gu, " ")
    .replace(/\b\d+\b/gu, " ");

  return withoutSensitiveValues
    .toLocaleLowerCase("en-US")
    .split(/[^\p{L}]+/u)
    .filter((token) => token.length > 0 && !STOP_WORDS.has(token));
}

export function recurringPatterns(
  rows: readonly PatternSource[],
  scope: AnalyticsScope
): AnalyticsPattern[] {
  const candidates = new Map<string, { reportCount: number; userIds: Set<string> }>();

  for (const row of rows) {
    const tokens = sanitizePatternText(row.text);
    const phrasesForReport = new Set<string>();
    for (let start = 0; start < tokens.length; start += 1) {
      for (let length = 1; length <= 3 && start + length <= tokens.length; length += 1) {
        phrasesForReport.add(tokens.slice(start, start + length).join(" "));
      }
    }
    for (const phrase of phrasesForReport) {
      const candidate = candidates.get(phrase) ?? { reportCount: 0, userIds: new Set<string>() };
      candidate.reportCount += 1;
      candidate.userIds.add(row.userId);
      candidates.set(phrase, candidate);
    }
  }

  const minimumReports = scope === "community" ? 5 : 2;
  const eligible = [...candidates.entries()].filter(([, candidate]) =>
    candidate.reportCount >= minimumReports &&
    (scope === "personal" || candidate.userIds.size >= 3)
  );
  const maximal = eligible.filter(([phrase, candidate]) => !eligible.some(([otherPhrase, other]) =>
    otherPhrase !== phrase && other.reportCount === candidate.reportCount &&
    other.userIds.size === candidate.userIds.size && otherPhrase.includes(phrase) &&
    otherPhrase.split(" ").length > phrase.split(" ").length
  ));

  return maximal
    .map(([phrase, candidate]) => ({ phrase, reportCount: candidate.reportCount }))
    .sort((left, right) => right.reportCount - left.reportCount || left.phrase.localeCompare(right.phrase))
    .slice(0, 10);
}

export function suppressCommunityBreakdown(rows: readonly RawBreakdown[]): AnalyticsBreakdownItem[] {
  const visible = rows.filter((row) => row.reportCount >= 3 && row.userCount >= 3);
  const denominator = visible.reduce((total, row) => total + row.reportCount, 0);

  return visible.map((row) => ({
    key: row.key,
    label: row.label,
    count: row.reportCount,
    percentage: denominator === 0 ? 0 : Math.round((row.reportCount / denominator) * 1000) / 10
  }));
}
