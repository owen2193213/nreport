import { describe, expect, it, vi } from "vitest";

import { OperationalHealthSampler, QueueObservabilitySampler } from "../src/operational-observability.js";

const emptySnapshot = {
  preparation: { readyPending: 0, delayedPending: 0, running: 0, oldestReadyAgeMs: null },
  lifecycle: { readyPending: 0, delayedPending: 0, running: 0, oldestReadyAgeMs: null,
    byJobKind: { requestCode: 0, verifySubmit: 0, submitReview: 0 } }
};

describe("QueueObservabilitySampler", () => {
  it("emits a bounded queue snapshot with stable outcome fields", async () => {
    const logger = vi.fn();
    const sampler = new QueueObservabilitySampler({ queueSnapshot: vi.fn(() => Promise.resolve(emptySnapshot)) }, logger, {
      now: (() => { const values = [1_000, 1_007]; return () => values.shift() ?? 1_007; })()
    });

    await sampler.sampleOnce();

    expect(logger).toHaveBeenCalledWith("queue_snapshot", expect.objectContaining({
      stage: "queues", outcome: "sampled", durationMs: 7, ...emptySnapshot,
      memory: {
        rssBytes: expect.any(Number) as number,
        heapTotalBytes: expect.any(Number) as number,
        heapUsedBytes: expect.any(Number) as number,
        externalBytes: expect.any(Number) as number,
        arrayBuffersBytes: expect.any(Number) as number
      }
    }));
  });

  it("emits a safe failure and does not leak repository errors", async () => {
    const logger = vi.fn((
      event: string,
      fields: Record<string, unknown>,
      level?: "info" | "warn" | "error"
    ) => {
      void event;
      void fields;
      void level;
    });
    const sampler = new QueueObservabilitySampler({
      queueSnapshot: vi.fn().mockRejectedValue(new Error("database password=super-secret-token and report id"))
    }, logger, { now: () => 50 });

    await expect(sampler.sampleOnce()).resolves.toBeUndefined();
    const [event, fields, level] = logger.mock.calls[0] ?? [];
    expect(event).toBe("queue_snapshot_failed");
    expect(fields).toMatchObject({
      stage: "queues", outcome: "failed", durationMs: 0, errorCategory: "repository",
      errorName: "Error", errorMessage: "database password=[REDACTED] and report id"
    });
    const memory = fields?.memory as { heapUsedBytes?: unknown } | undefined;
    expect(typeof memory?.heapUsedBytes).toBe("number");
    expect(level).toBe("error");
    expect(JSON.stringify(logger.mock.calls)).not.toContain("super-secret-token");
  });

  it("reports a queue failure once until a successful sample clears the failure state", async () => {
    const failure = new Error("database unavailable");
    let shouldFail = true;
    const captureFailure = vi.fn();
    const sampler = new QueueObservabilitySampler({
      queueSnapshot: vi.fn(() => {
        if (shouldFail) throw failure;
        return Promise.resolve(emptySnapshot);
      })
    }, vi.fn(), { onFailure: captureFailure });

    await sampler.sampleOnce();
    await sampler.sampleOnce();
    shouldFail = false;
    await sampler.sampleOnce();
    shouldFail = true;
    await sampler.sampleOnce();

    expect(captureFailure).toHaveBeenNthCalledWith(1, failure);
    expect(captureFailure).toHaveBeenCalledTimes(2);
  });

  it("isolates logger failures on success and repository failure", async () => {
    const throwingLogger = vi.fn(() => { throw new Error("logger unavailable"); });
    await expect(new QueueObservabilitySampler({ queueSnapshot: vi.fn(() => Promise.resolve(emptySnapshot)) }, throwingLogger).sampleOnce()).resolves.toBeUndefined();
    await expect(new QueueObservabilitySampler({ queueSnapshot: vi.fn().mockRejectedValue(new Error("db")) }, throwingLogger).sampleOnce()).resolves.toBeUndefined();
  });

  it("coalesces overlapping ticks into one repository sample", async () => {
    let release!: (value: typeof emptySnapshot) => void;
    const pending = new Promise<typeof emptySnapshot>((resolve) => { release = resolve; });
    const queueSnapshot = vi.fn(() => pending);
    const sampler = new QueueObservabilitySampler({ queueSnapshot }, vi.fn());

    const first = sampler.sampleOnce();
    const second = sampler.sampleOnce();
    expect(queueSnapshot).toHaveBeenCalledOnce();
    release(emptySnapshot);
    await Promise.all([first, second]);
    expect(queueSnapshot).toHaveBeenCalledOnce();
  });

  it("clears the cadence and drains the active sample before stop resolves", async () => {
    let release!: (value: typeof emptySnapshot) => void;
    const pending = new Promise<typeof emptySnapshot>((resolve) => { release = resolve; });
    const clearInterval = vi.fn();
    const sampler = new QueueObservabilitySampler(
      { queueSnapshot: vi.fn(() => pending) },
      vi.fn(),
      { setInterval: vi.fn(() => "timer"), clearInterval }
    );
    sampler.start();

    let stopped = false;
    const stopping = Promise.resolve(sampler.stop()).then(() => { stopped = true; });
    await Promise.resolve();
    expect(clearInterval).toHaveBeenCalledWith("timer");
    expect(stopped).toBe(false);
    release(emptySnapshot);
    await stopping;
    expect(stopped).toBe(true);
  });

  it("isolates asynchronous logger rejection without an unhandled rejection", async () => {
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      const logger = vi.fn(() => Promise.reject(new Error("async logger unavailable")));
      const sampler = new QueueObservabilitySampler({
        queueSnapshot: vi.fn(() => Promise.resolve(emptySnapshot))
      }, logger);
      await expect(sampler.sampleOnce()).resolves.toBeUndefined();
      await new Promise((resolve) => setImmediate(resolve));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });

  it("clamps the sampling interval to operational bounds", () => {
    expect(new QueueObservabilitySampler({ queueSnapshot: vi.fn() }, vi.fn(), { intervalMs: 1 }).intervalMs).toBe(5_000);
    expect(new QueueObservabilitySampler({ queueSnapshot: vi.fn() }, vi.fn(), { intervalMs: 9_999_999 }).intervalMs).toBe(300_000);
  });
});

describe("OperationalHealthSampler", () => {
  it("updates worker health and current alert state without a webhook delivery dependency", async () => {
    const store = {
      queueSnapshot: vi.fn(() => Promise.resolve({
        ...emptySnapshot,
        preparation: { readyPending: 1, delayedPending: 0, running: 0, oldestReadyAgeMs: 130_000 }
      })),
      recordOperationalWorker: vi.fn((sample: {
        component: string;
        instanceId: string;
        configuredCapacity: number;
        activeJobs?: number;
      }) => {
        void sample;
        return Promise.resolve();
      }),
      operationalWorkerHealth: vi.fn(() => Promise.resolve([{
        component: "preparation", heartbeatAgeMs: 5_000, progressAgeMs: 130_000,
        configuredCapacity: 2, activeJobs: 0, recentFailureCount: 3, recentRateLimitCount: 0
      }])),
      observeOperationalAlerts: vi.fn(() => Promise.resolve())
    };
    const sampler = new OperationalHealthSampler(store, "instance-1", {
      preparation: 2, lifecycle: 2, delivery: 1
    });

    await sampler.sampleOnce();

    expect(store.recordOperationalWorker).toHaveBeenCalledTimes(3);
    expect(store.recordOperationalWorker.mock.calls.map(([sample]) => sample.component)).toEqual([
      "preparation", "lifecycle", "delivery"
    ]);
    expect(store.observeOperationalAlerts).toHaveBeenCalledWith([
      { key: "worker.preparation.failures", severity: "critical" },
      { key: "queue.preparation.oldest_ready", severity: "warning" },
      { key: "queue.preparation.no_progress", severity: "critical" }
    ]);
  });

  it("reports an operational sample failure once until a later sample succeeds", async () => {
    const failure = new Error("database unavailable");
    let shouldFail = true;
    const store = {
      queueSnapshot: vi.fn(() => {
        if (shouldFail) return Promise.reject(failure);
        return Promise.resolve(emptySnapshot);
      }),
      recordOperationalWorker: vi.fn((sample: {
        component: string;
        instanceId: string;
        configuredCapacity: number;
        activeJobs?: number;
      }) => {
        void sample;
        return Promise.resolve();
      }),
      operationalWorkerHealth: vi.fn(() => Promise.resolve([])),
      observeOperationalAlerts: vi.fn(() => Promise.resolve())
    };
    const onFailure = vi.fn();
    const sampler = new OperationalHealthSampler(store, "instance-1", {
      preparation: 2, lifecycle: 2, delivery: 1
    }, { onFailure });

    await sampler.sampleOnce();
    await sampler.sampleOnce();
    shouldFail = false;
    await sampler.sampleOnce();
    shouldFail = true;
    await sampler.sampleOnce();

    expect(onFailure).toHaveBeenNthCalledWith(1, failure);
    expect(onFailure).toHaveBeenCalledTimes(2);
  });
});
