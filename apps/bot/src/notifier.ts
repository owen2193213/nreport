import { setTimeout as delay } from "node:timers/promises";

import { DsaApiError } from "@discord-dsa/contracts";
import type { CreateReportInput, DsaApi, ReportDetail } from "@discord-dsa/contracts";
import { DiscordAPIError, type Client } from "discord.js";

import type { BotConfig } from "./config.js";
import { decryptJson } from "./crypto.js";
import { shouldNotifyLifecycleType, type BotDatabase } from "./database.js";
import { botLog, errorFields } from "./observability.js";
import type { ServerResolver } from "./server-resolver.js";
import type { ServerSnapshot } from "./types.js";
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
  eventType?: string
) {
  const titles: Record<string, string> = {
    report_submitted: "Report submitted to Discord",
    report_failed: "Report processing failed",
    "discord:received": "Report received by Discord",
    "discord:actioned": "Discord took action",
    "discord:closed_no_action": "Discord closed the report without action",
    "discord:review_not_approved": "Discord did not approve the report"
  };
  return reportEmbed(report, snapshot, {
    title: (eventType && titles[eventType]) ?? "Discord DSA report update",
    hideStatusDescription: true
  })
    .setTimestamp(new Date(report.discordStatusUpdatedAt ?? report.updatedAt));
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
        const tracked = await this.database.ingestLifecycleEvent(event);
        botLog("lifecycle_event_reconciled", {
          eventId: event.eventId,
          reportId: event.internalReportId,
          eventType: event.type,
          lifecycleAttempt: event.lifecycleAttempt,
          tracked
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
            reason: "submission_acknowledgement_already_sent"
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
        await user.send({
          embeds: [
            renderNotification(
              report,
              await this.snapshotFor(report, job.discord_user_id),
              job.payload.eventType
            )
          ],
          components: reportRetryComponents(report),
          allowedMentions: { parse: [] }
        });
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
