import { describe, expect, it, vi } from "vitest";

import worker from "../src/index.js";

function emailMessage(overrides: Partial<ForwardableEmailMessage> = {}): ForwardableEmailMessage {
  return {
    from: "noreply@discord.com", to: "omar.kuznetsov.23456789abcdefgh@example.com", headers: new Headers({ from: "Discord <noreply@discord.com>" }),
    raw: new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode("test email")); controller.close(); } }),
    rawSize: 10, setReject: vi.fn(), forward: vi.fn(), reply: vi.fn(), ...overrides
  };
}

describe("email worker", () => {
  it("silently ignores mail from senders other than Discord", async () => {
    const setReject = vi.fn(); const message = emailMessage({ from: "email@pixiewooshop.com", setReject });
    const fetchSpy = vi.spyOn(globalThis, "fetch"); const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await worker.email(message, { INGEST_URL: "https://example.com/ingest", INGEST_SHARED_SECRET: "test-secret" });
    expect(setReject).not.toHaveBeenCalled(); expect(fetchSpy).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('"event":"email_ignored"'));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('"reason":"untrusted_sender"'));
    fetchSpy.mockRestore(); logSpy.mockRestore();
  });

  it("accepts the exact trusted Discord envelope sender", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 202 }));
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await worker.email(emailMessage({ from: "noreply@discord.com", headers: new Headers({ from: "Discord <noreply@discord.com>" }) }), { INGEST_URL: "https://example.com/ingest", INGEST_SHARED_SECRET: "test-secret" });
    expect(fetchSpy).toHaveBeenCalledOnce(); fetchSpy.mockRestore(); logSpy.mockRestore();
  });

  it("accepts Discord's bounce envelope regardless of visible sender formatting", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 202 }));
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await worker.email(emailMessage({
      from: "bounces+12551241-92b7-omar.kuznetsov.23456789abcdefgh=example.com@mail.discord.com",
      headers: new Headers()
    }), { INGEST_URL: "https://example.com/ingest", INGEST_SHARED_SECRET: "test-secret" });
    expect(fetchSpy).toHaveBeenCalledOnce(); fetchSpy.mockRestore(); logSpy.mockRestore();
  });

  it.each(["noreply@evil-discord.com", "NOREPLY@discord.com.evil.example"])("rejects untrusted Discord-like envelope sender %s", async (from) => {
    const fetchSpy = vi.spyOn(globalThis, "fetch"); const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await worker.email(emailMessage({ from }), { INGEST_URL: "https://example.com/ingest", INGEST_SHARED_SECRET: "test-secret" });
    expect(fetchSpy).not.toHaveBeenCalled(); fetchSpy.mockRestore(); logSpy.mockRestore();
  });

  it("accepts other valid Discord subdomain envelopes", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch"); const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    fetchSpy.mockResolvedValue(new Response(null, { status: 202 }));
    await worker.email(emailMessage({ from: "postmaster@o15.ptr9908.discord.com", headers: new Headers() }), { INGEST_URL: "https://example.com/ingest", INGEST_SHARED_SECRET: "test-secret" });
    expect(fetchSpy).toHaveBeenCalledOnce();
    fetchSpy.mockRestore(); logSpy.mockRestore();
  });

  it.each(["discord.com", "@discord.com", "sender@evildiscord.com"])("rejects malformed or unrelated envelope sender %s", async (from) => {
    const fetchSpy = vi.spyOn(globalThis, "fetch"); const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await worker.email(emailMessage({ from }), { INGEST_URL: "https://example.com/ingest", INGEST_SHARED_SECRET: "test-secret" });
    expect(fetchSpy).not.toHaveBeenCalled(); fetchSpy.mockRestore(); logSpy.mockRestore();
  });

  it("silently ignores Discord mail sent to an unrelated recipient", async () => {
    const setReject = vi.fn(); const message = emailMessage({ to: "omar.kuznetsov+7980@poccnr.ru", setReject });
    const fetchSpy = vi.spyOn(globalThis, "fetch"); const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await worker.email(message, { INGEST_URL: "https://example.com/ingest", INGEST_SHARED_SECRET: "test-secret" });
    expect(setReject).not.toHaveBeenCalled(); expect(fetchSpy).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('"event":"email_ignored"'));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('"reason":"invalid_recipient_pattern"'));
    fetchSpy.mockRestore(); logSpy.mockRestore();
  });

  it("handles HTTP requests without exposing an endpoint", async () => {
    const response = worker.fetch(); expect(response.status).toBe(404); await expect(response.text()).resolves.toBe("Not found");
  });

  it("logs the configured forwarding boundary and Railway response status", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 202 }));
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await worker.email(emailMessage(), { INGEST_URL: "https://example.com/ingest", INGEST_SHARED_SECRET: "test-secret" });
    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(logSpy.mock.calls[0]?.[0]).toEqual(expect.stringContaining('"event":"email_forward_started"'));
    expect(logSpy.mock.calls[0]?.[0]).toEqual(expect.stringContaining('"ingestUrlConfigured":true'));
    expect(logSpy.mock.calls[1]?.[0]).toEqual(expect.stringContaining('"event":"email_forward_completed"'));
    expect(logSpy.mock.calls[1]?.[0]).toEqual(expect.stringContaining('"httpStatus":202'));
    fetchSpy.mockRestore(); logSpy.mockRestore();
  });

  it("logs validated report correlation returned by a successful ingest", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      status: "accepted", reportId: "11111111-1111-4111-8111-111111111111", traceId: "22222222-2222-4222-8222-222222222222"
    }), { status: 202, headers: { "content-type": "application/json" } }));
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await worker.email(emailMessage(), { INGEST_URL: "https://example.com/ingest", INGEST_SHARED_SECRET: "test-secret" });
    expect(logSpy.mock.calls[1]?.[0]).toContain('"reportId":"11111111-1111-4111-8111-111111111111"');
    expect(logSpy.mock.calls[1]?.[0]).toContain('"traceId":"22222222-2222-4222-8222-222222222222"');
    expect(logSpy.mock.calls[1]?.[0]).toContain('"registrationStatus":"accepted"');
    fetchSpy.mockRestore(); logSpy.mockRestore();
  });

  it("warns only when a matched successful response omits a valid correlation pair", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: "unknown_recipient" }), { status: 202 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: "accepted", reportId: "not-a-uuid", traceId: "also-not-a-uuid" }), { status: 202 }));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await worker.email(emailMessage(), { INGEST_URL: "https://example.com/ingest", INGEST_SHARED_SECRET: "test-secret" });
    expect(warnSpy).not.toHaveBeenCalled();
    await worker.email(emailMessage(), { INGEST_URL: "https://example.com/ingest", INGEST_SHARED_SECRET: "test-secret" });
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('"event":"email_forward_correlation_missing"'));

    fetchSpy.mockRestore(); warnSpy.mockRestore(); logSpy.mockRestore();
  });

  it("does not log attacker-controlled failed response headers", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout").mockImplementation(((callback: () => void) => {
      callback();
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("x", {
      status: 502,
      headers: { "content-type": "application/json; secret=attacker-controlled", "x-request-id": "attacker-controlled request id" }
    })));

    await expect(worker.email(emailMessage(), { INGEST_URL: "https://api.example", INGEST_SHARED_SECRET: "secret" })).rejects.toThrow(/HTTP 502/);
    expect(JSON.stringify(error.mock.calls)).not.toContain("attacker-controlled");
    expect(JSON.stringify(warn.mock.calls)).not.toContain("attacker-controlled");

    error.mockRestore(); warn.mockRestore(); setTimeoutSpy.mockRestore(); vi.unstubAllGlobals();
  });

  it("logs the generated alias with bounded API failure metadata", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ detail: "recipient alias@example.test rejected" }), { status: 422, headers: { "content-type": "application/json", "x-request-id": "ingest-1" } })));
    await expect(worker.email(emailMessage(), { INGEST_URL: "https://api.example", INGEST_SHARED_SECRET: "secret" })).rejects.toThrow(/HTTP 422/);
    const event: unknown = JSON.parse(String(error.mock.calls[0]?.[0]));
    expect(event).toMatchObject({ event: "email_forward_failed", httpStatus: 422, requestId: "ingest-1", response: { contentType: "application/json" } });
    expect(event).toMatchObject({ recipient: "omar.kuznetsov.23456789abcdefgh@example.com" });
    error.mockRestore(); vi.unstubAllGlobals();
  });

  it("does not retry other 4xx failures", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("failed", { status: 400 }));
    await expect(worker.email(emailMessage(), { INGEST_URL: "https://api.example/ingest", INGEST_SHARED_SECRET: "secret" })).rejects.toThrow(/HTTP 400/);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    fetchSpy.mockRestore();
  });

  it("retries transient HTTP 429/5xx forwarding failures with backoff, then succeeds", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout").mockImplementation(((callback: () => void) => {
      callback();
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout);
    const fetchSpy = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("busy", { status: 429 }))
      .mockResolvedValueOnce(new Response("down", { status: 503 }))
      .mockResolvedValueOnce(new Response(null, { status: 202 }));

    await worker.email(emailMessage(), { INGEST_URL: "https://api.example/ingest", INGEST_SHARED_SECRET: "secret" });

    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[0]?.[0]).toEqual(expect.stringContaining('"event":"email_forward_retrying"'));
    expect(warn.mock.calls[0]?.[0]).toEqual(expect.stringContaining('"attempt":1'));
    expect(warn.mock.calls[1]?.[0]).toEqual(expect.stringContaining('"attempt":2'));
    // Each attempt is re-signed: a timestamp and matching signature header are sent every time.
    for (const call of fetchSpy.mock.calls) {
      const headers = call[1]?.headers as Record<string, string>;
      expect(headers["x-dsa-timestamp"]).toMatch(/^\d+$/);
      expect(headers["x-dsa-signature"]).toMatch(/^[a-f0-9]{64}$/);
    }
    // Delays follow the ~1s then ~3s schedule.
    expect(setTimeoutSpy.mock.calls[0]?.[1]).toBe(1_000);
    expect(setTimeoutSpy.mock.calls[1]?.[1]).toBe(3_000);

    fetchSpy.mockRestore(); warn.mockRestore(); logSpy.mockRestore(); setTimeoutSpy.mockRestore();
  });

  it("retries transient network errors up to three attempts", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout").mockImplementation(((callback: () => void) => {
      callback();
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout);
    const fetchSpy = vi.spyOn(globalThis, "fetch")
      .mockRejectedValueOnce(new Error("network down"))
      .mockResolvedValueOnce(new Response(null, { status: 202 }));

    await worker.email(emailMessage(), { INGEST_URL: "https://api.example/ingest", INGEST_SHARED_SECRET: "secret" });

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toEqual(expect.stringContaining('"event":"email_forward_retrying"'));

    fetchSpy.mockRestore(); warn.mockRestore(); logSpy.mockRestore(); setTimeoutSpy.mockRestore();
  });

  it("does not retry a fourth time, and posts signed metadata diagnostics only after the final attempt", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout").mockImplementation(((callback: () => void) => {
      callback();
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout);
    const fetchSpy = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("failed", { status: 502 }))
      .mockResolvedValueOnce(new Response("failed", { status: 502 }))
      .mockResolvedValueOnce(new Response("failed", { status: 502 }))
      .mockResolvedValueOnce(new Response(null, { status: 202 }));

    await expect(worker.email(emailMessage(), { INGEST_URL: "https://api.example/ingest", DIAGNOSTIC_URL: "https://api.example/email-diagnostics", INGEST_SHARED_SECRET: "secret" })).rejects.toThrow(/HTTP 502/);

    // Exactly 3 forward attempts, then the diagnostic post as the 4th fetch call.
    expect(fetchSpy).toHaveBeenCalledTimes(4);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(fetchSpy.mock.calls[3]?.[0]).toBe("https://api.example/email-diagnostics");

    fetchSpy.mockRestore(); warn.mockRestore(); error.mockRestore(); setTimeoutSpy.mockRestore();
  });
});
