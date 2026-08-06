import { setTimeout as delay } from "node:timers/promises";

import { DsaApiError } from "@discord-dsa/contracts";
import type { CreateReportInput, DsaApi, ReportDetail } from "@discord-dsa/contracts";
import { DiscordAPIError, type Client, type Message, type User } from "discord.js";

import type { BotConfig } from "./config.js";
import { decryptJson } from "./crypto.js";
import { shouldNotifyLifecycleType, type BotDatabase } from "./database.js";
import { botLog, errorFields } from "./observability.js";
import type { ServerResolver } from "./server-resolver.js";
import type { AiDecisionSummary, ServerSnapshot } from "./types.js";
import { reportEmbed, reportRetryComponents } from "./ui.js";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown notification error";
}

function definiteCreateFailure(error: unknown): boolean {
  return error instanceof DsaApiError && error.status < 500 && error.status !== 409;
}

export function renderNotification(
  report: ReportDetail,
  snapshot?: ServerSnapshot | null,
  eventType?: string,
  aiDecisions?: readonly AiDecisionSummary[]
) {
  void eventType;
  return reportEmbed(report, snapshot, {
    history: "full",
    ...(aiDecisions === undefined ? {} : { aiDecisions })
  }).setTimestamp(
    new Date(report.discordStatusUpdatedAt ?? report.updatedAt)
  );
}

function shouldIncludeRetryComponents(eventType: string): boolean {
  return (
    eventType === "report_failed" ||
    eventType === "review_request_failed" ||
    eventType === "review_confirmation_timeout"
  );
}

export function lifecycleReplyText(eventType: string, report: ReportDetail): string | null {
  switch (eventType) {
    case "discord:actioned":
      return "Report accepted.";
    case "discord:closed_no_action":
      return report.reviewStatus === null
        ? "Report denied. No appeal link was available. Please contact me."
        : "Report denied & appeal sent.";
    case "discord:review_not_approved":
      return "Appeal denied. You can resubmit as-is or rewrite it.";
    case "review_confirmation_timeout":
      return "Appeal email timed out. Not submitted. Please contact me with details.";
    case "review_request_failed":
      return "Automatic appeal failed. Check report status before retrying. Please contact me with details.";
    case "review_ineligible":
      return "Report ineligible for review. No appeal sent.";
    case "review_request_ambiguous":
      return "Appeal status uncertain. Not retried to avoid duplicates. Please contact me with details.";
    case "report_failed":
      return report.error?.code === "discord_receipt_timeout"
        ? "Discord didn't confirm receipt within 2 min. Retry below or contact me."
        : null;
    default:
      return null;
  }
}

function isUnknownMessage(error: unknown): boolean {
  return error instanceof DiscordAPIError && error.code === 10_008;
}

export class NotificationWorker {
  private stopped = true;
  private ticking = false;
  private nextReconciliationAt = 0;

  public constructor(
    private readonly database: BotDatabase,
    private readonly api: DsaApi,
    private readonly client: Client,
    private readonly config: BotConfig,
    private readonly serverResolver: ServerResolver
  ) {}

  public start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    void this.loop();
  }

  public stop(): void {
    this.stopped = true;
  }

  private async loop(): Promise<void> {
    while (!this.stopped) {
      await this.tick();
      if (!this.stopped) await delay(10_000);
    }
  }

  public async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      await this.pollReports();
      if (Date.now() >= this.nextReconciliationAt) {
        await this.reconcileEvents();
        this.nextReconciliationAt = Date.now() + 15 * 60_000;
      }
      await this.deliverNotifications();
    } catch (error) {
      botLog("notification_worker_tick_failed", errorFields(error), "error");
    } finally {
      this.ticking = false;
    }
  }

  private async pollReports(): Promise<void> {
    const trackings = await this.database.claimDueTrackings();
    for (const tracking of trackings) {
      try {
        if (tracking.internal_report_id === null) {
          const request = decryptJson<CreateReportInput>(
            tracking.encrypted_request,
            this.config.dataEncryptionKey
          );
          const report = await this.api.createReport(tracking.interaction_id, request);
          await this.database.markSubmissionCreated(tracking.id, report);
          await this.database.observeReport(tracking.id, report);
          botLog("report_poll_observed", {
            trackingId: tracking.id,
            reportId: report.internalReportId,
            status: report.status,
            discordStatus: report.discordStatus,
            lifecycleAttempt: report.lifecycleAttempt,
            recoveredCreation: true
          });
        } else {
          const report = await this.api.report(tracking.internal_report_id);
          await this.database.observeReport(tracking.id, report);
          botLog("report_poll_observed", {
            trackingId: tracking.id,
            reportId: report.internalReportId,
            status: report.status,
            discordStatus: report.discordStatus,
            lifecycleAttempt: report.lifecycleAttempt,
            recoveredCreation: false
          });
        }
      } catch (error) {
        botLog(
          "report_poll_failed",
          {
            trackingId: tracking.id,
            hasReportId: tracking.internal_report_id !== null,
            ...errorFields(error)
          },
          "warn"
        );
        if (tracking.internal_report_id === null && definiteCreateFailure(error)) {
          await this.database.releaseReservation(tracking.id, "reconciliation_rejected");
        } else {
          await this.database.rescheduleTracking(
            tracking.id,
            error instanceof DsaApiError && error.status === 429 ? 120 : 60
          );
        }
      }
    }
  }

  private async reconcileEvents(): Promise<void> {
    let cursor = await this.database.reconciliationCursor();
    if (cursor === null) {
      cursor = "0";
      await this.database.setReconciliationCursor(cursor);
    }
    botLog("lifecycle_reconciliation_started", { cursor });
    let eventCount = 0;
    while (true) {
      const { events } = await this.api.lifecycleEvents(cursor, 100);
      if (events.length === 0) {
        botLog("lifecycle_reconciliation_completed", { cursor, eventCount });
        return;
      }
      for (const event of events) {
        const ingestionResult = await this.database.ingestLifecycleEvent(event);
        botLog("lifecycle_event_reconciled", {
          eventId: event.eventId,
          reportId: event.internalReportId,
          eventType: event.type,
          lifecycleAttempt: event.lifecycleAttempt,
          ingestionResult
        });
        eventCount += 1;
        cursor = event.eventId;
        await this.database.setReconciliationCursor(cursor);
      }
      if (events.length < 100) {
        botLog("lifecycle_reconciliation_completed", { cursor, eventCount });
        return;
      }
    }
  }

  private async snapshotFor(report: ReportDetail, userId: string): Promise<ServerSnapshot | null> {
    if (report.reportedDetails.kind !== "server") return null;
    const stored = await this.database.serverSnapshot(report.internalReportId, userId);
    if (stored) return stored;
    const snapshot = await this.serverResolver.resolve(report.reportedDetails.guildIdOrInviteCode);
    if (snapshot) await this.database.saveServerSnapshot(report.internalReportId, userId, snapshot);
    return snapshot;
  }

  private async storedStatusMessage(user: User, trackingId: string): Promise<Message | null> {
    const messageId = await this.database.statusDmMessageId(trackingId);
    if (messageId === null) return null;
    const channel = await user.createDM();
    try {
      return await channel.messages.fetch(messageId);
    } catch (error) {
      if (isUnknownMessage(error)) return null;
      throw error;
    }
  }

  private async deliverNotifications(): Promise<void> {
    const jobs = await this.database.claimNotifications();
    for (const job of jobs) {
      try {
        if (!shouldNotifyLifecycleType(job.payload.eventType)) {
          await this.database.completeNotification(job.id);
          botLog("notification_send_suppressed", {
            notificationId: job.id,
            trackingId: job.tracking_id,
            reportId: job.payload.internalReportId,
            eventType: job.payload.eventType,
            reason: "non_status_lifecycle_event"
          });
          continue;
        }
        botLog("notification_send_started", {
          notificationId: job.id,
          trackingId: job.tracking_id,
          reportId: job.payload.internalReportId,
          eventType: job.payload.eventType,
          deliveryAttempt: job.attempts
        });
        const report = await this.api.report(job.payload.internalReportId);
        const user = await this.client.users.fetch(job.discord_user_id);
        const components = reportRetryComponents(report);
        const aiDecisions = await this.database.aiDecisions(job.tracking_id);
        const embed = renderNotification(
          report,
          await this.snapshotFor(report, job.discord_user_id),
          job.payload.eventType,
          aiDecisions
        );
        let statusMessage = await this.storedStatusMessage(user, job.tracking_id);
        if (statusMessage === null) {
          statusMessage = await user.send({
            embeds: [embed],
            components,
            allowedMentions: { parse: [] }
          });
          await this.database.saveStatusDmMessageId(job.tracking_id, statusMessage.id);
        } else {
          await statusMessage.edit({
            embeds: [embed],
            components,
            allowedMentions: { parse: [] }
          });
        }
        const replyText = lifecycleReplyText(job.payload.eventType, report);
        if (replyText !== null) {
          await statusMessage.reply({
            content: replyText,
            components: shouldIncludeRetryComponents(job.payload.eventType) ? components : [],
            allowedMentions: { parse: [] }
          });
        }
        await this.database.completeNotification(job.id);
        botLog("notification_send_completed", {
          notificationId: job.id,
          trackingId: job.tracking_id,
          reportId: job.payload.internalReportId,
          eventType: job.payload.eventType,
          deliveryAttempt: job.attempts
        });
      } catch (error) {
        const permanentlyBlocked = error instanceof DiscordAPIError && error.code === 50_007;
        botLog(
          "notification_send_failed",
          {
            notificationId: job.id,
            trackingId: job.tracking_id,
            reportId: job.payload.internalReportId,
            eventType: job.payload.eventType,
            deliveryAttempt: job.attempts,
            permanentlyBlocked,
            ...errorFields(error)
          },
          permanentlyBlocked ? "warn" : "error"
        );
        await this.database.failNotification(job, errorMessage(error), permanentlyBlocked);
      }
    }
  }
}
