import { afterEach, describe, expect, it, vi } from "vitest";

import { PreparationWorker } from "../src/preparation-worker.js";
import { ApiReportPreparer } from "../src/preparation/api-report-preparer.js";
import { ReportWriter } from "../src/preparation/report-writer.js";

afterEach(() => vi.restoreAllMocks());

describe("preparation pipeline reliability", () => {
  it("preserves an incomplete provider outcome through the real writer and preparer", async () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const request = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ choices: [{ finish_reason: "length", message: { content: null } }] }),
      { status: 200, headers: { "content-type": "application/json" } }
    ));
    const preparer = new ApiReportPreparer({ writerFactory: (recordUsage) => new ReportWriter("test-key", "test-model", "test-search", ["DE"], { request, recordUsage }) });
    const store = {
      claimPreparation: vi.fn().mockResolvedValue({ jobId: "job", report: { id: "report", request_input: {
        flow: "message", useAi: true, target: { messageUrl: "https://discord.com/channels/@me/123456789012345678/123456789012345679" }
      } } }), transition: vi.fn().mockResolvedValue(true), completePreparation: vi.fn(), failPreparation: vi.fn()
    };
    const worker = new PreparationWorker(store, preparer, vi.fn() as never);
    await worker.processOne();
    // Exactly one assertion: an unexpected setup exception must not masquerade as this expected mismatch.
    expect.assertions(1);
    expect({ requests: request.mock.calls.length, failures: store.failPreparation.mock.calls.map((call) => call[2] as unknown) })
      .toEqual({ requests: 1, failures: ["preparation_incomplete"] });
  });

  it("cancels an in-flight writer promptly when preparation is aborted", async () => {
    let finish!: (value: never) => void;
    const generate = vi.fn().mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const preparer = new ApiReportPreparer({ writerFactory: () => ({ generate }) });
    const controller = new AbortController();
    const running = preparer.prepare({ flow: "message", useAi: true,
      target: { messageUrl: "https://discord.com/channels/@me/123456789012345678/123456789012345679" }
    }, () => Promise.resolve(), controller.signal).then(() => "resolved", () => "aborted");
    controller.abort(new DOMException("Deadline exceeded", "TimeoutError"));
    const observed = await Promise.race([running, new Promise<string>((resolve) => setImmediate(() => resolve("still-running")))]);
    finish(undefined as never);
    await running;
    expect.assertions(1);
    expect(observed).toBe("aborted");
  });

  it.each([
    ["provider", () => Promise.resolve(new Response(JSON.stringify({ error: { message: "CANARY_PROVIDER_MESSAGE", code: 500 } }), { status: 200, headers: { "Content-Type": "application/json" } }))],
    ["refusal", () => Promise.resolve(new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: null, refusal: "CANARY_REFUSAL" } }] }), { status: 200, headers: { "Content-Type": "application/json" } }))],
    ["rate_limited", () => Promise.resolve(new Response("CANARY_RATE_LIMIT_BODY", { status: 429 }))],
    ["incomplete", () => Promise.resolve(new Response(JSON.stringify({ choices: [{ finish_reason: "length", message: { content: null, reasoning_content: "CANARY_REASONING" } }] }), { status: 200, headers: { "Content-Type": "application/json" } }))],
    ["malformed", () => Promise.resolve(new Response("CANARY_MALFORMED_BODY", { status: 200 }))],
    ["timeout", () => Promise.reject(new DOMException("CANARY_TIMEOUT_DETAIL", "TimeoutError"))]
  ] as const)("preserves %s from provider through writer, preparer, and worker", async (kind, outcome) => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const request = vi.fn().mockImplementation(outcome);
    const preparer = new ApiReportPreparer({ writerFactory: (recordUsage) => new ReportWriter("test-key", "test-model", "test-search", ["DE"], { request, recordUsage }) });
    const store = {
      claimPreparation: vi.fn().mockResolvedValue({ jobId: "job", report: { id: "report", request_input: {
        flow: "message", useAi: true, target: { messageUrl: "https://discord.com/channels/@me/123456789012345678/123456789012345679" }
      } } }), transition: vi.fn().mockResolvedValue(true), completePreparation: vi.fn(), failPreparation: vi.fn()
    };
    const onIterationError = vi.fn();
    const worker = new PreparationWorker(store, preparer, vi.fn() as never, 2, () => Promise.resolve(undefined), onIterationError);

    await worker.processOne();

    expect(store.failPreparation.mock.calls[0]?.[2]).toBe(`preparation_${kind}`);
    expect(onIterationError).toHaveBeenCalledWith(expect.objectContaining({
      errorCode: `preparation_${kind}`,
      kind,
      stage: "plan"
    }));
    expect(write.mock.calls.map(([line]) => String(line)).join(""))
      .not.toMatch(/CANARY_(?:PROVIDER_MESSAGE|REFUSAL|RATE_LIMIT_BODY|REASONING|MALFORMED_BODY|TIMEOUT_DETAIL)/);
  });
});
