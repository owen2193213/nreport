import { setTimeout as delay } from "node:timers/promises";
import { randomUUID } from "node:crypto";

import { evaluateOperationalAlerts } from "./operational-alerts.js";
import type { QueueSnapshot } from "./report-repository.js";

const RETRY_SECONDS = [5, 15, 30, 60, 120, 300] as const;
const MAX_ACTIVE_FAILURES = 512;

export interface OperationsAlertFailureContext {
  operation: "sample" | "claim" | "delivery" | "retry";
  stage: string;
  outcome: "failed";
  alertId?: string;
  alertKey?: string;
  attempt?: number;
}

export type OperationsAlertFailureHandler = (
  error: unknown,
  context: OperationsAlertFailureContext
) => void | Promise<void>;

export interface OperationsAlertStore {
  queueSnapshot(): Promise<QueueSnapshot>;
  recordOperationalWorker(sample: { component: string; instanceId: string; configuredCapacity: number; activeJobs?: number; progressed?: boolean; failure?: boolean; rateLimited?: boolean }): Promise<void>;
  operationalWorkerHealth(): Promise<Array<{ component: string; heartbeatAgeMs: number; progressAgeMs: number | null; configuredCapacity: number; activeJobs: number; recentFailureCount: number; recentRateLimitCount: number }>>;
  transitionOperationalAlerts(alerts: Array<{ key: string; severity: "warning" | "critical" }>): Promise<void>;
  claimOperationsAlert(): Promise<{ id: string; payload: { alertKey: string; severity?: string; status?: string }; attempts: number } | null>;
  completeOperationsAlert(id: string): Promise<void>;
  retryOperationsAlert(id: string, delaySeconds: number, category: string): Promise<void>;
}

export class OperationsAlertWorker {
  private stopping = false;
  private running: Promise<void> | undefined;
  private readonly instanceId: string;
  private readonly activeFailures = new Set<string>();

  public constructor(
    private readonly store: OperationsAlertStore,
    private readonly webhookUrl: string,
    private readonly configuredCapacity: { preparation: number; lifecycle: number; delivery: number },
    private readonly fetcher: typeof fetch = fetch,
    instanceId = randomUUID(),
    private readonly onFailure?: OperationsAlertFailureHandler
  ) { this.instanceId = instanceId; }

  public start(): void { if (this.running === undefined) { this.stopping = false; this.running = this.loop(); } }
  public async stop(): Promise<void> { this.stopping = true; await this.running; this.running = undefined; }

  public async sampleOnce(): Promise<void> {
    let stage = "queue_snapshot";
    try {
      const snapshot = await this.store.queueSnapshot();
      stage = "worker_heartbeat";
      await Promise.all([
        this.store.recordOperationalWorker({ component: "preparation", instanceId: this.instanceId, configuredCapacity: this.configuredCapacity.preparation, activeJobs: snapshot.preparation.running }),
        this.store.recordOperationalWorker({ component: "lifecycle", instanceId: this.instanceId, configuredCapacity: this.configuredCapacity.lifecycle, activeJobs: snapshot.lifecycle.running }),
        this.store.recordOperationalWorker({ component: "delivery", instanceId: this.instanceId, configuredCapacity: this.configuredCapacity.delivery })
      ]);
      stage = "worker_health";
      const workers = await this.store.operationalWorkerHealth();
      stage = "alert_transition";
      await this.store.transitionOperationalAlerts(evaluateOperationalAlerts({
        nowMs: Date.now(), queues: snapshot, workers: workers.map((worker) => ({
          component: worker.component, lastHeartbeatAgeMs: worker.heartbeatAgeMs, lastProgressAgeMs: worker.progressAgeMs,
          recentFailureCount: worker.recentFailureCount, recentRateLimitCount: worker.recentRateLimitCount
        }))
      }));
      this.clearFailures("sample:");
    } catch (error) {
      this.reportFailure(`sample:${stage}`, error, { operation: "sample", stage, outcome: "failed" });
      throw error;
    }
  }

  public async deliverOne(): Promise<boolean> {
    let item: Awaited<ReturnType<OperationsAlertStore["claimOperationsAlert"]>>;
    try {
      item = await this.store.claimOperationsAlert();
      this.activeFailures.delete("claim");
    } catch (error) {
      this.reportFailure("claim", error, { operation: "claim", stage: "claim_alert", outcome: "failed" });
      throw error;
    }
    if (item === null) return false;
    let stage = "webhook";
    try {
      const response = await this.fetcher(this.webhookUrl, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: `NReport operations alert: ${item.payload.alertKey}${item.payload.status === "recovered" ? " recovered" : ""}` }),
        signal: AbortSignal.timeout(5_000)
      });
      if (!response.ok) throw new Error("http");
      stage = "complete";
      await this.store.completeOperationsAlert(item.id);
      this.activeFailures.delete(`delivery:${item.id}`);
      this.activeFailures.delete(`retry:${item.id}`);
    } catch (error) {
      const context = {
        operation: "delivery" as const,
        stage,
        outcome: "failed" as const,
        alertId: item.id,
        alertKey: item.payload.alertKey,
        attempt: item.attempts
      };
      this.reportFailure(`delivery:${item.id}`, error, context);
      const index = Math.min(Math.max(1, item.attempts), RETRY_SECONDS.length) - 1;
      try {
        await this.store.retryOperationsAlert(item.id, RETRY_SECONDS[index]!, error instanceof Error && error.message === "http" ? "http" : "network");
      } catch (retryError) {
        this.reportFailure(`retry:${item.id}`, retryError, {
          operation: "retry",
          stage: "persist_retry",
          outcome: "failed",
          alertId: item.id,
          alertKey: item.payload.alertKey,
          attempt: item.attempts
        });
        throw retryError;
      }
    }
    return true;
  }

  private reportFailure(key: string, error: unknown, context: OperationsAlertFailureContext): void {
    if (this.onFailure === undefined || this.activeFailures.has(key)) return;
    if (this.activeFailures.size >= MAX_ACTIVE_FAILURES) {
      const oldest = this.activeFailures.values().next().value;
      if (oldest !== undefined) this.activeFailures.delete(oldest);
    }
    this.activeFailures.add(key);
    try {
      void Promise.resolve(this.onFailure(error, context)).catch(() => undefined);
    } catch {
      // The alert reporter must never alter sampling or delivery behavior.
    }
  }

  private clearFailures(prefix: string): void {
    for (const key of this.activeFailures) {
      if (key.startsWith(prefix)) this.activeFailures.delete(key);
    }
  }

  private async loop(): Promise<void> {
    let nextSampleAt = 0;
    while (!this.stopping) {
      try {
        if (Date.now() >= nextSampleAt) {
          // Schedule before sampling so a database failure cannot create a tight retry loop.
          nextSampleAt = Date.now() + 30_000;
          await this.sampleOnce();
        }
        if (!(await this.deliverOne())) await delay(1_000);
      } catch { await delay(1_000); }
    }
  }
}
