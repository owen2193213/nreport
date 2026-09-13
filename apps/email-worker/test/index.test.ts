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
    expect(logSpy).toHaveBeenCalledWith(JSON.stringify({ event: "email_ignored", reason: "untrusted_sender" }));
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
    expect(logSpy).toHaveBeenCalledWith(JSON.stringify({ event: "email_ignored", reason: "invalid_recipient_pattern" }));
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
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("x", {
      status: 502,
      headers: { "content-type": "application/json; secret=attacker-controlled", "x-request-id": "attacker-controlled request id" }
    })));

    await expect(worker.email(emailMessage(), { INGEST_URL: "https://api.example", INGEST_SHARED_SECRET: "secret" })).rejects.toThrow(/HTTP 502/);
    expect(JSON.stringify(error.mock.calls)).not.toContain("attacker-controlled");

    error.mockRestore(); vi.unstubAllGlobals();
  });

  it("logs bounded API failure metadata without the response body", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ detail: "recipient alias@example.test rejected" }), { status: 422, headers: { "content-type": "application/json", "x-request-id": "ingest-1" } })));
    await expect(worker.email(emailMessage(), { INGEST_URL: "https://api.example", INGEST_SHARED_SECRET: "secret" })).rejects.toThrow(/HTTP 422/);
    const event: unknown = JSON.parse(String(error.mock.calls[0]?.[0]));
    expect(event).toMatchObject({ event: "email_forward_failed", httpStatus: 422, requestId: "ingest-1", response: { contentType: "application/json" } });
    expect(JSON.stringify(event)).not.toContain("alias@example.test");
    error.mockRestore(); vi.unstubAllGlobals();
  });
});
