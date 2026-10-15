import type { QueueSnapshot } from "./report-repository.js";
import { safeErrorSummary } from "@nreport/observability";
import { evaluateOperationalAlerts } from "./operational-alerts.js";

type QueueSnapshotStore = { queueSnapshot(): Promise<QueueSnapshot> };
type QueueLogger = (
  event: string,
  fields: Record<string, unknown>,
  level?: "info" | "warn" | "error"
) => void | Promise<void>;

interface QueueSamplerOptions {
  onFailure?: (error: unknown) => void;
  intervalMs?: number;
  now?: () => number;
  setInterval?: (callback: () => void, milliseconds: number) => unknown;
  clearInterval?: (handle: unknown) => void;
}

export class QueueObservabilitySampler {
  public readonly intervalMs: number;
  private readonly now: () => number;
  private readonly schedule: (callback: () => void, milliseconds: number) => unknown;
  private readonly cancel: (handle: unknown) => void;
  private timer: unknown;
  private inFlight: Promise<void> | undefined;
  private failureActive = false;

  public constructor(
    private readonly store: QueueSnapshotStore,
    private readonly logger: QueueLogger,
    private readonly options: QueueSamplerOptions = {}
  ) {
    this.intervalMs = Math.max(5_000, Math.min(300_000, this.options.intervalMs ?? 60_000));
    this.now = this.options.now ?? Date.now;
    this.schedule = this.options.setInterval ?? ((callback, milliseconds) => setInterval(callback, milliseconds));
    this.cancel = this.options.clearInterval ?? ((handle) => clearInterval(handle as ReturnType<typeof setInterval>));
  }

  public start(): void {
    if (this.timer !== undefined) return;
    void this.sampleOnce();
    this.timer = this.schedule(() => void this.sampleOnce(), this.intervalMs);
  }

  public async stop(): Promise<void> {
    if (this.timer !== undefined) {
      this.cancel(this.timer);
      this.timer = undefined;
    }
    await this.inFlight;
  }

  public sampleOnce(): Promise<void> {
    if (this.inFlight !== undefined) return this.inFlight;
    const running = this.runSample().finally(() => {
      if (this.inFlight === running) this.inFlight = undefined;
    });
    this.inFlight = running;
    return running;
  }

  private async runSample(): Promise<void> {
    const startedAt = this.now();
    try {
      const snapshot = await this.store.queueSnapshot();
      this.failureActive = false;
      await this.safeLog("queue_snapshot", {
        stage: "queues",
        outcome: "sampled",
        durationMs: Math.max(0, this.now() - startedAt),
        memory: processMemorySnapshot(),
        ...snapshot
      });
    } catch (error) {
      const summary = safeErrorSummary(error);
      await this.safeLog("queue_snapshot_failed", {
        stage: "queues",
        outcome: "failed",
        durationMs: Math.max(0, this.now() - startedAt),
        errorCategory: "repository",
        errorName: summary.name,
        errorMessage: summary.message,
        ...(summary.stack === undefined ? {} : { errorStack: summary.stack }),
        ...(summary.causes.length === 0 ? {} : { errorCauses: summary.causes }),
        memory: processMemorySnapshot()
      }, "error");
      if (!this.failureActive) this.safeCapture(error);
      this.failureActive = true;
    }
  }

  private async safeLog(event: string, fields: Record<string, unknown>, level?: "info" | "warn" | "error"): Promise<void> {
    try {
      if (level === undefined) await this.logger(event, fields);
      else await this.logger(event, fields, level);
    } catch {
      // Observability failures must never affect workers or future samples.
    }
  }

  private safeCapture(error: unknown): void {
    try {
      this.options.onFailure?.(error);
    } catch {
      // Failure reporting must not interrupt queue sampling.
    }
  }
}

type OperationalHealthStore = {
  queueSnapshot(): Promise<QueueSnapshot>;
  recordOperationalWorker(sample: {
    component: string;
    instanceId: string;
    configuredCapacity: number;
    activeJobs?: number;
  }): Promise<void>;
  operationalWorkerHealth(): Promise<Array<{
    component: string;
    heartbeatAgeMs: number;
    progressAgeMs: number | null;
    configuredCapacity: number;
    activeJobs: number;
    recentFailureCount: number;
    recentRateLimitCount: number;
  }>>;
  observeOperationalAlerts(alerts: Array<{ key: string; severity: "warning" | "critical" }>): Promise<void>;
};

interface OperationalHealthSamplerOptions {
  onFailure?: (error: unknown) => void;
  intervalMs?: number;
  setInterval?: (callback: () => void, milliseconds: number) => unknown;
  clearInterval?: (handle: unknown) => void;
}

export class OperationalHealthSampler {
  private readonly intervalMs: number;
  private readonly schedule: (callback: () => void, milliseconds: number) => unknown;
  private readonly cancel: (handle: unknown) => void;
  private timer: unknown;
  private inFlight: Promise<void> | undefined;
  private failureActive = false;

  public constructor(
    private readonly store: OperationalHealthStore,
    private readonly instanceId: string,
    private readonly configuredCapacity: { preparation: number; lifecycle: number; delivery: number },
    private readonly options: OperationalHealthSamplerOptions = {}
  ) {
    this.intervalMs = Math.max(5_000, Math.min(300_000, this.options.intervalMs ?? 30_000));
    this.schedule = this.options.setInterval ?? ((callback, milliseconds) => setInterval(callback, milliseconds));
    this.cancel = this.options.clearInterval ?? ((handle) => clearInterval(handle as ReturnType<typeof setInterval>));
  }

  public start(): void {
    if (this.timer !== undefined) return;
    void this.sampleOnce();
    this.timer = this.schedule(() => void this.sampleOnce(), this.intervalMs);
  }

  public async stop(): Promise<void> {
    if (this.timer !== undefined) {
      this.cancel(this.timer);
      this.timer = undefined;
    }
    await this.inFlight;
  }

  public sampleOnce(): Promise<void> {
    if (this.inFlight !== undefined) return this.inFlight;
    const running = this.runSample().finally(() => {
      if (this.inFlight === running) this.inFlight = undefined;
    });
    this.inFlight = running;
    return running;
  }

  private async runSample(): Promise<void> {
    try {
      const snapshot = await this.store.queueSnapshot();
      await Promise.all([
        this.store.recordOperationalWorker({
          component: "preparation", instanceId: this.instanceId,
          configuredCapacity: this.configuredCapacity.preparation, activeJobs: snapshot.preparation.running
        }),
        this.store.recordOperationalWorker({
          component: "lifecycle", instanceId: this.instanceId,
          configuredCapacity: this.configuredCapacity.lifecycle, activeJobs: snapshot.lifecycle.running
        }),
        this.store.recordOperationalWorker({
          component: "delivery", instanceId: this.instanceId,
          configuredCapacity: this.configuredCapacity.delivery
        })
      ]);
      const workers = await this.store.operationalWorkerHealth();
      await this.store.observeOperationalAlerts(evaluateOperationalAlerts({
        nowMs: Date.now(),
        queues: snapshot,
        workers: workers.map((worker) => ({
          component: worker.component,
          lastHeartbeatAgeMs: worker.heartbeatAgeMs,
          lastProgressAgeMs: worker.progressAgeMs,
          recentFailureCount: worker.recentFailureCount,
          recentRateLimitCount: worker.recentRateLimitCount
        }))
      }));
      this.failureActive = false;
    } catch (error) {
      if (!this.failureActive) {
        try {
          this.options.onFailure?.(error);
        } catch {
          // Operational health reporting must not affect application workers.
        }
      }
      this.failureActive = true;
    }
  }
}

function processMemorySnapshot(): Record<string, number> {
  const memory = process.memoryUsage();
  return {
    rssBytes: memory.rss,
    heapTotalBytes: memory.heapTotal,
    heapUsedBytes: memory.heapUsed,
    externalBytes: memory.external,
    arrayBuffersBytes: memory.arrayBuffers
  };
}
