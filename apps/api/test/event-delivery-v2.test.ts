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
