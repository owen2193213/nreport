import { createHmac } from "node:crypto";

/* eslint-disable @typescript-eslint/require-await, @typescript-eslint/no-base-to-string, @typescript-eslint/no-unsafe-assignment */
import { describe, expect, it, vi } from "vitest";

import { AccountEventDeliveryWorker } from "../src/event-delivery-v2.js";
import { sha256Hex } from "../src/security.js";

describe("account event delivery", () => {
  it("sends only the minimal signed event envelope and marks delivery complete", async () => {
    const delivery = {
      event_id: "42",
      destination_id: "dest-1",
      destination_url: "https://bot.example.test/internal/report-events",
      encrypted_signing_secret: "encrypted",
      attempts: 1,
      created_at: new Date("2026-09-04T00:00:00Z"),
      account_id: "account-1",
      report_id: "report-1",
      trace_id: "33333333-3333-4333-8333-333333333333",
      event_type: "report_writing",
      lifecycle_attempt: 1,
      occurred_at: new Date("2026-09-04T00:00:01Z")
    };
    const store = {
      claimEventDelivery: vi.fn(async () => delivery),
      completeEventDelivery: vi.fn(),
      retryEventDelivery: vi.fn()
    };
    const fetcher: typeof fetch = vi.fn(async (_url: URL | RequestInfo, init?: RequestInit) => {
      if (init === undefined) throw new Error("Missing request options.");
      const body = String(init.body);
      const headers = init.headers as Record<string, string>;
      const expected = createHmac("sha256", "signing-secret")
        .update(`${headers["x-report-event-timestamp"]}\n42\n${sha256Hex(body)}`)
        .digest("hex");
      expect(headers["x-report-event-signature"]).toBe(expected);
      expect(JSON.parse(body)).toEqual({
        eventId: "42", accountId: "account-1", reportId: "report-1", traceId: "33333333-3333-4333-8333-333333333333",
        type: "report_writing", occurredAt: "2026-09-04T00:00:01.000Z", lifecycleAttempt: 1
      });
      return new Response(null, { status: 204 });
    });
    const worker = new AccountEventDeliveryWorker(
      store,
      { decrypt: vi.fn(() => "signing-secret"), fetcher, now: () => new Date("2026-09-04T00:00:02Z") }
    );

    expect(await worker.processOne()).toBe(true);
    expect(store.completeEventDelivery).toHaveBeenCalledWith("42", "dest-1");
    expect(store.retryEventDelivery).not.toHaveBeenCalled();
  });

  it("uses the narrow initial backoff for the bot-linking 409 race", async () => {
    const delivery = {
      event_id: "42", destination_id: "dest-1", destination_url: "https://bot.example.test/events",
      encrypted_signing_secret: "encrypted", attempts: 1, created_at: new Date(), account_id: "account-1",
      report_id: "report-1", event_type: "report_queued", lifecycle_attempt: 1, occurred_at: new Date()
      , trace_id: "33333333-3333-4333-8333-333333333333"
    };
    const store = {
      claimEventDelivery: vi.fn(async () => delivery), completeEventDelivery: vi.fn(), retryEventDelivery: vi.fn()
    };
    const worker = new AccountEventDeliveryWorker(store, {
      decrypt: () => "secret", fetcher: vi.fn(async () => new Response(null, { status: 409 })), now: () => new Date()
    });

    await worker.processOne();

    expect(store.retryEventDelivery).toHaveBeenCalledWith("42", "dest-1", expect.any(String), expect.any(Number));
    const delay = store.retryEventDelivery.mock.calls[0]?.[3];
    expect(delay).toBeGreaterThanOrEqual(500);
    expect(delay).toBeLessThanOrEqual(1_000);
  });

  it("keeps correlated transport details and captures a persistently failing delivery", async () => {
    const delivery = {
      event_id: "42", destination_id: "dest-1", destination_url: "https://bot.example.test/events",
      encrypted_signing_secret: "encrypted", attempts: 5, created_at: new Date(), account_id: "account-1",
      report_id: "report-1", trace_id: "33333333-3333-4333-8333-333333333333",
      event_type: "report_failed", lifecycle_attempt: 2, occurred_at: new Date()
    };
    const transportError = new Error("fetch failed; password=webhook-secret");
    const logger = vi.fn();
    const captureFailure = vi.fn();
    const store = {
      claimEventDelivery: vi.fn(async () => delivery),
      completeEventDelivery: vi.fn(),
      retryEventDelivery: vi.fn()
    };
    const worker = new AccountEventDeliveryWorker(store, {
      decrypt: () => "secret",
      fetcher: vi.fn(async () => { throw transportError; }),
      now: () => new Date(),
      log: logger,
      onFailure: captureFailure
    });

    await worker.processOne();

    expect(logger).toHaveBeenCalledWith("event_delivery_retry", expect.objectContaining({
      reportId: delivery.report_id,
      traceId: delivery.trace_id,
      eventType: delivery.event_type,
      lifecycleAttempt: 2,
      attempts: 5,
      errorMessage: "fetch failed; password=[REDACTED]"
    }), "warn");
    expect(JSON.stringify(logger.mock.calls)).not.toContain("webhook-secret");
    expect(captureFailure).toHaveBeenCalledWith(transportError, delivery);
  });

  it("captures retry-state persistence failures with delivery context and preserves the persistence cause", async () => {
    const delivery = {
      event_id: "42", destination_id: "dest-1", destination_url: "https://bot.example.test/events",
      encrypted_signing_secret: "encrypted", attempts: 2, created_at: new Date(), account_id: "account-1",
      report_id: "report-1", trace_id: "33333333-3333-4333-8333-333333333333",
      event_type: "report_failed", lifecycle_attempt: 3, occurred_at: new Date()
    };
    const transportError = new Error("fetch failed");
    const persistenceError = new Error("database unavailable; password=unsafe-secret");
    const logger = vi.fn();
    const capturePersistenceFailure = vi.fn();
    const store = {
      claimEventDelivery: vi.fn(async () => delivery),
      completeEventDelivery: vi.fn(),
      retryEventDelivery: vi.fn(async () => { throw persistenceError; })
    };
    const worker = new AccountEventDeliveryWorker(store, {
      decrypt: () => "secret",
      fetcher: vi.fn(async () => { throw transportError; }),
      now: () => new Date(),
      log: logger,
      onPersistenceFailure: capturePersistenceFailure
    });

    const iterationError = await worker.processOne().catch((error: unknown) => error);

    expect(iterationError).toBeInstanceOf(Error);
    if (!(iterationError instanceof Error)) throw new Error("Retry persistence failure was not an Error.");
    expect(iterationError.cause).toBe(persistenceError);
    expect(store.retryEventDelivery).toHaveBeenCalledTimes(1);
    expect(logger).toHaveBeenCalledWith("event_delivery_retry_persist_failed", expect.objectContaining({
      reportId: delivery.report_id,
      traceId: delivery.trace_id,
      eventType: delivery.event_type,
      lifecycleAttempt: 3,
      attempts: 2,
      stage: "retry_persist",
      errorMessage: "database unavailable; password=[REDACTED]",
      deliveryErrorMessage: "fetch failed"
    }), "error");
    expect(JSON.stringify(logger.mock.calls)).not.toContain("unsafe-secret");
    expect(capturePersistenceFailure).toHaveBeenCalledWith(persistenceError, delivery);
  });

  it("does not relabel retry-state persistence failures as webhook claim failures", async () => {
    const delivery = {
      event_id: "42", destination_id: "dest-1", destination_url: "https://bot.example.test/events",
      encrypted_signing_secret: "encrypted", attempts: 2, created_at: new Date(), account_id: "account-1",
      report_id: "report-1", trace_id: "33333333-3333-4333-8333-333333333333",
      event_type: "report_failed", lifecycle_attempt: 3, occurred_at: new Date()
    };
    const persistenceError = new Error("database unavailable");
    let worker!: AccountEventDeliveryWorker;
    const logger = vi.fn();
    const captureWorkerFailure = vi.fn();
    const capturePersistenceFailure = vi.fn();
    const stopped = new Promise<void>((resolve) => {
      const store = {
        claimEventDelivery: vi.fn(async () => delivery),
        completeEventDelivery: vi.fn(),
        retryEventDelivery: vi.fn(async () => { throw persistenceError; })
      };
      worker = new AccountEventDeliveryWorker(store, {
        decrypt: () => "secret",
        fetcher: vi.fn(async () => { throw new Error("fetch failed"); }),
        log: logger,
        onPersistenceFailure: capturePersistenceFailure,
        onWorkerFailure: captureWorkerFailure,
        concurrency: 1,
        sleep: async () => { void worker.stop().then(resolve); }
      });
      worker.start();
    });

    await stopped;

    expect(capturePersistenceFailure).toHaveBeenCalledWith(persistenceError, delivery);
    expect(captureWorkerFailure).not.toHaveBeenCalled();
    expect(logger).toHaveBeenCalledWith("event_delivery_retry_persist_failed", expect.any(Object), "error");
    expect(logger).not.toHaveBeenCalledWith("event_delivery_worker_iteration_failed", expect.any(Object), "error");
  });

  it("captures a delivery worker claim failure once until a successful claim recovers it", async () => {
    const firstFailure = new Error("database unavailable");
    const recoveredFailure = new Error("database unavailable again");
    let claims = 0;
    let worker!: AccountEventDeliveryWorker;
    const captureWorkerFailure = vi.fn();
    const stopped = new Promise<void>((resolve) => {
      const store = {
        claimEventDelivery: vi.fn(async () => {
          claims += 1;
          if (claims === 1) throw firstFailure;
          if (claims === 2) throw firstFailure;
          if (claims === 4) throw recoveredFailure;
          return null;
        }),
        completeEventDelivery: vi.fn(),
        retryEventDelivery: vi.fn()
      };
      worker = new AccountEventDeliveryWorker(store, {
        decrypt: () => "secret",
        onWorkerFailure: captureWorkerFailure,
        concurrency: 1,
        sleep: async () => {
          if (claims >= 4) void worker.stop().then(resolve);
        }
      });
      worker.start();
    });

    await stopped;

    expect(captureWorkerFailure).toHaveBeenNthCalledWith(1, firstFailure);
    expect(captureWorkerFailure).toHaveBeenNthCalledWith(2, recoveredFailure);
    expect(captureWorkerFailure).toHaveBeenCalledTimes(2);
  });

  it("runs multiple claim loops concurrently, and stop() waits for all of them to finish", async () => {
    let inFlight = 0;
    let peakInFlight = 0;
    let remaining = 12;
    const store = {
      claimEventDelivery: vi.fn(async () => {
        if (remaining <= 0) return null;
        remaining -= 1;
        inFlight += 1;
        peakInFlight = Math.max(peakInFlight, inFlight);
        // Yield so other concurrent loops get a chance to claim while this one is "in flight".
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight -= 1;
        return {
          event_id: String(remaining), destination_id: "dest-1", destination_url: "https://bot.example.test/events",
          encrypted_signing_secret: "encrypted", attempts: 1, created_at: new Date(), account_id: "account-1",
          report_id: "report-1", event_type: "report_queued", lifecycle_attempt: 1, occurred_at: new Date(),
          trace_id: "33333333-3333-4333-8333-333333333333"
        };
      }),
      completeEventDelivery: vi.fn(),
      retryEventDelivery: vi.fn()
    };
    const worker = new AccountEventDeliveryWorker(store, {
      decrypt: () => "secret", fetcher: vi.fn(async () => new Response(null, { status: 204 })), now: () => new Date(),
      concurrency: 4
    });

    worker.start();
    await new Promise((resolve) => setTimeout(resolve, 60));
    await worker.stop();

    expect(peakInFlight).toBeGreaterThan(1);
    expect(store.completeEventDelivery.mock.calls.length).toBeGreaterThan(0);
  });

  it("defaults to a concurrency of 4 and treats start() as a no-op while already running", async () => {
    const store = { claimEventDelivery: vi.fn(async () => null), completeEventDelivery: vi.fn(), retryEventDelivery: vi.fn() };
    const worker = new AccountEventDeliveryWorker(store, { decrypt: () => "secret" });

    worker.start();
    worker.start();
    await new Promise((resolve) => setTimeout(resolve, 20));
    await worker.stop();

    // With concurrency 4 and no work, each loop polls once then backs off for a
    // second; the repeated start() must not have spun up extra loops.
    expect(store.claimEventDelivery.mock.calls.length).toBe(4);
  });
});
