import type {
  AnalyticsBreakdownItem,
  AnalyticsInterval,
  AnalyticsPattern,
  AnalyticsPeriod,
  AnalyticsScope,
  DurationMetric,
  RateMetric,
  ReportAnalytics,
  ReportFlow
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

export interface AnalyticsSourceReport {
  id: string;
  rootId: string;
  retryOfReportId: string | null;
  createdAt: string;
  status: string;
  discordReportId: string | null;
  flow: ReportFlow;
  category: string;
  country: string;
  submitterDiscordUserId: string | null;
  submittedText: string;
  inCaseCohort?: boolean;
  inAttemptWindow?: boolean;
}

export interface AnalyticsSourceEvent extends AnalyticsEvent {
  reportId: string;
  occurredAt: string;
}

export interface AggregateAnalyticsInput {
  reports: readonly AnalyticsSourceReport[];
  events: readonly AnalyticsSourceEvent[];
  scope?: AnalyticsScope;
  interval?: AnalyticsInterval;
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

function labelForKey(value: string): string {
  return value.replaceAll("_", " ").replace(/\b\p{L}/gu, (letter) => letter.toLocaleUpperCase("en-US"));
}

function personalBreakdown(rows: readonly RawBreakdown[]): AnalyticsBreakdownItem[] {
  const denominator = rows.reduce((total, row) => total + row.reportCount, 0);
  return rows.map((row) => ({
    key: row.key,
    label: row.label,
    count: row.reportCount,
    percentage: denominator === 0 ? 0 : Math.round((row.reportCount / denominator) * 1000) / 10
  }));
}

function breakdownRows(
  reports: readonly AnalyticsSourceReport[],
  select: (report: AnalyticsSourceReport) => string
): RawBreakdown[] {
  const values = new Map<string, { reports: number; users: Set<string> }>();
  for (const report of reports) {
    const key = select(report);
    const value = values.get(key) ?? { reports: 0, users: new Set<string>() };
    value.reports += 1;
    if (report.submitterDiscordUserId !== null) value.users.add(report.submitterDiscordUserId);
    values.set(key, value);
  }
  return [...values.entries()]
    .map(([key, value]) => ({
      key,
      label: labelForKey(key),
      reportCount: value.reports,
      userCount: value.users.size
    }))
    .sort((left, right) => right.reportCount - left.reportCount || left.key.localeCompare(right.key));
}

function secondsBetween(start: AnalyticsSourceEvent | undefined, end: AnalyticsSourceEvent | undefined): number | null {
  if (start === undefined || end === undefined) return null;
  const seconds = (Date.parse(end.occurredAt) - Date.parse(start.occurredAt)) / 1_000;
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
}

function emptyAnalytics(scope: AnalyticsScope, interval: AnalyticsInterval): ReportAnalytics {
  const emptyDuration = durationMetric([]);
  return {
    availability: scope === "community" ? "insufficient_community_data" : "available",
    scope,
    interval,
    volume: {
      newCases: 0, attempts: 0, retries: 0, sentAttempts: 0, pendingAttempts: 0, failedAttempts: 0
    },
    outcomes: {
      awaitingResponse: 0, awaitingDecision: 0, directActioned: 0, closedNoAction: 0,
      appealsStarted: 0, appealActioned: 0, appealsDenied: 0
    },
    rates: {
      submission: rateMetric(0, 0), action: rateMetric(0, 0), appealAction: rateMetric(0, 0)
    },
    timing: { reply: emptyDuration, decision: emptyDuration, appealDecision: emptyDuration },
    breakdowns: { flows: [], categories: [], countries: [] },
    series: [],
    patterns: []
  };
}

export function aggregateAnalyticsRows(input: AggregateAnalyticsInput): ReportAnalytics {
  const scope = input.scope ?? "personal";
  const interval = input.interval ?? resolveAnalyticsInterval("all");
  const cohortReports = input.reports.filter((report) =>
    (report.inCaseCohort ?? report.retryOfReportId === null)
  );
  const attemptReports = input.reports.filter((report) => report.inAttemptWindow ?? true);
  const communityUsers = new Set(cohortReports.flatMap((report) =>
    report.submitterDiscordUserId === null ? [] : [report.submitterDiscordUserId]
  ));
  if (scope === "community" && (cohortReports.length < 10 || communityUsers.size < 5)) {
    return emptyAnalytics(scope, interval);
  }

  const reportsByRoot = new Map<string, AnalyticsSourceReport[]>();
  for (const report of input.reports) {
    const reports = reportsByRoot.get(report.rootId) ?? [];
    reports.push(report);
    reportsByRoot.set(report.rootId, reports);
  }
  const eventsByReport = new Map<string, AnalyticsSourceEvent[]>();
  for (const event of input.events) {
    const events = eventsByReport.get(event.reportId) ?? [];
    events.push(event);
    eventsByReport.set(event.reportId, events);
  }
  for (const events of eventsByReport.values()) {
    events.sort((left, right) => Date.parse(left.occurredAt) - Date.parse(right.occurredAt));
  }

  const outcomeCounts: Record<CaseOutcome, number> = {
    awaiting_response: 0, awaiting_decision: 0, direct_actioned: 0, closed_no_action: 0,
    appeal_pending: 0, appeal_actioned: 0, appeal_denied: 0
  };
  let appealsStarted = 0;
  const replySeconds: number[] = [];
  const decisionSeconds: number[] = [];
  const appealDecisionSeconds: number[] = [];
  const replySecondsByRoot = new Map<string, number[]>();

  for (const cohortReport of cohortReports) {
    const chain = reportsByRoot.get(cohortReport.rootId) ?? [cohortReport];
    const events = chain.flatMap((report) => eventsByReport.get(report.id) ?? [])
      .sort((left, right) => Date.parse(left.occurredAt) - Date.parse(right.occurredAt));
    const outcome = classifyCaseOutcome(events);
    outcomeCounts[outcome] += 1;
    if (events.some((event) => event.type === "review_requested")) appealsStarted += 1;

    const submitted = events.find((event) => event.type === "report_submitted");
    const reply = events.find((event) =>
      event.type === "discord_status_updated" && submitted !== undefined &&
      Date.parse(event.occurredAt) >= Date.parse(submitted.occurredAt)
    );
    const decision = events.find((event) =>
      event.type === "discord_status_updated" &&
      ["actioned", "closed_no_action", "review_not_approved"].includes(event.discordStatus ?? "") &&
      submitted !== undefined && Date.parse(event.occurredAt) >= Date.parse(submitted.occurredAt)
    );
    const reviewRequested = events.find((event) => event.type === "review_requested");
    const appealDecision = events.find((event) =>
      event.type === "discord_status_updated" &&
      ["actioned", "review_not_approved"].includes(event.discordStatus ?? "") &&
      reviewRequested !== undefined && Date.parse(event.occurredAt) >= Date.parse(reviewRequested.occurredAt)
    );
    const replyValue = secondsBetween(submitted, reply);
    const decisionValue = secondsBetween(submitted, decision);
    const appealDecisionValue = secondsBetween(reviewRequested, appealDecision);
    if (replyValue !== null) {
      replySeconds.push(replyValue);
      replySecondsByRoot.set(cohortReport.rootId, [replyValue]);
    }
    if (decisionValue !== null) decisionSeconds.push(decisionValue);
    if (appealDecisionValue !== null) appealDecisionSeconds.push(appealDecisionValue);
  }

  const sentAttempts = attemptReports.filter((report) =>
    report.discordReportId !== null || (eventsByReport.get(report.id) ?? []).some((event) => event.type === "report_submitted")
  ).length;
  const failedAttempts = attemptReports.filter((report) => report.status === "failed").length;
  const pendingAttempts = attemptReports.length - new Set(attemptReports.filter((report) =>
    report.status === "failed" || report.discordReportId !== null ||
    (eventsByReport.get(report.id) ?? []).some((event) => event.type === "report_submitted")
  ).map((report) => report.id)).size;
  const latestCaseReports = cohortReports.map((cohortReport) =>
    [...(reportsByRoot.get(cohortReport.rootId) ?? [cohortReport])]
      .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))[0] ?? cohortReport
  );
  const buildBreakdown = (select: (report: AnalyticsSourceReport) => string): AnalyticsBreakdownItem[] => {
    const rows = breakdownRows(latestCaseReports, select);
    return scope === "community" ? suppressCommunityBreakdown(rows) : personalBreakdown(rows);
  };
  const actioned = outcomeCounts.direct_actioned + outcomeCounts.appeal_actioned;
  const resolved = actioned + outcomeCounts.closed_no_action + outcomeCounts.appeal_denied;
  const decidedAppeals = outcomeCounts.appeal_actioned + outcomeCounts.appeal_denied;
  const seriesGroups = new Map<string, { reports: number; replies: number[] }>();
  for (const report of cohortReports) {
    const bucketStart = new Date(report.createdAt);
    bucketStart.setUTCHours(0, 0, 0, 0);
    const key = bucketStart.toISOString();
    const group = seriesGroups.get(key) ?? { reports: 0, replies: [] };
    group.reports += 1;
    group.replies.push(...(replySecondsByRoot.get(report.rootId) ?? []));
    seriesGroups.set(key, group);
  }

  return {
    availability: "available",
    scope,
    interval,
    volume: {
      newCases: cohortReports.length,
      attempts: attemptReports.length,
      retries: attemptReports.filter((report) => report.retryOfReportId !== null).length,
      sentAttempts,
      pendingAttempts,
      failedAttempts
    },
    outcomes: {
      awaitingResponse: outcomeCounts.awaiting_response,
      awaitingDecision: outcomeCounts.awaiting_decision,
      directActioned: outcomeCounts.direct_actioned,
      closedNoAction: outcomeCounts.closed_no_action + outcomeCounts.appeal_pending,
      appealsStarted,
      appealActioned: outcomeCounts.appeal_actioned,
      appealsDenied: outcomeCounts.appeal_denied
    },
    rates: {
      submission: rateMetric(sentAttempts, sentAttempts + attemptReports.filter((report) =>
        report.status === "failed" && report.discordReportId === null
      ).length),
      action: rateMetric(actioned, resolved),
      appealAction: rateMetric(outcomeCounts.appeal_actioned, decidedAppeals)
    },
    timing: {
      reply: durationMetric(replySeconds),
      decision: durationMetric(decisionSeconds),
      appealDecision: durationMetric(appealDecisionSeconds)
    },
    breakdowns: {
      flows: buildBreakdown((report) => report.flow),
      categories: buildBreakdown((report) => report.category),
      countries: buildBreakdown((report) => report.country)
    },
    series: [...seriesGroups.entries()].sort(([left], [right]) => left.localeCompare(right)).map(
      ([bucketStart, group]) => ({
        bucketStart,
        reportCount: group.reports,
        medianReplySeconds: durationMetric(group.replies).medianSeconds
      })
    ),
    patterns: recurringPatterns(latestCaseReports
      .filter((report) => {
        const chain = reportsByRoot.get(report.rootId) ?? [report];
        return ["direct_actioned", "appeal_actioned"].includes(classifyCaseOutcome(
          chain.flatMap((item) => eventsByReport.get(item.id) ?? [])
            .sort((left, right) => Date.parse(left.occurredAt) - Date.parse(right.occurredAt))
        ));
      })
      .map((report) => ({ userId: report.submitterDiscordUserId ?? "unknown", text: report.submittedText })), scope)
  };
}
