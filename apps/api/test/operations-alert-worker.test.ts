import { describe, expect, it, vi } from "vitest";

import {
  OperationsAlertWorker,
  type OperationsAlertFailureContext,
  type OperationsAlertStore
} from "../src/operations-alert-worker.js";

const emptySnapshot = {
  preparation: { readyPending: 0, delayedPending: 0, running: 0, oldestReadyAgeMs: null },
  lifecycle: {
    readyPending: 0,
    delayedPending: 0,
    running: 0,
    oldestReadyAgeMs: null,
    byJobKind: { requestCode: 0, verifySubmit: 0, submitReview: 0 }
  }
};

const healthyWorkers = ["preparation", "lifecycle", "delivery"].map((component) => ({
  component,
  heartbeatAgeMs: 0,
  progressAgeMs: 0,
  configuredCapacity: 1,
  activeJobs: 0,
  recentFailureCount: 0,
  recentRateLimitCount: 0
}));

const defaultStore: OperationsAlertStore = {
  queueSnapshot: vi.fn(() => Promise.resolve(emptySnapshot)),
  recordOperationalWorker: vi.fn(() => Promise.resolve(undefined)),
  operationalWorkerHealth: vi.fn(() => Promise.resolve(healthyWorkers)),
  transitionOperationalAlerts: vi.fn(() => Promise.resolve(undefined)),
  claimOperationsAlert: vi.fn(() => Promise.resolve(null)),
  completeOperationsAlert: vi.fn(() => Promise.resolve(undefined)),
  retryOperationsAlert: vi.fn(() => Promise.resolve(undefined))
};

function createStore(overrides: Partial<OperationsAlertStore> = {}): OperationsAlertStore {
  return { ...defaultStore, ...overrides };
}

function createWorker(
  store: OperationsAlertStore,
  onFailure: (error: unknown, context: OperationsAlertFailureContext) => void | Promise<void>,
  fetcher: typeof fetch = vi.fn(() => Promise.resolve(new Response(null, { status: 204 })))
): OperationsAlertWorker {
  return new OperationsAlertWorker(
    store,
    "https://alerts.example.invalid/webhook/secret-value",
    { preparation: 1, lifecycle: 1, delivery: 1 },
    fetcher,
    "00000000-0000-4000-8000-000000000001",
    onFailure
  );
}

describe("OperationsAlertWorker failure reporting", () => {
  it("reports sample failures once per outage and resets after a successful sample", async () => {
    const failure = new Error("database unavailable");
    let shouldFail = true;
    const store = createStore({
      queueSnapshot: vi.fn(() => {
        if (shouldFail) return Promise.reject(failure);
        return Promise.resolve(emptySnapshot);
      })
    });
    const onFailure = vi.fn();
    const worker = createWorker(store, onFailure);

    await expect(worker.sampleOnce()).rejects.toBe(failure);
    await expect(worker.sampleOnce()).rejects.toBe(failure);
    shouldFail = false;
    await worker.sampleOnce();
    shouldFail = true;
    await expect(worker.sampleOnce()).rejects.toBe(failure);

    expect(onFailure).toHaveBeenCalledTimes(2);
    expect(onFailure).toHaveBeenNthCalledWith(1, failure, {
      operation: "sample", stage: "queue_snapshot", outcome: "failed"
    });
  });

  it("reports claim failures with bounded context and isolates callback failures", async () => {
    const failure = new Error("database unavailable");
    const claimOperationsAlert = vi.fn()
      .mockRejectedValueOnce(failure)
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce(null)
      .mockRejectedValueOnce(failure);
    const store = createStore({ claimOperationsAlert });
    const onFailure = vi.fn(() => { throw new Error("telemetry unavailable"); });
    const worker = createWorker(store, onFailure);

    await expect(worker.deliverOne()).rejects.toBe(failure);
    await expect(worker.deliverOne()).rejects.toBe(failure);
    await expect(worker.deliverOne()).resolves.toBe(false);
    await expect(worker.deliverOne()).rejects.toBe(failure);

    expect(onFailure).toHaveBeenCalledTimes(2);
    expect(onFailure).toHaveBeenNthCalledWith(1, failure, {
      operation: "claim", stage: "claim_alert", outcome: "failed"
    });
  });

  it("reports original delivery and retry persistence errors with alert context", async () => {
    const deliveryError = new Error("webhook request timed out");
    const retryError = new Error("outbox database unavailable");
    const item = { id: "alert-id-123", payload: { alertKey: "queue.preparation.no_progress" }, attempts: 4 };
    const retryOperationsAlert = vi.fn(() => Promise.reject(retryError));
    const store = createStore({
      claimOperationsAlert: vi.fn(() => Promise.resolve(item)),
      retryOperationsAlert
    });
    const onFailure = vi.fn();
    const fetcher = vi.fn(() => Promise.reject(deliveryError)) as unknown as typeof fetch;
    const worker = createWorker(store, onFailure, fetcher);

    await expect(worker.deliverOne()).rejects.toBe(retryError);

    expect(retryOperationsAlert).toHaveBeenCalledWith("alert-id-123", 60, "network");
    expect(onFailure).toHaveBeenNthCalledWith(1, deliveryError, {
      operation: "delivery", stage: "webhook", outcome: "failed",
      alertId: "alert-id-123", alertKey: "queue.preparation.no_progress", attempt: 4
    });
    expect(onFailure).toHaveBeenNthCalledWith(2, retryError, {
      operation: "retry", stage: "persist_retry", outcome: "failed",
      alertId: "alert-id-123", alertKey: "queue.preparation.no_progress", attempt: 4
    });
    expect(JSON.stringify(onFailure.mock.calls)).not.toContain("secret-value");
  });
});
