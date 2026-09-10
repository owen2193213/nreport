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

  it("clamps the sampling interval to operational bounds", () => {
    expect(new QueueObservabilitySampler({ queueSnapshot: vi.fn() }, vi.fn(), { intervalMs: 1 }).intervalMs).toBe(5_000);
    expect(new QueueObservabilitySampler({ queueSnapshot: vi.fn() }, vi.fn(), { intervalMs: 9_999_999 }).intervalMs).toBe(300_000);
  });
});
