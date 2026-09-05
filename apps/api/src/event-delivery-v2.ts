import { setTimeout as delay } from "node:timers/promises";

import { signReportEvent } from "./security.js";

export interface AccountEventDelivery {
  event_id: string;
  destination_id: string;
  destination_url: string;
  encrypted_signing_secret: string;
  attempts: number;
  created_at: Date;
  account_id: string;
  report_id: string;
  event_type: string;
  lifecycle_attempt: number;
  occurred_at: Date;
}

export interface AccountEventDeliveryStore {
  claimEventDelivery(): Promise<AccountEventDelivery | null>;
  completeEventDelivery(eventId: string, destinationId: string): Promise<void>;
  retryEventDelivery(eventId: string, destinationId: string, error: string, delayMilliseconds: number): Promise<void>;
}

interface EventDeliveryOptions {
  decrypt(value: string): string;
  fetcher?: typeof fetch;
  now?: () => Date;
}

export class AccountEventDeliveryWorker {
  private stopping = false;
  private running: Promise<void> | undefined;
  private readonly fetcher: typeof fetch;
  private readonly now: () => Date;

  public constructor(
    private readonly store: AccountEventDeliveryStore,
    private readonly options: EventDeliveryOptions
  ) {
    this.fetcher = options.fetcher ?? fetch;
    this.now = options.now ?? (() => new Date());
  }

  public start(): void {
    if (this.running !== undefined) return;
    this.stopping = false;
    this.running = this.loop();
  }

  public async stop(): Promise<void> {
    this.stopping = true;
    await this.running;
    this.running = undefined;
  }

  public async processOne(): Promise<boolean> {
    const delivery = await this.store.claimEventDelivery();
    if (delivery === null) return false;
    try {
      const body = JSON.stringify({
        eventId: delivery.event_id,
        accountId: delivery.account_id,
        reportId: delivery.report_id,
        type: delivery.event_type,
        occurredAt: delivery.occurred_at.toISOString(),
        lifecycleAttempt: delivery.lifecycle_attempt
      });
      const timestamp = Math.floor(this.now().getTime() / 1_000).toString();
      const secret = this.options.decrypt(delivery.encrypted_signing_secret);
      const response = await this.fetcher(delivery.destination_url, {
        method: "POST",
        redirect: "error",
        headers: {
          "content-type": "application/json",
          "x-report-event-id": delivery.event_id,
          "x-report-event-timestamp": timestamp,
          "x-report-event-signature": signReportEvent(secret, timestamp, delivery.event_id, body)
        },
        body,
        signal: AbortSignal.timeout(10_000)
      });
      if (!response.ok) throw new DeliveryHttpError(response.status);
      await this.store.completeEventDelivery(delivery.event_id, delivery.destination_id);
    } catch (error) {
      const status = error instanceof DeliveryHttpError ? error.status : null;
      const backoff = status === 409 && delivery.attempts === 1
        ? 500 + Math.floor(Math.random() * 501)
        : Math.min(3_600_000, 1_000 * 2 ** Math.min(12, delivery.attempts));
      const message = status === null ? "Webhook delivery failed." : `Webhook returned HTTP ${status}.`;
      await this.store.retryEventDelivery(delivery.event_id, delivery.destination_id, message, backoff);
    }
    return true;
  }

  private async loop(): Promise<void> {
    while (!this.stopping) {
      try {
        if (!(await this.processOne())) await delay(1_000);
      } catch {
        await delay(1_500);
      }
    }
  }
}

class DeliveryHttpError extends Error {
  public constructor(public readonly status: number) {
    super(`Webhook returned HTTP ${status}.`);
  }
}
