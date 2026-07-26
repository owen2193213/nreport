import { describe, expect, it, vi } from "vitest";

import worker from "../src/index.js";

function emailMessage(overrides: Partial<ForwardableEmailMessage> = {}): ForwardableEmailMessage {
  return {
    from: "noreply@discord.com",
    to: "omar.kuznetsov.23456789abcdefgh@example.com",
    headers: new Headers(),
    raw: new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("test email"));
        controller.close();
      }
    }),
    rawSize: 10,
    setReject: vi.fn(),
    forward: vi.fn(),
    reply: vi.fn(),
    ...overrides
  };
}

describe("email worker", () => {
  it("silently ignores mail from senders other than Discord", async () => {
    const setReject = vi.fn();
    const message = emailMessage({ from: "email@pixiewooshop.com", setReject });
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await worker.email(message, {
      INGEST_URL: "https://example.com/ingest",
      INGEST_SHARED_SECRET: "test-secret"
    });

    expect(setReject).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith(
      JSON.stringify({ event: "email_ignored", reason: "untrusted_sender" })
    );
    fetchSpy.mockRestore();
    logSpy.mockRestore();
  });

  it("silently ignores Discord mail sent to an unrelated recipient", async () => {
    const setReject = vi.fn();
    const message = emailMessage({ to: "omar.kuznetsov+7980@poccnr.ru", setReject });
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await worker.email(message, {
      INGEST_URL: "https://example.com/ingest",
      INGEST_SHARED_SECRET: "test-secret"
    });

    expect(setReject).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith(
      JSON.stringify({ event: "email_ignored", reason: "invalid_recipient_pattern" })
    );
    fetchSpy.mockRestore();
    logSpy.mockRestore();
  });

  it("handles HTTP requests without exposing an endpoint", async () => {
    const response = worker.fetch();

    expect(response.status).toBe(404);
    await expect(response.text()).resolves.toBe("Not found");
  });

  it("logs the configured forwarding boundary and Railway response status", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 202 }));
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await worker.email(emailMessage(), {
      INGEST_URL: "https://example.com/ingest",
      INGEST_SHARED_SECRET: "test-secret"
    });

    expect(fetchSpy).toHaveBeenCalledOnce();
    const startedLog: unknown = logSpy.mock.calls[0]?.[0];
    const completedLog: unknown = logSpy.mock.calls[1]?.[0];
    expect(startedLog).toEqual(expect.stringContaining('"event":"email_forward_started"'));
    expect(startedLog).toEqual(expect.stringContaining('"ingestUrlConfigured":true'));
    expect(completedLog).toEqual(expect.stringContaining('"event":"email_forward_completed"'));
    expect(completedLog).toEqual(expect.stringContaining('"httpStatus":202'));
    fetchSpy.mockRestore();
    logSpy.mockRestore();
  });
});
