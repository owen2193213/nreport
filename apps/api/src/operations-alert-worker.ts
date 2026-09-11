import { setTimeout as delay } from "node:timers/promises";
import { randomUUID } from "node:crypto";

import { evaluateOperationalAlerts } from "./operational-alerts.js";
import type { QueueSnapshot } from "./report-repository.js";

const RETRY_SECONDS = [5, 15, 30, 60, 120, 300] as const;

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

  public constructor(
    private readonly store: OperationsAlertStore,
    private readonly webhookUrl: string,
    private readonly configuredCapacity: { preparation: number; lifecycle: number; delivery: number },
    private readonly fetcher: typeof fetch = fetch,
    instanceId = randomUUID()
  ) { this.instanceId = instanceId; }

  public start(): void { if (this.running === undefined) { this.stopping = false; this.running = this.loop(); } }
  public async stop(): Promise<void> { this.stopping = true; await this.running; this.running = undefined; }

  public async sampleOnce(): Promise<void> {
    const snapshot = await this.store.queueSnapshot();
    await Promise.all([
      this.store.recordOperationalWorker({ component: "preparation", instanceId: this.instanceId, configuredCapacity: this.configuredCapacity.preparation, activeJobs: snapshot.preparation.running }),
      this.store.recordOperationalWorker({ component: "lifecycle", instanceId: this.instanceId, configuredCapacity: this.configuredCapacity.lifecycle, activeJobs: snapshot.lifecycle.running }),
      this.store.recordOperationalWorker({ component: "delivery", instanceId: this.instanceId, configuredCapacity: this.configuredCapacity.delivery })
    ]);
    const workers = await this.store.operationalWorkerHealth();
    await this.store.transitionOperationalAlerts(evaluateOperationalAlerts({
      nowMs: Date.now(), queues: snapshot, workers: workers.map((worker) => ({
        component: worker.component, lastHeartbeatAgeMs: worker.heartbeatAgeMs, lastProgressAgeMs: worker.progressAgeMs,
        recentFailureCount: worker.recentFailureCount, recentRateLimitCount: worker.recentRateLimitCount
      }))
    }));
  }

  public async deliverOne(): Promise<boolean> {
    const item = await this.store.claimOperationsAlert();
    if (item === null) return false;
    try {
      const response = await this.fetcher(this.webhookUrl, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: `NReport operations alert: ${item.payload.alertKey}${item.payload.status === "recovered" ? " recovered" : ""}` }),
        signal: AbortSignal.timeout(5_000)
      });
      if (!response.ok) throw new Error("http");
      await this.store.completeOperationsAlert(item.id);
    } catch (error) {
      const index = Math.min(Math.max(1, item.attempts), RETRY_SECONDS.length) - 1;
      await this.store.retryOperationsAlert(item.id, RETRY_SECONDS[index]!, error instanceof Error && error.message === "http" ? "http" : "network");
    }
    return true;
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
