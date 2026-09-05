/* eslint-disable @typescript-eslint/require-await, @typescript-eslint/no-unsafe-call */
import { describe, expect, it, vi } from "vitest";

import { ApiReportPreparer } from "../src/preparation/api-report-preparer.js";

describe("ApiReportPreparer", () => {
  it("maps the public target to the internal writer and returns only final durable output", async () => {
    const generate = vi.fn(async (_draft, _actor, progress) => {
      await progress?.({ stage: "research" });
      await progress?.({ stage: "write" });
      return {
        conversation: [{ role: "assistant", content: "must not persist" }],
        country: "DE",
        reportType: "sub_other_hate_speech",
        reportReason: "Evidence summary",
        report: "Final report text.",
        legalResearch: {
          country: "DE",
          lawReference: "German Basic Law",
          summary: "Compact research",
          sources: [{ title: "Official source", url: "https://eur-lex.europa.eu/example" }],
          researchedAt: new Date().toISOString(),
          searchRequests: 1
        }
      };
    });
    const preparer = new ApiReportPreparer({
      writerFactory: (recordUsage) => ({
        generate: async (...args: Parameters<typeof generate>) => {
          await recordUsage("operation", {
            costCredits: 0,
            inputTokens: 10,
            outputTokens: 5,
            reasoningTokens: 2,
            searchRequests: 0
          });
          return generate(...args);
        }
      }) as never
    });
    const stages: string[] = [];

    const result = await preparer.prepare(
      {
        flow: "message",
        useAi: true,
        target: {
          messageUrl: "https://discord.com/channels/@me/123456789012345678/123456789012345679"
        }
      },
      async (stage) => { stages.push(stage); },
      new AbortController().signal
    );

    expect(generate.mock.calls[0]?.[0]).toMatchObject({ flow: "message_urf" });
    expect(stages).toEqual(["researching", "writing"]);
    expect(result).toMatchObject({
      country: "DE",
      category: "sub_other_hate_speech",
      description: "Evidence summary",
      finalText: "Final report text.",
      usage: { aiRequests: 1, inputTokens: 10, outputTokens: 5, searchRequests: 1 }
    });
    expect(result).not.toHaveProperty("conversation");
  });
});
