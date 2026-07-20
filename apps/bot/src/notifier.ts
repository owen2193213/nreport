import { setTimeout as delay } from "node:timers/promises";

import { DsaApiError, reportReasonLabel } from "@discord-dsa/contracts";
import type { CreateReportInput, DsaApi } from "@discord-dsa/contracts";
import { DiscordAPIError, type Client } from "discord.js";

import type { BotConfig } from "./config.js";
import { decryptJson } from "./crypto.js";
import type { BotDatabase } from "./database.js";
import type { NotificationPayload } from "./types.js";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown notification error";
}

function definiteCreateFailure(error: unknown): boolean {
  return error instanceof DsaApiError && error.status < 500 && error.status !== 409;
}

function terminalStatus(payload: NotificationPayload): string {
  if (payload.discordStatus !== null) return payload.discordStatus;
  return payload.status;
}

export function renderNotification(payload: NotificationPayload): string {
  return [
    "**Discord DSA report update**",
    `Report: ${payload.internalReportId}`,
    `Type: ${payload.flow.replace("_urf", "")} — ${reportReasonLabel(payload.flow, payload.reportType)}`,
    `Country: ${payload.country}`,
    `Status: ${terminalStatus(payload)}`,
    `Discord report ID: ${payload.discordReportId ?? "not assigned"}`,
    `Lifecycle attempt: ${payload.lifecycleAttempt}/3`,
    ...(payload.status === "failed" ? [`Retryable: ${payload.retryable ? "yes" : "no"}`] : []),
    `Updated: ${payload.timestamp}`,
    "",
    "Use `/reports status` for the current report details."
  ].join("\n");
}

export class NotificationWorker {
  private stopped = true;
  private ticking = false;

  public constructor(
    private readonly database: BotDatabase,
    private readonly api: DsaApi,
    private readonly client: Client,
    private readonly config: BotConfig
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
      await this.deliverNotifications();
    } catch (error) {
      process.stderr.write(`Notification worker tick failed: ${errorMessage(error)}\n`);
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
        } else {
          const report = await this.api.report(tracking.internal_report_id);
          await this.database.observeReport(tracking.id, report);
        }
      } catch (error) {
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

  private async deliverNotifications(): Promise<void> {
    const jobs = await this.database.claimNotifications();
    for (const job of jobs) {
      try {
        const user = await this.client.users.fetch(job.discord_user_id);
        await user.send({
          content: renderNotification(job.payload),
          allowedMentions: { parse: [] }
        });
        await this.database.completeNotification(job.id);
      } catch (error) {
        const permanentlyBlocked = error instanceof DiscordAPIError && error.code === 50_007;
        await this.database.failNotification(job, errorMessage(error), permanentlyBlocked);
      }
    }
  }
}
