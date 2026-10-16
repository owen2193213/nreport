import { setTimeout as delay } from "node:timers/promises";

import { safeErrorSummary } from "@nreport/observability";
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
  trace_id: string;
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
  sleep?: (milliseconds: number) => Promise<unknown>;
  log?: (event: string, fields: Record<string, unknown>, level?: "info" | "warn" | "error") => void;
  onFailure?: (error: unknown, delivery: AccountEventDelivery) => void;
  onPersistenceFailure?: (error: unknown, delivery: AccountEventDelivery) => void;
  onWorkerFailure?: (error: unknown) => void;
  /** Number of concurrent claim/delivery loops. Defaults to 4. */
  concurrency?: number;
}

export class AccountEventDeliveryWorker {
  private stopping = false;
  private running: Promise<void>[] = [];
  private readonly fetcher: typeof fetch;
  private readonly now: () => Date;
  private readonly sleep: (milliseconds: number) => Promise<unknown>;
  private readonly concurrency: number;
  private claimFailureActive = false;

  public constructor(
    private readonly store: AccountEventDeliveryStore,
    private readonly options: EventDeliveryOptions
  ) {
    this.fetcher = options.fetcher ?? fetch;
    this.now = options.now ?? (() => new Date());
    this.sleep = options.sleep ?? delay;
    this.concurrency = Math.max(1, Math.floor(options.concurrency ?? 4));
  }

  public start(): void {
    if (this.running.length > 0) return;
    this.stopping = false;
    this.running = Array.from({ length: this.concurrency }, () => this.loop());
  }

  public async stop(): Promise<void> {
    this.stopping = true;
    await Promise.all(this.running);
    this.running = [];
  }

  public async processOne(): Promise<boolean> {
    const delivery = await this.store.claimEventDelivery();
    this.claimFailureActive = false;
    if (delivery === null) return false;
    const startedAt = this.now().getTime();
    try {
      const body = JSON.stringify({
        eventId: delivery.event_id,
        accountId: delivery.account_id,
        reportId: delivery.report_id,
        traceId: delivery.trace_id,
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
      this.safeLog("event_delivery_completed", {
        reportId: delivery.report_id, traceId: delivery.trace_id, eventType: delivery.event_type,
        lifecycleAttempt: delivery.lifecycle_attempt, stage: "webhook", outcome: "completed",
        durationMs: Math.max(0, this.now().getTime() - startedAt), attempts: delivery.attempts
      });
    } catch (error) {
      const status = error instanceof DeliveryHttpError ? error.status : null;
      const backoff = status === 409 && delivery.attempts === 1
        ? 500 + Math.floor(Math.random() * 501)
        : Math.min(3_600_000, 1_000 * 2 ** Math.min(12, delivery.attempts));
      const message = status === null ? "Webhook delivery failed." : `Webhook returned HTTP ${status}.`;
      try {
        await this.store.retryEventDelivery(delivery.event_id, delivery.destination_id, message, backoff);
      } catch (persistenceError) {
        const persistenceSummary = safeErrorSummary(persistenceError);
        const deliverySummary = safeErrorSummary(error);
        this.safeLog("event_delivery_retry_persist_failed", {
          reportId: delivery.report_id,
          traceId: delivery.trace_id,
          eventType: delivery.event_type,
          lifecycleAttempt: delivery.lifecycle_attempt,
          stage: "retry_persist",
          outcome: "failed",
          attempts: delivery.attempts,
          errorCategory: "delivery_state_persist_failed",
          ...(status === null ? {} : { deliveryHttpStatus: status }),
          errorName: persistenceSummary.name,
          errorMessage: persistenceSummary.message,
          ...(persistenceSummary.stack === undefined ? {} : { errorStack: persistenceSummary.stack }),
          ...(persistenceSummary.causes.length === 0 ? {} : { errorCauses: persistenceSummary.causes }),
          deliveryErrorName: deliverySummary.name,
          deliveryErrorMessage: deliverySummary.message,
          ...(deliverySummary.stack === undefined ? {} : { deliveryErrorStack: deliverySummary.stack }),
          ...(deliverySummary.causes.length === 0 ? {} : { deliveryErrorCauses: deliverySummary.causes })
        }, "error");
        this.safeCapturePersistenceFailure(persistenceError, delivery);
        throw new RetryPersistenceError(persistenceError);
      }
      const summary = safeErrorSummary(error);
      this.safeLog("event_delivery_retry", {
        reportId: delivery.report_id, traceId: delivery.trace_id, eventType: delivery.event_type,
        lifecycleAttempt: delivery.lifecycle_attempt, stage: "webhook", outcome: "retry",
        durationMs: Math.max(0, this.now().getTime() - startedAt), attempts: delivery.attempts,
        errorCategory: status === null ? "network" : "http",
        ...(status === null ? {} : { httpStatus: status }),
        errorName: summary.name,
        errorMessage: summary.message,
        ...(summary.stack === undefined ? {} : { errorStack: summary.stack }),
        ...(summary.causes.length === 0 ? {} : { errorCauses: summary.causes })
      }, "warn");
      if (delivery.attempts === 5) this.safeCaptureFailure(error, delivery);
    }
    return true;
  }

  private async loop(): Promise<void> {
    while (!this.stopping) {
      try {
        if (!(await this.processOne())) await this.sleep(1_000);
      } catch (error) {
        if (error instanceof RetryPersistenceError) {
          await this.sleep(1_500);
          continue;
        }
        const summary = safeErrorSummary(error);
        this.safeLog("event_delivery_worker_iteration_failed", {
          stage: "webhook_claim", outcome: "failed", errorName: summary.name,
          errorMessage: summary.message,
          ...(summary.stack === undefined ? {} : { errorStack: summary.stack }),
          ...(summary.causes.length === 0 ? {} : { errorCauses: summary.causes })
        }, "error");
        if (!this.claimFailureActive) {
          this.safeCaptureWorkerFailure(error);
          this.claimFailureActive = true;
        }
        await this.sleep(1_500);
      }
    }
  }

  private safeLog(event: string, fields: Record<string, unknown>, level?: "info" | "warn" | "error"): void {
    try {
      if (level === undefined) this.options.log?.(event, fields);
      else this.options.log?.(event, fields, level);
    } catch {
      // Logging must not interrupt durable delivery processing.
    }
  }

  private safeCaptureFailure(error: unknown, delivery: AccountEventDelivery): void {
    try {
      this.options.onFailure?.(error, delivery);
    } catch {
      // Failure reporting must not interrupt durable delivery processing.
    }
  }

  private safeCaptureWorkerFailure(error: unknown): void {
    try {
      this.options.onWorkerFailure?.(error);
    } catch {
      // Worker-iteration diagnostics must not stop durable delivery processing.
    }
  }

  private safeCapturePersistenceFailure(error: unknown, delivery: AccountEventDelivery): void {
    try {
      this.options.onPersistenceFailure?.(error, delivery);
    } catch {
      // Failure reporting must not interrupt durable delivery processing.
    }
  }
}

class RetryPersistenceError extends Error {
  public constructor(cause: unknown) {
    super("Failed to persist webhook delivery retry state.", { cause });
  }
}

class DeliveryHttpError extends Error {
  public constructor(public readonly status: number) {
    super(`Webhook returned HTTP ${status}.`);
  }
}
