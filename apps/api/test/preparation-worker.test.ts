/* eslint-disable @typescript-eslint/require-await, @typescript-eslint/no-unsafe-member-access */
import { describe, expect, it, vi } from "vitest";

import { PreparationWorker, preparationFailureLogFields } from "../src/preparation-worker.js";

const baseReport = {
  id: "report-1",
  account_id: "account-1",
  status: "queued" as const,
  lifecycle_attempt: 1,
  created_at: new Date(),
  updated_at: new Date()
};

describe("PreparationWorker", () => {
  it("keeps safe error correlation fields while excluding an error message", () => {
    const fields = preparationFailureLogFields({
      traceId: "33333333-3333-4333-8333-333333333333",
      errorCode: "preparation_failed",
      kind: "unknown",
      stage: "preparation",
      originalName: "TypeError",
      stackFingerprint: "a1b2c3d4e5f60708",
      safeMessage: "report content must never be logged"
    });

    expect(fields).toEqual({
      traceId: "33333333-3333-4333-8333-333333333333",
      errorCode: "preparation_failed",
      errorCategory: "unknown",
      preparationStage: "preparation",
      originalErrorName: "TypeError",
      stackFingerprint: "a1b2c3d4e5f60708"
    });
    expect(JSON.stringify(fields)).not.toContain("report content");
  });
  it("bounds active work and frees a slot after a job fails", async () => {
    const jobs = [1, 2, 3].map((id) => ({ jobId: `job-${id}`, report: { ...baseReport, id: `report-${id}`,
      request_input: { flow: "message", useAi: true, target: { messageUrl: "https://discord.com/channels/@me/123456789012345678/123456789012345679" } } } }));
    const releases: (() => void)[] = [];
    let active = 0;
    let peak = 0;
    const prepare = vi.fn(async () => {
      const index = releases.length;
      active += 1;
      peak = Math.max(peak, active);
      await new Promise<void>((resolve) => releases.push(resolve));
      active -= 1;
      if (index === 0) throw new Error("test failure");
      return { country: "DE", category: "category", description: "description", finalText: "text",
        legalReference: null, researchSummary: null, sources: [], usage: { aiRequests: 1, inputTokens: 0, outputTokens: 0, searchRequests: 0 } };
    });
    const store = { claimPreparation: vi.fn(async () => jobs.shift() ?? null), transition: vi.fn(async () => true),
      completePreparation: vi.fn(), failPreparation: vi.fn() };
    const worker = new PreparationWorker(store as never, { prepare }, vi.fn() as never, 2,
      () => new Promise((resolve) => setTimeout(resolve, 1)));
    worker.start();
    try {
      await vi.waitFor(() => expect(prepare).toHaveBeenCalledTimes(2));
      expect(jobs).toHaveLength(1);
      releases[0]!();
      await vi.waitFor(() => expect(prepare).toHaveBeenCalledTimes(3));
      expect(store.failPreparation).toHaveBeenCalledOnce();
      expect(peak).toBe(2);
    } finally {
      const stopping = worker.stop();
      releases.forEach((release) => release());
      await stopping;
    }
    expect(store.completePreparation).toHaveBeenCalledTimes(2);
  });

  it("keeps processing after a transient job-claim failure", async () => {
    let claims = 0;
    const store = {
      claimPreparation: vi.fn(async () => {
        claims += 1;
        if (claims === 1) throw new Error("database temporarily unavailable");
        return null;
      })
    };
    const onIterationError = vi.fn();
    const worker = new PreparationWorker(store as never, { prepare: vi.fn() }, vi.fn() as never, 1, async () => undefined, onIterationError);

    worker.start();
    for (let turn = 0; turn < 20 && claims < 2; turn += 1) await Promise.resolve();
    await worker.stop();

    expect(claims).toBeGreaterThanOrEqual(2);
    expect(onIterationError).toHaveBeenCalledWith(expect.any(Error));
  });

  it("prepares manual reports without calling AI and skips AI-only states", async () => {
    const prepare = vi.fn();
    const transition = vi.fn();
    const completePreparation = vi.fn();
    const identity = vi.fn(() => ({ legalName: "Generated Name", email: "alias@example.test", locale: "de-DE", timezone: "Europe/Berlin", language: "de", proxySessionId: "session" }));
    const store = {
      claimPreparation: vi.fn(async () => ({
        jobId: "job-1",
        report: {
          ...baseReport,
          flow: "message" as const,
          use_ai: false,
          request_input: {
            flow: "message" as const,
            useAi: false as const,
            country: "DE",
            category: "sub_other_hate_speech",
            description: "Manual evidence summary.",
            finalText: "Manual report text.",
            target: { messageUrl: "https://discord.com/channels/@me/123456789012345678/123456789012345679" }
          }
        }
      })),
      transition,
      completePreparation,
      failPreparation: vi.fn()
    };
    const worker = new PreparationWorker(store as never, { prepare }, identity);

    await worker.processOne();

    expect(prepare).not.toHaveBeenCalled();
    expect(transition).not.toHaveBeenCalled();
    expect(identity).toHaveBeenCalledWith("DE");
    expect(completePreparation).toHaveBeenCalledWith(
      "job-1",
      "report-1",
      expect.objectContaining({ finalText: "Manual report text." }),
      expect.objectContaining({ legalName: "Generated Name" }),
      expect.objectContaining({ aiRequests: 0, searchRequests: 0 })
    );
  });

  it("preserves supplied hints and creates identity only after AI resolves country", async () => {
    const calls: string[] = [];
    const prepare = vi.fn(async (_input, progress: (stage: "researching" | "writing") => Promise<void>) => {
      calls.push("prepare");
      await progress("researching");
      await progress("writing");
      return {
        country: "FR",
        category: "ai-category",
        description: "AI description",
        finalText: "Generated report.",
        legalReference: "French law",
        researchSummary: "Summary",
        sources: [],
        usage: { aiRequests: 2, inputTokens: 10, outputTokens: 5, searchRequests: 1 }
      };
    });
    const store = {
      claimPreparation: vi.fn(async () => ({
        jobId: "job-1",
        report: {
          ...baseReport,
          flow: "server" as const,
          use_ai: true,
          request_input: {
            flow: "server" as const,
            useAi: true as const,
            category: "supplied-category",
            description: "Supplied description",
            target: { guildIdOrInviteCode: "invite", guildElements: ["name" as const] }
          }
        }
      })),
      transition: vi.fn(async (_id, status: string) => { calls.push(status); return true; }),
      completePreparation: vi.fn(async (_job, _report, prepared) => { calls.push(`complete:${prepared.country}`); }),
      failPreparation: vi.fn()
    };
    const identity = vi.fn((country: string) => {
      calls.push(`identity:${country}`);
      return { legalName: "Name", email: "alias@example.test", locale: "fr-FR", timezone: "Europe/Paris", language: "fr", proxySessionId: "session" };
    });
    const worker = new PreparationWorker(store as never, { prepare }, identity);

    await worker.processOne();

    expect(calls).toEqual(["planning", "prepare", "researching", "writing", "identity:FR", "complete:FR"]);
    expect(store.completePreparation.mock.calls[0]?.[2]).toMatchObject({
      category: "supplied-category",
      description: "Supplied description"
    });
  });

  it("reuses a predecessor's immutable prepared payload without calling AI", async () => {
    const prepare = vi.fn();
    const store = {
      claimPreparation: vi.fn(async () => ({
        jobId: "job-2",
        report: {
          ...baseReport,
          id: "report-2",
          flow: "message" as const,
          use_ai: true,
          retry_mode: "reuse" as const,
          request_input: {
            flow: "message" as const,
            useAi: true as const,
            target: { messageUrl: "https://discord.com/channels/@me/123456789012345678/123456789012345679" }
          },
          prepared_input: { country: "DE", category: "illegal", description: "Evidence", finalText: "Prepared report" },
          legal_reference: "DSA",
          research_summary: "Prior research",
          research_sources: [{ title: "EUR-Lex", url: "https://eur-lex.europa.eu/" }]
        }
      })),
      transition: vi.fn(async () => true),
      completePreparation: vi.fn(),
      failPreparation: vi.fn()
    };
    const identity = vi.fn(() => ({ legalName: "Fresh Name", email: "fresh@example.test", locale: "de-DE", timezone: "Europe/Berlin", language: "de", proxySessionId: "fresh-session" }));
    const worker = new PreparationWorker(store as never, { prepare }, identity);

    await worker.processOne();

    expect(prepare).not.toHaveBeenCalled();
    expect(store.transition).not.toHaveBeenCalled();
    expect(identity).toHaveBeenCalledWith("DE");
    expect(store.completePreparation.mock.calls[0]?.[2]).toMatchObject({ finalText: "Prepared report", legalReference: "DSA" });
  });

  it("persists a safe specific reason when the AI provider remains rate limited", async () => {
    const rateLimitError = Object.assign(new Error("sensitive upstream detail"), { kind: "rate_limited" });
    const store = {
      claimPreparation: vi.fn(async () => ({
        jobId: "job-3",
        report: {
          ...baseReport,
          flow: "message" as const,
          use_ai: true,
          request_input: { flow: "message" as const, useAi: true as const, target: { messageUrl: "https://discord.com/channels/@me/123456789012345678/123456789012345679" } }
        }
      })),
      transition: vi.fn(async () => true),
      completePreparation: vi.fn(),
      failPreparation: vi.fn()
    };
    const worker = new PreparationWorker(store as never, { prepare: vi.fn(async () => { throw rateLimitError; }) }, vi.fn() as never);

    await worker.processOne();

    expect(store.failPreparation).toHaveBeenCalledWith(
      "job-3",
      "report-1",
      "preparation_rate_limited",
      "A preparation provider is rate limited. Retry the report shortly."
    );
  });

  it("emits a correlated diagnostic for an otherwise unexpected preparation failure", async () => {
    const unexpected = new Error("provider returned secret-token-123 for https://example.test/private/report");
    const store = {
      claimPreparation: vi.fn(async () => ({
        jobId: "job-4",
        report: {
          ...baseReport,
          flow: "message" as const,
          use_ai: true,
          request_input: { flow: "message" as const, useAi: true as const, target: { messageUrl: "https://discord.com/channels/@me/123456789012345678/123456789012345679" } }
        }
      })), transition: vi.fn(async () => true), completePreparation: vi.fn(), failPreparation: vi.fn()
    };
    const iterationErrors: unknown[] = [];
    const onIterationError = (error: unknown) => iterationErrors.push(error);
    const worker = new PreparationWorker(store as never, { prepare: vi.fn(async () => { throw unexpected; }) }, vi.fn() as never, 1, undefined, onIterationError);

    await worker.processOne();

    expect(iterationErrors).toHaveLength(1);
    const diagnostic = iterationErrors[0] as { originalName?: unknown; stackFingerprint?: unknown };
    expect(diagnostic).toMatchObject({ originalName: "Error" });
    expect(typeof diagnostic.stackFingerprint).toBe("string");
  });
});
