import { setTimeout as delay } from "node:timers/promises";

import type { ReportLifecycleEvent } from "@discord-dsa/contracts";

import type { AppConfig } from "./config.js";
import type { Database, DeliveryEventRow } from "./database.js";
import { signReportEvent } from "./security.js";

interface DeliveryLogger {
  error(data: Record<string, unknown>, message: string): void;
}

function publicEvent(event: DeliveryEventRow): ReportLifecycleEvent {
  const discordStatus = event.metadata.discordStatus;
  return {
    eventId: event.id,
    internalReportId: event.report_id,
    submitterDiscordUserId: event.submitter_discord_user_id,
    type:
      event.event_type === "discord_status_updated" && typeof discordStatus === "string"
        ? `discord:${discordStatus}`
        : event.event_type,
    occurredAt: event.created_at.toISOString()
  };
}

export class EventDeliveryWorker {
  private stopped = false;
  private runningPromise: Promise<void> | undefined;

  public constructor(
    private readonly database: Database,
    private readonly config: AppConfig,
    private readonly logger: DeliveryLogger
  ) {}

  public start(): void {
    if (this.runningPromise !== undefined || !this.config.botEventWebhookUrl) return;
    this.runningPromise = this.run();
  }

  public async stop(): Promise<void> {
    this.stopped = true;
    await this.runningPromise;
  }

  private async run(): Promise<void> {
    while (!this.stopped) {
      try {
        const events = await this.database.claimDeliveryEvents();
        if (events.length === 0) {
          await delay(2_000);
          continue;
        }
        for (const event of events) await this.deliver(event);
      } catch (error) {
        this.logger.error(
          { error: error instanceof Error ? error.message : "Unknown delivery loop error" },
          "Report event delivery loop failed"
        );
        await delay(2_000);
      }
    }
  }

  private async deliver(event: DeliveryEventRow): Promise<void> {
    try {
      const payload = JSON.stringify(publicEvent(event));
      const timestamp = Math.floor(Date.now() / 1_000).toString();
      const response = await fetch(this.config.botEventWebhookUrl!, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-report-event-id": event.id,
          "x-report-event-timestamp": timestamp,
          "x-report-event-signature": signReportEvent(
            this.config.botEventWebhookSecret!,
            timestamp,
            event.id,
            payload
          )
        },
        body: payload,
        signal: AbortSignal.timeout(10_000)
      });
      if (!response.ok) throw new Error(`Bot event endpoint returned HTTP ${response.status}.`);
      await this.database.completeDeliveryEvent(event.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown event delivery error";
      await this.database.retryDeliveryEvent(event.id, event.delivery_attempts, message);
      this.logger.error({ eventId: event.id, error: message }, "Report event delivery failed");
    }
  }
}
