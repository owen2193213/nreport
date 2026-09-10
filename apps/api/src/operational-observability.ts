import type { QueueSnapshot } from "./report-repository.js";

type QueueSnapshotStore = { queueSnapshot(): Promise<QueueSnapshot> };
type QueueLogger = (
  event: string,
  fields: Record<string, unknown>,
  level?: "info" | "warn" | "error"
) => void;

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

  public stop(): void {
    if (this.timer === undefined) return;
    this.cancel(this.timer);
    this.timer = undefined;
  }

  public async sampleOnce(): Promise<void> {
    const startedAt = this.now();
    try {
      const snapshot = await this.store.queueSnapshot();
      this.safeLog("queue_snapshot", {
        stage: "queues",
        outcome: "sampled",
        durationMs: Math.max(0, this.now() - startedAt),
        ...snapshot
      });
    } catch {
      this.safeLog("queue_snapshot_failed", {
        stage: "queues",
        outcome: "failed",
        durationMs: Math.max(0, this.now() - startedAt),
        errorCategory: "repository"
      }, "error");
    }
  }

  private safeLog(event: string, fields: Record<string, unknown>, level?: "info" | "warn" | "error"): void {
    try {
      if (level === undefined) this.logger(event, fields);
      else this.logger(event, fields, level);
    } catch {
      // Observability failures must never affect workers or future samples.
    }
  }
}
