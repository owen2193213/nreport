import { afterEach, describe, expect, it, vi } from "vitest";

import { PreparationWorker } from "../src/preparation-worker.js";
import { ApiReportPreparer } from "../src/preparation/api-report-preparer.js";
import { ReportWriter } from "../src/preparation/report-writer.js";

afterEach(() => vi.restoreAllMocks());

describe("known preparation pipeline defects (expected failures, not fixes)", () => {
  it.fails("preserves an incomplete provider outcome through the real writer and preparer", async () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const request = vi.fn().mockResolvedValue({ statusCode: 200, headers: { "content-type": "application/json" },
      body: { text: () => Promise.resolve(JSON.stringify({ choices: [{ finish_reason: "length", message: { content: null } }] })) } });
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

  it.fails("cancels an in-flight writer promptly when preparation is aborted", async () => {
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
});
