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
      claimPreparation: vi.fn().mockResolvedValue({ jobId: "job", report: { id: "report",
        trace_id: "33333333-3333-4333-8333-333333333333", request_input: {
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
    const removeEventListener = vi.spyOn(controller.signal, "removeEventListener");
    const running = preparer.prepare({ flow: "message", useAi: true,
      target: { messageUrl: "https://discord.com/channels/@me/123456789012345678/123456789012345679" }
    }, () => Promise.resolve(), controller.signal, { reportId: "11111111-1111-4111-8111-111111111111", traceId: "33333333-3333-4333-8333-333333333333" })
      .then(() => "resolved", () => "aborted");
    controller.abort(new DOMException("Deadline exceeded", "TimeoutError"));
    const observed = await Promise.race([running, new Promise<string>((resolve) => setImmediate(() => resolve("still-running")))]);
    finish(undefined as never);
    await running;
    expect(observed).toBe("aborted");
    expect(removeEventListener).toHaveBeenCalledWith("abort", expect.any(Function));
  });

  it("keeps only a safe provider message in the writer cause chain", async () => {
    const providerMessage = "Provider account is out of credits";
    const privateBodyCanary = "CANARY_PROVIDER_REASONING";
    const request = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      error: { message: providerMessage, code: 500 },
      reasoning: privateBodyCanary,
      request: { prompt: privateBodyCanary }
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    const failure = await new ReportWriter("test-key", "test-model", "test-search", ["DE"], { request })
      .generate({ flow: "message_urf", messageUrl: "https://discord.com/channels/@me/123456789012345678/123456789012345679" }, {
        reportId: "11111111-1111-4111-8111-111111111111",
        traceId: "33333333-3333-4333-8333-333333333333",
        userId: "user"
      })
      .catch((error: unknown) => error);

    expect(failure).toMatchObject({ kind: "provider" });
    const cause = (failure as Error).cause;
    expect(cause).toMatchObject({ kind: "provider" });
    expect(cause).toBeInstanceOf(Error);
    expect((cause as Error).message).toContain(providerMessage);
    expect(String(cause)).not.toContain(privateBodyCanary);
  });

  it.each([
    ["provider", () => Promise.resolve(new Response(JSON.stringify({ error: { message: "Provider account is out of credits; api_key=CANARY_SECRET_TOKEN", code: 500 }, reasoning: "CANARY_PROVIDER_REASONING" }), { status: 200, headers: { "Content-Type": "application/json" } }))],
    ["payment_required", () => Promise.resolve(new Response(JSON.stringify({ error: { message: "Payment required; api_key=CANARY_SECRET_TOKEN", code: "insufficient_quota" }, reasoning: "CANARY_PROVIDER_REASONING" }), { status: 402, headers: { "Content-Type": "application/json" } }))],
    ["refusal", () => Promise.resolve(new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: null, refusal: "CANARY_REFUSAL" } }] }), { status: 200, headers: { "Content-Type": "application/json" } }))],
    ["rate_limited", () => Promise.resolve(new Response(JSON.stringify({ error: { message: "Monthly quota exhausted; password=CANARY_PROVIDER_SECRET; verification code 123456", code: 429 }, debug: "CANARY_RATE_LIMIT_BODY" }), { status: 429, headers: { "Content-Type": "application/json" } }))],
    ["incomplete", () => Promise.resolve(new Response(JSON.stringify({ choices: [{ finish_reason: "length", message: { content: null, reasoning_content: "CANARY_REASONING" } }] }), { status: 200, headers: { "Content-Type": "application/json" } }))],
    ["malformed", () => Promise.resolve(new Response("CANARY_MALFORMED_BODY", { status: 200 }))],
    ["timeout", () => Promise.reject(new DOMException("CANARY_TIMEOUT_DETAIL", "TimeoutError"))]
  ] as const)("preserves %s from provider through writer, preparer, and worker", async (kind, outcome) => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const request = vi.fn().mockImplementation(outcome);
    const preparer = new ApiReportPreparer({ writerFactory: (recordUsage) => new ReportWriter("test-key", "test-model", "test-search", ["DE"], { request, recordUsage }) });
    const store = {
      claimPreparation: vi.fn().mockResolvedValue({ jobId: "job", report: { id: "report",
        trace_id: "33333333-3333-4333-8333-333333333333", request_input: {
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
    const serialized = write.mock.calls.map(([line]) => String(line)).join("");
    expect(serialized).not.toMatch(/CANARY_(?:SECRET_TOKEN|PROVIDER_SECRET|PROVIDER_REASONING|REFUSAL|RATE_LIMIT_BODY|REASONING|MALFORMED_BODY|TIMEOUT_DETAIL)/);
    expect(serialized).not.toContain("123456");
    if (kind === "provider") expect(serialized).toContain("Provider account is out of credits");
    if (kind === "payment_required") {
      expect(serialized).toContain("Payment required");
      expect(serialized).toContain("insufficient_quota");
    }
    if (kind === "rate_limited") expect(serialized).toContain("Monthly quota exhausted");
    const operationalLogs = write.mock.calls.map(([line]) => JSON.parse(String(line)) as Record<string, unknown>);
    expect(operationalLogs.length).toBeGreaterThan(0);
    expect(operationalLogs.every((event) => event.traceId === "33333333-3333-4333-8333-333333333333")).toBe(true);
    expect(operationalLogs.every((event) => !("actorKey" in event))).toBe(true);
  });

  it("uses provider-neutral public wording for an exhausted research rate limit", async () => {
    const plan = new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify({
      termResearchRequired: true,
      termSearchQuery: "coded term meaning",
      lawResearchRequired: false,
      lawSearchQuery: null,
      provisionalLawReference: "Germany Basic Law Article 1"
    }) } }] }), { status: 200, headers: { "Content-Type": "application/json" } });
    const request = vi.fn()
      .mockResolvedValueOnce(plan)
      .mockResolvedValue(new Response("private research limit body", { status: 429 }));
    const preparer = new ApiReportPreparer({ writerFactory: (recordUsage) => new ReportWriter("test-key", "test-model", "test-search", ["DE"], { request, recordUsage }) });
    const store = {
      claimPreparation: vi.fn().mockResolvedValue({ jobId: "job", report: { id: "report",
        trace_id: "33333333-3333-4333-8333-333333333333", request_input: {
        flow: "profile", useAi: true, country: "DE", category: "sub_other_hate_speech", description: "Evidence summary.",
        target: { reportedUsername: "example", reportedUserId: "123456789012345678", reportedUserSnapshot: null, profileElements: ["photos"] }
      } } }), transition: vi.fn().mockResolvedValue(true), completePreparation: vi.fn(), failPreparation: vi.fn()
    };
    await new PreparationWorker(store, preparer, vi.fn() as never).processOne();

    expect(store.failPreparation).toHaveBeenCalledWith(
      "job",
      "report",
      "preparation_rate_limited",
      "A preparation provider is rate limited. Retry the report shortly.",
      undefined
    );
  });
});
