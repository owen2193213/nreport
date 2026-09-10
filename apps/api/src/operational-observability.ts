import type { QueueSnapshot } from "./report-repository.js";

type QueueSnapshotStore = { queueSnapshot(): Promise<QueueSnapshot> };
type QueueLogger = (
  event: string,
  fields: Record<string, unknown>,
  level?: "info" | "warn" | "error"
) => void | Promise<void>;

interface QueueSamplerOptions {
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

  public constructor(
    private readonly store: QueueSnapshotStore,
    private readonly logger: QueueLogger,
    options: QueueSamplerOptions = {}
  ) {
    this.intervalMs = Math.max(5_000, Math.min(300_000, options.intervalMs ?? 60_000));
    this.now = options.now ?? Date.now;
    this.schedule = options.setInterval ?? ((callback, milliseconds) => setInterval(callback, milliseconds));
    this.cancel = options.clearInterval ?? ((handle) => clearInterval(handle as ReturnType<typeof setInterval>));
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
      await this.safeLog("queue_snapshot", {
        stage: "queues",
        outcome: "sampled",
        durationMs: Math.max(0, this.now() - startedAt),
        ...snapshot
      });
    } catch {
      await this.safeLog("queue_snapshot_failed", {
        stage: "queues",
        outcome: "failed",
        durationMs: Math.max(0, this.now() - startedAt),
        errorCategory: "repository"
      }, "error");
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
}
