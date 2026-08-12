import { describe, expect, it, vi } from "vitest";

import { braveSearchCountry } from "../src/brave-research.js";
import type { AiRequestContext } from "../src/report-writer.js";
import { ReportWriter, ReportWriterError } from "../src/report-writer.js";
import type { AiUsage, ReportDraft } from "../src/types.js";

const COUNTRIES = ["AT", "DE", "FR", "IE"] as const;
const ACTOR: AiRequestContext = { actorKey: "actor-key", userId: "reporter-id" };
const LAW = "Germany's Basic Law (Grundgesetz), Article 1";
const BRAVE_UNSUPPORTED_REPORT_COUNTRIES = [
  "BG",
  "HR",
  "CY",
  "CZ",
  "HU",
  "IE",
  "LV",
  "LT",
  "LU",
  "MT",
  "RO",
  "SK",
  "SI"
] as const;

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
    lawReference: LAW,
    researchSummary: "Article 1 protects human dignity; applicability requires review.",
    report: `The profile imagery may contain hateful material affecting dignity under ${LAW}.`,
    ...overrides
  };
}

function moreResearch(
  kind: "term" | "law",
  query: string,
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    status: "more_research_required",
    followUpType: kind,
    followUpQuery: query,
    lawReference: null,
    researchSummary: null,
    report: null,
    ...overrides
  };
}

function fireworks(value: Record<string, unknown>, usage: Partial<AiUsage> = {}): Response {
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
    "fireworks-secret",
    "accounts/fireworks/models/deepseek-v4-flash",
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

describe("braveSearchCountry", () => {
  it("uses ALL for every report country unsupported by Brave", () => {
    expect(braveSearchCountry("DE")).toBe("DE");
    for (const country of BRAVE_UNSUPPORTED_REPORT_COUNTRIES) {
      expect(braveSearchCountry(country)).toBe("ALL");
    }
  });
});

function bodyAt<T>(request: ReturnType<typeof vi.fn>, index: number): T {
  const body = (request.mock.calls[index]?.[1] as RequestInit | undefined)?.body;
  if (typeof body !== "string") throw new Error("Expected JSON request body.");
  return JSON.parse(body) as T;
}

function embeddedSchema(message: string): { properties: Record<string, unknown> } {
  const marker = "Return raw JSON only, matching this JSON Schema exactly:\n";
  const index = message.lastIndexOf(marker);
  if (index < 0) throw new Error("Expected an embedded JSON Schema.");
  const schemaLine = message.slice(index + marker.length).split("\n")[0]!;
  return JSON.parse(schemaLine) as {
    properties: Record<string, unknown>;
  };
}

describe("Fireworks and Brave report writer", () => {
  it("skips Brave when the strict planner requires no research", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(fireworks(plan()))
      .mockResolvedValueOnce(fireworks(completed()));
    const recordUsage = vi.fn().mockResolvedValue(undefined);

    const result = await writer(request, recordUsage).generate(draft(), ACTOR);

    expect(result.country).toBe("DE");
    expect(result.legalResearch.searchRequests).toBe(0);
    expect(result.legalResearch.sources).toEqual([]);
    expect(result.report.length).toBeLessThanOrEqual(512);
    expect(request).toHaveBeenCalledTimes(2);
    expect(urlAt(request, 0)).toBe(
      "https://api.fireworks.ai/inference/v1/chat/completions"
    );
    expect(urlAt(request, 1)).toBe(
      "https://api.fireworks.ai/inference/v1/chat/completions"
    );
    expect(recordUsage).toHaveBeenCalledTimes(2);

    const planning = bodyAt<{
      plugins?: unknown;
      tools?: unknown;
      provider?: unknown;
      max_completion_tokens: number;
      messages: Array<{ content: string }>;
      reasoning_effort: string;
      response_format?: unknown;
    }>(request, 0);
    expect(planning.plugins).toBeUndefined();
    expect(planning.tools).toBeUndefined();
    expect(planning.provider).toBeUndefined();
    expect(planning.reasoning_effort).toBe("high");
    expect(planning.max_completion_tokens).toBe(8_192);
    expect(planning.response_format).toBeUndefined();
    expect(JSON.stringify(planning.messages)).toContain("provisionalLawReference");
    expect(JSON.stringify(planning.messages)).not.toContain("without Markdown or a code fence");
    expect(planning.messages[1]!.content).toContain("## Task");
    expect(planning.messages[1]!.content).toContain("## Rules");
    expect(planning.messages[1]!.content).toContain("## Input");
    expect(planning.messages[1]!.content).toContain("## Output");
    expect(planning.messages[1]!.content).toContain("## Examples");
    expect(planning.messages[1]!.content).not.toContain("hedging");
    expect(planning.messages[1]!.content).toContain("generic, standalone searches");
    expect(planning.messages[1]!.content).toContain("Germany laws on online threats");
    expect(planning.messages[1]!.content).toContain(
      "what does [slang] mean in online context"
    );
    const planningSchema = embeddedSchema(planning.messages[1]!.content);
    expect(planningSchema.properties).not.toHaveProperty("country");
    expect(planningSchema.properties).not.toHaveProperty("reportType");
    expect(planningSchema.properties).not.toHaveProperty("reportReason");

    const synthesis = bodyAt<{
      max_completion_tokens: number;
      messages: Array<{ content: string }>;
      reasoning_effort: string;
      response_format: {
        type: string;
        json_schema: { schema: object; strict?: unknown };
      };
    }>(request, 1);
    expect(synthesis.reasoning_effort).toBe("none");
    expect(synthesis.max_completion_tokens).toBe(4_096);
    expect(synthesis.response_format.type).toBe("json_schema");
    expect(synthesis.response_format.json_schema.strict).toBeUndefined();
    expect(JSON.stringify(synthesis.messages)).toContain(
      "Do not count characters step by step or spend time optimizing the exact character count."
    );
    expect(JSON.stringify(synthesis.messages)).toContain(
      "When the message's meaning is obvious, do not elaborate on it."
    );
    expect(synthesis.messages[1]!.content).toContain("# FUCK YOUUUU");
    expect(synthesis.messages[1]!.content).toContain(
      "Section 185 prohibits insulting another person."
    );
    expect(synthesis.messages[1]!.content).toContain("coded wording");
    expect(synthesis.messages[1]!.content).toContain("## Task");
    expect(synthesis.messages[1]!.content).toContain("## Input");
    expect(synthesis.messages[1]!.content).toContain("## Research");
    expect(synthesis.messages[1]!.content).toContain("## Writing");
    expect(synthesis.messages[1]!.content).toContain("## Output");
    expect(synthesis.messages[1]!.content).toContain("## Examples");
    expect(synthesis.messages[1]!.content).toContain(
      "briefly explain what the wording means, then connect that meaning to the law"
    );
  });

  it("keeps resolved fields out of the synthesis output contract", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(fireworks(plan()))
      .mockResolvedValueOnce(
        fireworks({
          status: "completed",
          followUpType: null,
          followUpQuery: null,
          lawReference: LAW,
          researchSummary: "Article 1 protects human dignity; applicability requires review.",
          report: `The profile imagery may contain hateful material affecting dignity under ${LAW}.`
        })
      );

    const result = await writer(request).generate(draft(), ACTOR);
    const synthesis = bodyAt<{
      response_format: { json_schema: { schema: { properties: Record<string, unknown> } } };
    }>(request, 1);

    expect(synthesis.response_format.json_schema.schema.properties).not.toHaveProperty(
      "country"
    );
    expect(synthesis.response_format.json_schema.schema.properties).not.toHaveProperty(
      "reportType"
    );
    expect(synthesis.response_format.json_schema.schema.properties).not.toHaveProperty(
      "reportReason"
    );
    expect(result).toMatchObject({
      country: "DE",
      reportType: "sub_other_hate_speech",
      reportReason: "The profile imagery contains hateful material."
    });
  });

  it("performs only terminology research when requested", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(
        fireworks(
          plan({
            termResearchRequired: true,
            termSearchQuery: "coded term meaning hateful language"
          })
        )
      )
      .mockResolvedValueOnce(braveTerm())
      .mockResolvedValueOnce(fireworks(completed()));

    const result = await writer(request).generate(draft(), ACTOR);

    expect(urlAt(request, 1)).toContain("/res/v1/web/search");
    expect(request.mock.calls.some((call) => String(call[0]).includes("/llm/context"))).toBe(
      false
    );
    expect(result.legalResearch.searchRequests).toBe(1);
    expect(result.legalResearch.sources[0]?.url).toBe(
      "https://dictionary.example/coded-term"
    );
    const synthesis = bodyAt<{
      max_completion_tokens: number;
      messages: Array<{ content: string }>;
      reasoning_effort: string;
      response_format?: unknown;
    }>(request, 2);
    expect(synthesis.reasoning_effort).toBe("high");
    expect(synthesis.max_completion_tokens).toBe(12_288);
    expect(synthesis.response_format).toBeUndefined();
    expect(JSON.stringify(synthesis.messages)).toContain("researchSummary");
    const synthesisSchema = embeddedSchema(synthesis.messages[1]!.content);
    expect(synthesisSchema.properties).not.toHaveProperty("country");
    expect(synthesisSchema.properties).not.toHaveProperty("reportType");
    expect(synthesisSchema.properties).not.toHaveProperty("reportReason");
  });

  it("performs only law research when requested", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(
        fireworks(
          plan({
            lawResearchRequired: true,
            lawSearchQuery: "Germany official Basic Law Article 1"
          })
        )
      )
      .mockResolvedValueOnce(braveLaw())
      .mockResolvedValueOnce(fireworks(completed()));

    const result = await writer(request).generate(draft(), ACTOR);

    expect(urlAt(request, 1)).toBe("https://api.search.brave.com/res/v1/llm/context");
    expect(result.legalResearch.sources[0]?.title).toBe("Basic Law Article 1");
  });

  it("uses ALL as Brave's legal-search target for Ireland", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(
        fireworks(
          plan({
            lawResearchRequired: true,
            lawSearchQuery: "Ireland official laws on online threats"
          })
        )
      )
      .mockResolvedValueOnce(braveLaw())
      .mockResolvedValueOnce(fireworks(completed()));

    await writer(request).generate({ ...draft(), country: "IE" }, ACTOR);

    expect(bodyAt<Record<string, unknown>>(request, 1).country).toBe("ALL");
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
      if (url.includes("api.fireworks.ai") && request.mock.calls.length === 1) {
        return fireworks(
          plan({
            termResearchRequired: true,
            termSearchQuery: "coded term meaning hateful language",
            lawResearchRequired: true,
            lawSearchQuery: "Germany official Basic Law Article 1"
          })
        );
      }
      if (url.includes("/web/search")) return termPending;
      if (url.includes("/llm/context")) return lawPending;
      return fireworks(completed());
    });

    const generation = writer(request).generate(draft(), ACTOR);
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(3));
    resolveTerm(braveTerm());
    resolveLaw(braveLaw());
    const result = await generation;

    expect(result.legalResearch.searchRequests).toBe(2);
    expect(result.legalResearch.sources).toHaveLength(2);
  });

  it("rejects inconsistent plans after one repair attempt", async () => {
    const inconsistent = vi.fn().mockImplementation(() =>
      Promise.resolve(fireworks(plan({ termResearchRequired: true, termSearchQuery: null })))
    );
    await expect(writer(inconsistent).generate(draft(), ACTOR)).rejects.toThrow(
      /terminology research query/
    );
    expect(inconsistent).toHaveBeenCalledTimes(2);
    const repair = bodyAt<{
      reasoning_effort: string;
      max_completion_tokens: number;
      response_format?: unknown;
    }>(inconsistent, 1);
    expect(repair).toMatchObject({
      reasoning_effort: "none",
      max_completion_tokens: 4_096
    });
    expect(repair.response_format).toBeDefined();
  });

  it("does not let unavailable planner fields override fixed application state", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(
        fireworks(
          plan({
            country: "AT",
            reportType: "sub_other_threats",
            reportReason: "A different explanation."
          })
        )
      )
      .mockResolvedValueOnce(fireworks(completed()));

    const result = await writer(request).generate(draft(), ACTOR);

    expect(result).toMatchObject({
      country: "DE",
      reportType: "sub_other_hate_speech",
      reportReason: "The profile imagery contains hateful material."
    });
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
        fireworks(
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
        fireworks(
          completed({
            lawReference: "Austria's Criminal Code (Strafgesetzbuch), Section 107"
          })
        )
      );

    const result = await writer(request).generate(auto, ACTOR);
    const planning = bodyAt<{ messages: Array<{ content: string }> }>(request, 0);
    const planningSchema = embeddedSchema(planning.messages[1]!.content);
    expect(planningSchema.properties).toHaveProperty("country");
    expect(planningSchema.properties).toHaveProperty("reportType");
    expect(planningSchema.properties).toHaveProperty("reportReason");
    expect(result).toMatchObject({
      country: "AT",
      reportType: "sub_other_threats",
      reportReason: "The profile contains a threatening statement."
    });
  });

  it("performs one targeted follow-up and rejects a second request", async () => {
    const successRequest = vi
      .fn()
      .mockResolvedValueOnce(fireworks(plan()))
      .mockResolvedValueOnce(
        fireworks(moreResearch("law", "Germany official Basic Law Article 1 text"))
      )
      .mockResolvedValueOnce(braveLaw())
      .mockResolvedValueOnce(fireworks(completed()));
    const result = await writer(successRequest).generate(draft(), ACTOR);
    expect(result.legalResearch.searchRequests).toBe(1);
    expect(successRequest).toHaveBeenCalledTimes(4);

    const firstSynthesis = bodyAt<{ messages: Array<{ content: string }> }>(successRequest, 1);
    expect(firstSynthesis.messages[1]!.content).toContain(
      "this is your only research opportunity and you cannot request more research after it"
    );
    expect(firstSynthesis.messages[1]!.content).not.toContain(
      "Do not request more research"
    );
    const finalSynthesis = bodyAt<{ messages: Array<{ content: string }> }>(successRequest, 3);
    expect(finalSynthesis.messages[1]!.content).toContain(
      "You have already used the allowed follow-up search. Do not request more research."
    );

    const repeated = vi
      .fn()
      .mockResolvedValueOnce(fireworks(plan()))
      .mockResolvedValueOnce(
        fireworks(moreResearch("law", "Germany official Basic Law Article 1 text"))
      )
      .mockResolvedValueOnce(braveLaw())
      .mockResolvedValueOnce(
        fireworks(moreResearch("law", "Germany official Basic Law Article 1 current text"))
      );
    await expect(writer(repeated).generate(draft(), ACTOR)).rejects.toThrow(
      /allowed follow-up/
    );
  });

  it("repairs an oversized completed report once with reasoning disabled", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(fireworks(plan()))
      .mockResolvedValueOnce(fireworks(completed({ report: "x".repeat(513) })))
      .mockResolvedValueOnce(fireworks(completed()));

    const result = await writer(request).generate(draft(), ACTOR);

    expect(result.report).toContain("profile imagery");
    expect(request).toHaveBeenCalledTimes(3);
    expect(bodyAt<{ reasoning_effort: string; max_completion_tokens: number }>(request, 2)).toMatchObject({
      reasoning_effort: "none",
      max_completion_tokens: 4_096
    });
  });

  it("repairs malformed synthesis JSON once", async () => {
    const malformed = new Response(
      JSON.stringify({
        choices: [{ finish_reason: "stop", message: { content: "not-json" } }]
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
    const request = vi
      .fn()
      .mockResolvedValueOnce(fireworks(plan()))
      .mockResolvedValueOnce(malformed)
      .mockResolvedValueOnce(fireworks(completed()));

    await expect(writer(request).generate(draft(), ACTOR)).resolves.toMatchObject({
      reportType: "sub_other_hate_speech"
    });
    expect(request).toHaveBeenCalledTimes(3);
  });

  it("maps a Fireworks refusal to a specific safe error", async () => {
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
      messageEvidence: { source: "context_menu", status: "captured", capturedAt: "2026-08-09T00:00:01.000Z", snapshot: {
        messageId: "333333333333333333",
        channelId: "222222222222222222",
        channelName: "channel",
        serverId: "111111111111111111",
        serverName: "server",
        authorId: "123456789012345678",
        authorUsername: "example",
        authorDisplayName: null,
        authorAvatarUrl: null,
        authorBot: false,
        content: "coded term",
        createdAt: "2026-08-09T00:00:00.000Z",
        attachments: [
          {
            name: "evidence.png",
            url: "https://cdn.discordapp.com/private-evidence.png",
            contentType: "image/png",
            size: 10,
            spoiler: false
          }
        ],
        embeds: []
      } }
    };
    const request = vi
      .fn()
      .mockResolvedValueOnce(fireworks(plan()))
      .mockResolvedValueOnce(fireworks(completed()));

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

  it("refines through Fireworks without searching or changing research", async () => {
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
      fireworks({ report: `Refined report under ${LAW}.` })
    );

    const result = await writer(request).refine(reportDraft, "Make it clearer", ACTOR);

    expect(result.report).toContain("Refined report");
    expect(result.legalResearch).toEqual(reportDraft.legalResearch);
    expect(request).toHaveBeenCalledTimes(1);
    expect(urlAt(request, 0)).toBe(
      "https://api.fireworks.ai/inference/v1/chat/completions"
    );
    expect(bodyAt<{ reasoning_effort: string; max_completion_tokens: number }>(request, 0)).toMatchObject({
      reasoning_effort: "none",
      max_completion_tokens: 4_096
    });
  });

  it("retains a candidate report when synthesis validation fails", async () => {
    const firstCandidate = "x".repeat(513);
    const repairedCandidate = "y".repeat(514);
    const request = vi
      .fn()
      .mockResolvedValueOnce(fireworks(plan()))
      .mockResolvedValueOnce(fireworks(completed({ report: firstCandidate })))
      .mockResolvedValueOnce(fireworks(completed({ report: repairedCandidate })));

    const failure = await writer(request)
      .generate(draft(), ACTOR)
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ReportWriterError);
    expect((failure as ReportWriterError).candidateReport).toBe(repairedCandidate);
    expect(request).toHaveBeenCalledTimes(3);
  });

  it("repairs a synthesis response that is missing its law reference", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(fireworks(plan()))
      .mockResolvedValueOnce(fireworks(completed({ lawReference: null })))
      .mockResolvedValueOnce(fireworks(completed()));

    const result = await writer(request).generate(draft(), ACTOR);

    expect(result.legalResearch.lawReference).toBe(LAW);
    expect(request).toHaveBeenCalledTimes(3);
    const repair = bodyAt<{
      reasoning_effort: string;
      max_completion_tokens: number;
      response_format?: unknown;
    }>(request, 2);
    expect(repair).toMatchObject({
      reasoning_effort: "none",
      max_completion_tokens: 4_096
    });
    expect(repair.response_format).toBeDefined();
  });

  it("repairs an invalid follow-up request once", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(fireworks(plan()))
      .mockResolvedValueOnce(
        fireworks(
          moreResearch("law", "Germany official Basic Law Article 1", {
            followUpType: "legal"
          })
        )
      )
      .mockResolvedValueOnce(fireworks(completed()));

    const result = await writer(request).generate(draft(), ACTOR);

    expect(result.report.length).toBeGreaterThan(0);
    expect(request).toHaveBeenCalledTimes(3);
  });

  it("stops after one failed synthesis repair", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(fireworks(plan()))
      .mockResolvedValueOnce(fireworks(completed({ lawReference: null })))
      .mockResolvedValueOnce(fireworks(completed({ researchSummary: null })));

    await expect(writer(request).generate(draft(), ACTOR)).rejects.toThrow(
      /remained invalid after one repair/
    );
    expect(request).toHaveBeenCalledTimes(3);
  });

  it("normalizes near-miss follow-up responses instead of rejecting them", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(fireworks(plan()))
      .mockResolvedValueOnce(
        fireworks(
          moreResearch("law", "Germany official Basic Law Article 1 text", {
            lawReference: "",
            report: "pending further research"
          })
        )
      )
      .mockResolvedValueOnce(braveLaw())
      .mockResolvedValueOnce(fireworks(completed()));

    const result = await writer(request).generate(draft(), ACTOR);

    expect(result.legalResearch.searchRequests).toBe(1);
    expect(request).toHaveBeenCalledTimes(4);
  });

  it("accepts a completed synthesis with stray follow-up values", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(fireworks(plan()))
      .mockResolvedValueOnce(
        fireworks(completed({ followUpType: "law", followUpQuery: "stray query" }))
      );

    const result = await writer(request).generate(draft(), ACTOR);

    expect(result.legalResearch.lawReference).toBe(LAW);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("repairs an unsupported planner country once", async () => {
    const auto = draft();
    delete auto.country;
    auto.countrySelection = "auto";
    const request = vi
      .fn()
      .mockResolvedValueOnce(
        fireworks(
          plan({
            country: "UK",
            reportType: "sub_other_hate_speech",
            reportReason: "The profile imagery contains hateful material."
          })
        )
      )
      .mockResolvedValueOnce(
        fireworks(
          plan({
            country: "DE",
            reportType: "sub_other_hate_speech",
            reportReason: "The profile imagery contains hateful material."
          })
        )
      )
      .mockResolvedValueOnce(fireworks(completed()));

    const result = await writer(request).generate(auto, ACTOR);

    expect(result.country).toBe("DE");
    expect(request).toHaveBeenCalledTimes(3);
  });

  it("repairs a planner whose search query breaks the sanitization rules", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(
        fireworks(
          plan({
            termResearchRequired: true,
            termSearchQuery: "meaning of coded term, see https://example.com"
          })
        )
      )
      .mockResolvedValueOnce(
        fireworks(
          plan({
            termResearchRequired: true,
            termSearchQuery: "coded term meaning hateful language"
          })
        )
      )
      .mockResolvedValueOnce(braveTerm())
      .mockResolvedValueOnce(fireworks(completed()));

    const result = await writer(request).generate(draft(), ACTOR);

    expect(result.legalResearch.searchRequests).toBe(1);
    expect(request).toHaveBeenCalledTimes(4);
  });

  it("skips a follow-up search whose query breaks the sanitization rules", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(fireworks(plan()))
      .mockResolvedValueOnce(
        fireworks(moreResearch("law", "Germany Basic Law text https://example.com"))
      )
      .mockResolvedValueOnce(fireworks(completed()));

    const result = await writer(request).generate(draft(), ACTOR);

    expect(result.legalResearch.searchRequests).toBe(0);
    expect(request).toHaveBeenCalledTimes(3);
    expect(
      request.mock.calls.some((call) => String(call[0]).includes("api.search.brave.com"))
    ).toBe(false);
  });
});
