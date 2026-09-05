import type {
  ActionHistoryPage,
  AnalyticsInterval,
  DigestActivity,
  ReportAnalytics
} from "@discord-dsa/contracts";
import type { Pool, QueryResultRow } from "pg";

import {
  aggregateAnalyticsRows,
  digestEligible,
  type AnalyticsSourceEvent,
  type AnalyticsSourceReport
} from "./analytics.js";

interface AnalyticsReportRow extends QueryResultRow {
  id: string;
  root_id: string;
  predecessor_report_id: string | null;
  account_id: string;
  created_at: Date;
  status: string;
  discord_report_id: string | null;
  flow: "message" | "profile" | "server";
  prepared_input: { country?: string; category?: string; finalText?: string } | null;
  request_input: { target?: { messageUrl?: string } };
}

export class AnalyticsRepository {
  public constructor(private readonly pool: Pick<Pool, "query">) {}

  public async analytics(
    accountId: string | null,
    interval: AnalyticsInterval,
    scope: "personal" | "community"
  ): Promise<ReportAnalytics> {
    const reportsResult = await this.pool.query<AnalyticsReportRow>(
      `SELECT report.*, chain.original_report_id AS root_id
       FROM account_reports AS report
       JOIN report_credit_chains AS chain ON chain.id = report.credit_chain_id
       WHERE ($1::uuid IS NULL OR report.account_id = $1)
         AND report.created_at <= $2
       ORDER BY report.created_at, report.id`,
      [accountId, interval.endAt]
    );
    const ids = reportsResult.rows.map((row) => row.id);
    const eventsResult = ids.length === 0
      ? { rows: [] as Array<{ report_id: string; event_type: string; created_at: Date }> }
      : await this.pool.query<{ report_id: string; event_type: string; created_at: Date }>(
          `SELECT report_id, event_type, created_at FROM account_report_events
           WHERE report_id = ANY($1::uuid[]) AND created_at <= $2 ORDER BY id`,
          [ids, interval.endAt]
        );
    const start = interval.startAt === null ? null : Date.parse(interval.startAt);
    const reports: AnalyticsSourceReport[] = reportsResult.rows.map((row) => ({
      id: row.id,
      rootId: row.root_id,
      retryOfReportId: row.predecessor_report_id,
      createdAt: row.created_at.toISOString(),
      status: row.status,
      discordReportId: row.discord_report_id,
      flow: row.flow,
      category: row.prepared_input?.category ?? "unresolved",
      country: row.prepared_input?.country ?? "unresolved",
      accountId: row.account_id,
      submittedText: row.prepared_input?.finalText ?? "",
      inCaseCohort: row.id === row.root_id && (start === null || row.created_at.getTime() >= start),
      inAttemptWindow: start === null || row.created_at.getTime() >= start
    }));
    const events: AnalyticsSourceEvent[] = eventsResult.rows.map((row) => ({
      reportId: row.report_id,
      type: row.event_type.startsWith("discord:") ? "discord_status_updated" : row.event_type,
      discordStatus: row.event_type.startsWith("discord:") ? row.event_type.slice("discord:".length) : null,
      occurredAt: row.created_at.toISOString()
    }));
    return aggregateAnalyticsRows({ reports, events, scope, interval });
  }

  public async actionHistory(
    accountId: string,
    interval: AnalyticsInterval,
    after: string | null,
    limit: number
  ): Promise<ActionHistoryPage> {
    const pageSize = Math.max(1, Math.min(100, limit));
    const result = await this.pool.query<{
      event_id: string; report_id: string; discord_report_id: string | null;
      flow: "message" | "profile" | "server"; prepared_input: { country?: string; category?: string; finalText?: string } | null;
      request_input: { target?: { messageUrl?: string } }; submitted_at: Date; actioned_at: Date; appealed: boolean;
    }>(
      `SELECT event.id AS event_id, report.id AS report_id, report.discord_report_id,
              report.flow, report.prepared_input, report.request_input,
              report.submission_started_at AS submitted_at, event.created_at AS actioned_at,
              EXISTS (SELECT 1 FROM account_report_events AS appeal
                      WHERE appeal.report_id = report.id AND appeal.event_type = 'review_requested'
                        AND appeal.id < event.id) AS appealed
       FROM account_report_events AS event
       JOIN account_reports AS report ON report.id = event.report_id
       WHERE report.account_id = $1 AND event.event_type = 'discord:actioned'
         AND event.id > $2 AND event.created_at >= COALESCE($3::timestamptz, '-infinity')
         AND event.created_at <= $4
       ORDER BY event.id LIMIT $5`,
      [accountId, after ?? "0", interval.startAt, interval.endAt, pageSize + 1]
    );
    const rows = result.rows.slice(0, pageSize);
    return {
      interval,
      items: rows.map((row) => ({
        internalReportId: row.report_id,
        discordReportId: row.discord_report_id,
        flow: row.flow,
        category: row.prepared_input?.category ?? "unresolved",
        country: row.prepared_input?.country ?? "unresolved",
        submittedText: row.prepared_input?.finalText ?? "",
        messageUrl: row.request_input.target?.messageUrl ?? null,
        submittedAt: row.submitted_at.toISOString(),
        actionedAt: row.actioned_at.toISOString(),
        actionSource: row.appealed ? "appeal" : "direct"
      })),
      nextCursor: result.rows.length > pageSize ? String(rows.at(-1)?.event_id) : null
    };
  }

  public async digest(accountId: string, interval: AnalyticsInterval): Promise<DigestActivity> {
    const result = await this.pool.query<{
      new_reports: string; outcome_changes: string; actioned: string;
      closed_no_action: string; appeal_actioned: string; appeal_denied: string;
    }>(
      `SELECT
         count(DISTINCT report.id) FILTER (
           WHERE report.predecessor_report_id IS NULL AND report.created_at >= $2 AND report.created_at <= $3
         )::text AS new_reports,
         count(event.id) FILTER (WHERE event.event_type IN ('discord:actioned', 'discord:closed_no_action', 'discord:review_not_approved'))::text AS outcome_changes,
         count(event.id) FILTER (WHERE event.event_type = 'discord:actioned')::text AS actioned,
         count(event.id) FILTER (WHERE event.event_type = 'discord:closed_no_action')::text AS closed_no_action,
         count(event.id) FILTER (WHERE event.event_type = 'discord:actioned' AND EXISTS (
           SELECT 1 FROM account_report_events appeal WHERE appeal.report_id = report.id AND appeal.event_type = 'review_requested' AND appeal.id < event.id
         ))::text AS appeal_actioned,
         count(event.id) FILTER (WHERE event.event_type = 'discord:review_not_approved')::text AS appeal_denied
       FROM account_reports AS report
       LEFT JOIN account_report_events AS event ON event.report_id = report.id AND event.created_at >= $2 AND event.created_at <= $3
       WHERE report.account_id = $1`,
      [accountId, interval.startAt, interval.endAt]
    );
    const row = result.rows[0] ?? { new_reports: "0", outcome_changes: "0", actioned: "0", closed_no_action: "0", appeal_actioned: "0", appeal_denied: "0" };
    const newReports = Number(row.new_reports);
    const outcomeChanges = Number(row.outcome_changes);
    return {
      interval,
      newReports,
      outcomeChanges: {
        total: outcomeChanges,
        actioned: Number(row.actioned),
        closedNoAction: Number(row.closed_no_action),
        appealActioned: Number(row.appeal_actioned),
        appealDenied: Number(row.appeal_denied)
      },
      eligible: digestEligible(newReports, outcomeChanges)
    };
  }
}
