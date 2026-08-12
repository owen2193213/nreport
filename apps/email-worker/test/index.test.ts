import { describe, expect, it, vi } from "vitest";

import worker from "../src/index.js";

function emailMessage(overrides: Partial<ForwardableEmailMessage> = {}): ForwardableEmailMessage {
  return {
    from: "noreply@discord.com", to: "omar.kuznetsov.23456789abcdefgh@example.com", headers: new Headers(),
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

  it.each(["noreply@discord.com", "postmaster@o15.ptr9908.discord.com", "bounces+12551241-recipient=example.org@mail.discord.com"])("accepts Discord envelope sender %s", async (from) => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 202 }));
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await worker.email(emailMessage({ from }), { INGEST_URL: "https://example.com/ingest", INGEST_SHARED_SECRET: "test-secret" });
    expect(fetchSpy).toHaveBeenCalledOnce(); fetchSpy.mockRestore(); logSpy.mockRestore();
  });

  it("rejects lookalike domains outside discord.com", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch"); const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await worker.email(emailMessage({ from: "postmaster@o15.ptr9908.discord.com.example.org" }), { INGEST_URL: "https://example.com/ingest", INGEST_SHARED_SECRET: "test-secret" });
    expect(fetchSpy).not.toHaveBeenCalled(); expect(logSpy).toHaveBeenCalledWith(JSON.stringify({ event: "email_ignored", reason: "untrusted_sender" }));
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

  it("logs a bounded redacted API failure response", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ detail: "recipient alias@example.test rejected" }), { status: 422, headers: { "content-type": "application/json", "x-request-id": "ingest-1" } })));
    await expect(worker.email(emailMessage(), { INGEST_URL: "https://api.example", INGEST_SHARED_SECRET: "secret" })).rejects.toThrow(/HTTP 422/);
    const event: unknown = JSON.parse(String(error.mock.calls[0]?.[0]));
    expect(event).toMatchObject({ event: "email_forward_failed", httpStatus: 422, requestId: "ingest-1", response: { body: "{\"detail\":\"recipient [redacted-email] rejected\"}" } });
    error.mockRestore(); vi.unstubAllGlobals();
  });
});
