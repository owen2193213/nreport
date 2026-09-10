import { describe, expect, it, vi } from "vitest";

import { QueueObservabilitySampler } from "../src/operational-observability.js";

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

    expect(logger).toHaveBeenCalledWith("queue_snapshot", {
      stage: "queues", outcome: "sampled", durationMs: 7, ...emptySnapshot
    });
  });

  it("emits a safe failure and does not leak repository errors", async () => {
    const logger = vi.fn();
    const sampler = new QueueObservabilitySampler({
      queueSnapshot: vi.fn().mockRejectedValue(new Error("database secret and report id"))
    }, logger, { now: () => 50 });

    await expect(sampler.sampleOnce()).resolves.toBeUndefined();
    expect(logger).toHaveBeenCalledWith("queue_snapshot_failed", {
      stage: "queues", outcome: "failed", durationMs: 0, errorCategory: "repository"
    }, "error");
    expect(JSON.stringify(logger.mock.calls)).not.toContain("database secret");
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
