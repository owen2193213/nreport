import { describe, expect, it, vi } from "vitest";

import type { AiRequestContext } from "../src/report-writer.js";
import { ReportWriter, ReportWriterError } from "../src/report-writer.js";
import type { AiUsage, ReportDraft } from "../src/types.js";

const COUNTRIES = ["AT", "DE", "FR"] as const;
const ACTOR: AiRequestContext = { actorKey: "actor-key", userId: "reporter-id" };
const LAW = "Germany's Basic Law (Grundgesetz), Article 1";

function draft(): ReportDraft {
  return {
    flow: "user_urf",
    country: "DE",
    countrySelection: "override",
    reportType: "sub_other_hate_speech",
    reportBrief: "The profile imagery contains hateful material.",
    reportedUsername: "example",
    reportedUserId: "123456789012345678",
    reportedUserSnapshot: {
      userId: "123456789012345678",
      username: "example",
      globalDisplayName: "Example Display",
      avatarUrl: "https://cdn.discordapp.com/avatar.png",
      bannerUrl: "https://cdn.discordapp.com/banner.png",
      bot: false,
      resolvedAt: "2026-08-09T00:00:00.000Z"
    },
    profileElements: ["photos"]
  };
}

function plan(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    country: "DE",
    reportType: "sub_other_hate_speech",
    reportReason: "The profile imagery contains hateful material.",
    termResearchRequired: false,
    termSearchQuery: null,
    lawResearchRequired: false,
    lawSearchQuery: null,
    provisionalLawReference: LAW,
    ...overrides
  };
}

function completed(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    status: "completed",
    followUpType: null,
    followUpQuery: null,
    country: "DE",
    reportType: "sub_other_hate_speech",
    reportReason: "The profile imagery contains hateful material.",
    lawReference: LAW,
    researchSummary: "Article 1 protects human dignity; applicability requires review.",
    report: `The profile imagery may contain hateful material affecting dignity under ${LAW}.`,
    ...overrides
  };
}

function moreResearch(kind: "term" | "law", query: string): Record<string, unknown> {
  return {
    status: "more_research_required",
    followUpType: kind,
    followUpQuery: query,
    country: null,
    reportType: null,
    reportReason: null,
    lawReference: null,
    researchSummary: null,
    report: null
  };
}

function groq(value: Record<string, unknown>, usage: Partial<AiUsage> = {}): Response {
  return new Response(
    JSON.stringify({
      choices: [
        {
          finish_reason: "stop",
          message: { role: "assistant", content: JSON.stringify(value), refusal: null }
        }
      ],
      usage: {
        prompt_tokens: usage.inputTokens ?? 100,
        completion_tokens: usage.outputTokens ?? 40,
        completion_tokens_details: { reasoning_tokens: usage.reasoningTokens ?? 10 }
      }
    }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}

function braveTerm(): Response {
  return new Response(
    JSON.stringify({
      web: {
        results: [
          {
            title: "Term definition",
            url: "https://dictionary.example/coded-term",
            description: "The coded term is used as hateful language."
          }
        ]
      }
    }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}

function braveLaw(): Response {
  return new Response(
    JSON.stringify({
      grounding: {
        generic: [
          {
            title: "Basic Law Article 1",
            url: "https://www.gesetze-im-internet.de/gg/art_1.html",
            snippets: ["Human dignity shall be inviolable."]
          }
        ]
      },
      sources: {
        "https://www.gesetze-im-internet.de/gg/art_1.html": {
          title: "Basic Law Article 1",
          hostname: "www.gesetze-im-internet.de",
          age: []
        }
      }
    }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}

function writer(
  request: ReturnType<typeof vi.fn>,
  recordUsage: ReturnType<typeof vi.fn> = vi.fn().mockResolvedValue(undefined)
): ReportWriter {
  return new ReportWriter(
    "groq-secret",
    "openai/gpt-oss-120b",
    "brave-secret",
    COUNTRIES,
    {
      request: request as unknown as typeof fetch,
      recordUsage: recordUsage as (userId: string, usage: AiUsage) => Promise<void>
    }
  );
}

function urlAt(request: ReturnType<typeof vi.fn>, index: number): string {
  return String(request.mock.calls[index]?.[0]);
}

function bodyAt<T>(request: ReturnType<typeof vi.fn>, index: number): T {
  const body = (request.mock.calls[index]?.[1] as RequestInit | undefined)?.body;
  if (typeof body !== "string") throw new Error("Expected JSON request body.");
  return JSON.parse(body) as T;
}

describe("Groq and Brave report writer", () => {
  it("skips Brave when the strict planner requires no research", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(groq(plan()))
      .mockResolvedValueOnce(groq(completed()));
    const recordUsage = vi.fn().mockResolvedValue(undefined);

    const result = await writer(request, recordUsage).generate(draft(), ACTOR);

    expect(result.country).toBe("DE");
    expect(result.legalResearch.searchRequests).toBe(0);
    expect(result.legalResearch.sources).toEqual([]);
    expect(result.report.length).toBeLessThanOrEqual(512);
    expect(request).toHaveBeenCalledTimes(2);
    expect(urlAt(request, 0)).toBe("https://api.groq.com/openai/v1/chat/completions");
    expect(urlAt(request, 1)).toBe("https://api.groq.com/openai/v1/chat/completions");
    expect(recordUsage).toHaveBeenCalledTimes(2);

    const planning = bodyAt<{
      plugins?: unknown;
      tools?: unknown;
      provider?: unknown;
      response_format: {
        json_schema: { strict: boolean; schema: { properties: object; required: string[] } };
      };
    }>(request, 0);
    expect(planning.plugins).toBeUndefined();
    expect(planning.tools).toBeUndefined();
    expect(planning.provider).toBeUndefined();
    expect(planning.response_format.json_schema.strict).toBe(true);
    expect(planning.response_format.json_schema.schema.required.sort()).toEqual(
      Object.keys(planning.response_format.json_schema.schema.properties).sort()
    );
  });

  it("performs only terminology research when requested", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(
        groq(
          plan({
            termResearchRequired: true,
            termSearchQuery: "coded term meaning hateful language"
          })
        )
      )
      .mockResolvedValueOnce(braveTerm())
      .mockResolvedValueOnce(groq(completed()));

    const result = await writer(request).generate(draft(), ACTOR);

    expect(urlAt(request, 1)).toContain("/res/v1/web/search");
    expect(request.mock.calls.some((call) => String(call[0]).includes("/llm/context"))).toBe(
      false
    );
    expect(result.legalResearch.searchRequests).toBe(1);
    expect(result.legalResearch.sources[0]?.url).toBe(
      "https://dictionary.example/coded-term"
    );
  });

  it("performs only law research when requested", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(
        groq(
          plan({
            lawResearchRequired: true,
            lawSearchQuery: "Germany official Basic Law Article 1",
            provisionalLawReference: null
          })
        )
      )
      .mockResolvedValueOnce(braveLaw())
      .mockResolvedValueOnce(groq(completed()));

    const result = await writer(request).generate(draft(), ACTOR);

    expect(urlAt(request, 1)).toBe("https://api.search.brave.com/res/v1/llm/context");
    expect(result.legalResearch.sources[0]?.title).toBe("Basic Law Article 1");
  });

  it("starts terminology and law searches concurrently", async () => {
    let resolveTerm!: (response: Response) => void;
    let resolveLaw!: (response: Response) => void;
    const termPending = new Promise<Response>((resolve) => {
      resolveTerm = resolve;
    });
    const lawPending = new Promise<Response>((resolve) => {
      resolveLaw = resolve;
    });
    const request = vi.fn(async (url: string) => {
      if (url.includes("api.groq.com") && request.mock.calls.length === 1) {
        return groq(
          plan({
            termResearchRequired: true,
            termSearchQuery: "coded term meaning hateful language",
            lawResearchRequired: true,
            lawSearchQuery: "Germany official Basic Law Article 1",
            provisionalLawReference: null
          })
        );
      }
      if (url.includes("/web/search")) return termPending;
      if (url.includes("/llm/context")) return lawPending;
      return groq(completed());
    });

    const generation = writer(request).generate(draft(), ACTOR);
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(3));
    resolveTerm(braveTerm());
    resolveLaw(braveLaw());
    const result = await generation;

    expect(result.legalResearch.searchRequests).toBe(2);
    expect(result.legalResearch.sources).toHaveLength(2);
  });

  it("rejects inconsistent plans and changes to fixed fields before searching", async () => {
    const inconsistent = vi.fn().mockResolvedValue(
      groq(plan({ termResearchRequired: true, termSearchQuery: null }))
    );
    await expect(writer(inconsistent).generate(draft(), ACTOR)).rejects.toThrow(
      /terminology research query/
    );
    expect(inconsistent).toHaveBeenCalledTimes(1);

    const changed = vi.fn().mockResolvedValue(groq(plan({ country: "AT" })));
    await expect(writer(changed).generate(draft(), ACTOR)).rejects.toThrow(
      /fixed country/
    );
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it("resolves Auto country, category, and explanation", async () => {
    const auto = draft();
    delete auto.country;
    delete auto.reportType;
    delete auto.reportBrief;
    auto.countrySelection = "auto";
    const request = vi
      .fn()
      .mockResolvedValueOnce(
        groq(
          plan({
            country: "AT",
            reportType: "sub_other_threats",
            reportReason: "The profile contains a threatening statement.",
            provisionalLawReference:
              "Austria's Criminal Code (Strafgesetzbuch), Section 107"
          })
        )
      )
      .mockResolvedValueOnce(
        groq(
          completed({
            country: "AT",
            reportType: "sub_other_threats",
            reportReason: "The profile contains a threatening statement.",
            lawReference: "Austria's Criminal Code (Strafgesetzbuch), Section 107"
          })
        )
      );

    const result = await writer(request).generate(auto, ACTOR);
    expect(result).toMatchObject({
      country: "AT",
      reportType: "sub_other_threats",
      reportReason: "The profile contains a threatening statement."
    });
  });

  it("performs one targeted follow-up and rejects a second request", async () => {
    const successRequest = vi
      .fn()
      .mockResolvedValueOnce(groq(plan()))
      .mockResolvedValueOnce(
        groq(moreResearch("law", "Germany official Basic Law Article 1 text"))
      )
      .mockResolvedValueOnce(braveLaw())
      .mockResolvedValueOnce(groq(completed()));
    const result = await writer(successRequest).generate(draft(), ACTOR);
    expect(result.legalResearch.searchRequests).toBe(1);
    expect(successRequest).toHaveBeenCalledTimes(4);

    const repeated = vi
      .fn()
      .mockResolvedValueOnce(groq(plan()))
      .mockResolvedValueOnce(
        groq(moreResearch("law", "Germany official Basic Law Article 1 text"))
      )
      .mockResolvedValueOnce(braveLaw())
      .mockResolvedValueOnce(
        groq(moreResearch("law", "Germany official Basic Law Article 1 current text"))
      );
    await expect(writer(repeated).generate(draft(), ACTOR)).rejects.toThrow(
      /allowed follow-up/
    );
  });

  it("rejects an invalid completed report independently of strict JSON", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(groq(plan()))
      .mockResolvedValueOnce(groq(completed({ report: "x".repeat(513) })));

    await expect(writer(request).generate(draft(), ACTOR)).rejects.toThrow(
      /exceeded 512 characters/
    );
  });

  it("maps a Groq refusal to a specific safe error", async () => {
    const request = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [
            { finish_reason: "stop", message: { content: null, refusal: "Declined" } }
          ]
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );

    await expect(writer(request).generate(draft(), ACTOR)).rejects.toThrow(
      /declined to process this evidence/
    );
  });

  it("does not send disabled media URLs to either provider", async () => {
    const messageDraft: ReportDraft = {
      ...draft(),
      flow: "message_urf",
      messageUrl: "https://discord.com/channels/1/2/3",
      messageSnapshot: {
        messageId: "333333333333333333",
        channelId: "222222222222222222",
        channelName: "channel",
        serverId: "111111111111111111",
        serverName: "server",
        authorId: "123456789012345678",
        authorUsername: "example",
        authorDisplayName: null,
        authorBot: false,
        content: "coded term",
        createdAt: "2026-08-09T00:00:00.000Z",
        attachments: [
          {
            name: "evidence.png",
            url: "https://cdn.discordapp.com/private-evidence.png",
            contentType: "image/png"
          }
        ],
        embeds: []
      }
    };
    const request = vi
      .fn()
      .mockResolvedValueOnce(groq(plan()))
      .mockResolvedValueOnce(groq(completed()));

    await writer(request).generate(messageDraft, ACTOR);
    const serialized = request.mock.calls
      .map((call) => {
        const body = (call[1] as RequestInit | undefined)?.body;
        return typeof body === "string" ? body : "";
      })
      .join("\n");
    expect(serialized).toContain("evidence.png");
    expect(serialized).not.toContain("private-evidence.png");
  });

  it("refines through Groq without searching or changing research", async () => {
    const reportDraft = draft();
    reportDraft.legalResearch = {
      country: "DE",
      lawReference: LAW,
      summary: "Article 1 protects human dignity.",
      sources: [],
      researchedAt: "2026-08-09T00:00:00.000Z",
      searchRequests: 0
    };
    reportDraft.reportReason = "The profile imagery contains hateful material.";
    reportDraft.writerConversation = [
      { role: "user", content: `Country: DE\nLaw reference: ${LAW}` },
      { role: "assistant", content: JSON.stringify({ report: "Original report." }) }
    ];
    const request = vi.fn().mockResolvedValue(
      groq({ report: `Refined report under ${LAW}.` })
    );

    const result = await writer(request).refine(reportDraft, "Make it clearer", ACTOR);

    expect(result.report).toContain("Refined report");
    expect(result.legalResearch).toEqual(reportDraft.legalResearch);
    expect(request).toHaveBeenCalledTimes(1);
    expect(urlAt(request, 0)).toBe("https://api.groq.com/openai/v1/chat/completions");
  });

  it("retains a candidate report when synthesis validation fails", async () => {
    const candidate = "x".repeat(513);
    const request = vi
      .fn()
      .mockResolvedValueOnce(groq(plan()))
      .mockResolvedValueOnce(groq(completed({ report: candidate })));

    const failure = await writer(request)
      .generate(draft(), ACTOR)
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ReportWriterError);
    expect((failure as ReportWriterError).candidateReport).toBe(candidate);
  });
});
