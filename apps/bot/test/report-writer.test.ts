import { describe, expect, it, vi } from "vitest";

import type { AiRequestContext } from "../src/report-writer.js";
import { ReportWriter } from "../src/report-writer.js";
import type { AiUsage, ReportDraft } from "../src/types.js";

const COUNTRIES = ["DE", "FR", "IE"] as const;
const ACTOR: AiRequestContext = { actorKey: "actor-key", userId: "reporter-id" };
const LAW_REFERENCE = "Germany's Basic Law (Grundgesetz), Article 1";

function profileDraft(): ReportDraft {
  return {
    flow: "user_urf",
    country: "DE",
    countrySelection: "override",
    reportType: "sub_other_hate_speech",
    reportBrief: "The profile imagery contains unlawful hate speech.",
    reportedUsername: "example",
    reportedUserId: "123456789012345678",
    reportedUserSnapshot: {
      userId: "123456789012345678",
      username: "example",
      globalDisplayName: "Example Display",
      avatarUrl: "https://cdn.discordapp.com/avatar.png",
      bannerUrl: "https://cdn.discordapp.com/banner.png",
      bot: false,
      resolvedAt: "2026-07-20T00:00:00.000Z"
    },
    profileElements: ["photos"]
  };
}

function completion(
  value: Record<string, string>,
  options: {
    annotations?: unknown[];
    searchRequests?: number;
    usage?: Partial<AiUsage>;
  } = {}
): Response {
  const searchRequests = options.searchRequests ?? 0;
  return new Response(
    JSON.stringify({
      choices: [
        {
          message: {
            content: JSON.stringify(value),
            annotations: options.annotations ?? []
          }
        }
      ],
      usage: {
        prompt_tokens: options.usage?.inputTokens ?? 100,
        completion_tokens: options.usage?.outputTokens ?? 40,
        completion_tokens_details: {
          reasoning_tokens: options.usage?.reasoningTokens ?? 10
        },
        cost: options.usage?.costCredits ?? 0.001,
        server_tool_use: { web_search_requests: searchRequests }
      }
    }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}

function citationAnnotation(url = "https://example.gov/law"): unknown {
  return {
    type: "url_citation",
    url_citation: { url, title: LAW_REFERENCE }
  };
}

function researchCompletion(country = "DE"): Response {
  return completion(
    {
      country,
      lawReference: LAW_REFERENCE,
      researchSummary: `${LAW_REFERENCE} protects human dignity.`
    },
    { annotations: [citationAnnotation()], searchRequests: 1 }
  );
}

function reportCompletion(
  report = `The profile imagery may contain hate speech under ${LAW_REFERENCE}.`
) {
  return completion({ report });
}

function refinementCompletion(
  report = `${LAW_REFERENCE} may apply. Refined report.`,
  searchRequests = 0
): Response {
  return completion(
    {
      country: "DE",
      lawReference: LAW_REFERENCE,
      researchSummary: `${LAW_REFERENCE} protects human dignity.`,
      report
    },
    {
      annotations: searchRequests > 0 ? [citationAnnotation()] : [],
      searchRequests
    }
  );
}

function fixedWriter(
  request: ReturnType<typeof vi.fn>,
  recordUsage: ReturnType<typeof vi.fn> = vi.fn().mockResolvedValue(undefined)
): ReportWriter {
  return new ReportWriter("secret", "x-ai/grok-4.5", COUNTRIES, {
    reasoningEffort: "medium",
    recordUsage: recordUsage as unknown as (userId: string, usage: AiUsage) => Promise<void>,
    request: request as unknown as typeof globalThis.fetch
  });
}

function requestBody<T>(request: ReturnType<typeof vi.fn>, index: number): T {
  const body = (request.mock.calls[index]?.[1] as RequestInit | undefined)?.body;
  if (typeof body !== "string") throw new Error("Expected a JSON request body.");
  return JSON.parse(body) as T;
}

describe("OpenRouter report writer", () => {
  it("merges Auto country selection and research with full text context", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(researchCompletion())
      .mockResolvedValueOnce(reportCompletion());
    const draft = profileDraft();
    delete draft.country;
    draft.countrySelection = "auto";
    const result = await fixedWriter(request).generate(draft, ACTOR);

    expect(result.country).toBe("DE");
    expect(request).toHaveBeenCalledTimes(2);
    const research = requestBody<{
      max_tool_calls: number;
      messages: unknown[];
      tools: unknown[];
    }>(request, 0);
    expect(research.max_tool_calls).toBe(3);
    expect(research.tools).toEqual([{ type: "openrouter:web_search" }]);
    const text = JSON.stringify(research.messages);
    expect(text).toContain("Germany (DE)");
    expect(text).toContain("123456789012345678");
    expect(text).toContain("profile imagery");
    expect(text).toContain("Consider every supported country impartially");
    expect(text).toContain("regardless of list order");
    expect(text).toContain("strongest applicable legal basis");
    expect(text).not.toContain("Germany's Criminal Code");
    expect(text).not.toContain('"type":"image_url"');
    expect(text).not.toContain("https://cdn.discordapp.com/avatar.png");
    expect(text).not.toContain("https://cdn.discordapp.com/banner.png");
  });

  it("normalizes a supported country display name and constrains structured output to ISO codes", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(researchCompletion("Germany"))
      .mockResolvedValueOnce(reportCompletion());
    const draft = profileDraft();
    delete draft.country;
    draft.countrySelection = "auto";

    const result = await fixedWriter(request).generate(draft, ACTOR);

    expect(result.country).toBe("DE");
    const research = requestBody<{
      response_format: {
        json_schema: {
          schema: { properties: { country: { enum: string[]; type: string } } };
        };
      };
    }>(request, 0);
    expect(research.response_format.json_schema.schema.properties.country).toEqual({
      type: "string",
      enum: ["DE", "FR", "IE"]
    });
  });

  it("does not send media or media URLs for any report category", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(researchCompletion())
      .mockResolvedValueOnce(reportCompletion());
    const draft = profileDraft();
    draft.reportType = "sub_csam";

    await fixedWriter(request).generate(draft, ACTOR);

    for (const index of [0, 1]) {
      const body = requestBody<{ messages: unknown[] }>(request, index);
      const text = JSON.stringify(body.messages);
      expect(text).not.toContain('"type":"image_url"');
      expect(text).not.toContain("https://cdn.discordapp.com/avatar.png");
      expect(text).not.toContain("https://cdn.discordapp.com/banner.png");
    }
  });

  it("keeps GIF and video names as metadata without sending their media URLs", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(researchCompletion())
      .mockResolvedValueOnce(reportCompletion());
    const draft: ReportDraft = {
      flow: "message_urf",
      country: "DE",
      countrySelection: "override",
      reportType: "sub_other_hate_speech",
      reportBrief: "The attached media contains hateful imagery.",
      messageUrl:
        "https://discord.com/channels/123456789012345678/223456789012345678/323456789012345678",
      messageSnapshot: {
        messageId: "323456789012345678",
        channelId: "223456789012345678",
        channelName: "reports",
        serverId: "123456789012345678",
        serverName: "Example",
        authorId: "423456789012345678",
        authorUsername: "example",
        authorDisplayName: null,
        authorBot: false,
        content: "",
        createdAt: "2026-07-20T00:00:00.000Z",
        attachments: [
          {
            name: "evidence.gif",
            url: "https://cdn.discordapp.com/evidence.gif",
            contentType: "image/gif"
          },
          {
            name: "evidence.mp4",
            url: "https://cdn.discordapp.com/evidence.mp4",
            contentType: "video/mp4"
          }
        ],
        embeds: []
      }
    };

    await fixedWriter(request).generate(draft, ACTOR);

    const body = requestBody<{ messages: unknown[] }>(request, 0);
    const text = JSON.stringify(body.messages);
    expect(text).not.toContain('"type":"image_url"');
    expect(text).not.toContain('"type":"video_url"');
    expect(text).not.toContain("https://cdn.discordapp.com/evidence.gif");
    expect(text).not.toContain("https://cdn.discordapp.com/evidence.mp4");
    expect(text).toContain("evidence.gif");
    expect(text).toContain("image/gif");
    expect(text).toContain("evidence.mp4");
    expect(text).toContain("video/mp4");
  });

  it("uses standard search settings without domain or result restrictions", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(researchCompletion())
      .mockResolvedValueOnce(reportCompletion());
    await fixedWriter(request).generate(profileDraft(), ACTOR);
    const body = requestBody<Record<string, unknown>>(request, 0);
    expect(JSON.stringify(body)).not.toContain("allowed_domains");
    expect(JSON.stringify(body)).not.toContain("max_results");
    expect(JSON.stringify(body)).not.toContain("max_total_results");
  });

  it("keeps a fixed override and rejects an unsupported Auto country", async () => {
    const fixedRequest = vi
      .fn()
      .mockResolvedValueOnce(researchCompletion("FR"));
    await expect(fixedWriter(fixedRequest).generate(profileDraft(), ACTOR)).rejects.toThrow(
      /fixed country/
    );

    const autoRequest = vi.fn().mockResolvedValueOnce(researchCompletion("US"));
    const auto = profileDraft();
    delete auto.country;
    auto.countrySelection = "auto";
    await expect(fixedWriter(autoRequest).generate(auto, ACTOR)).rejects.toThrow(
      /supported country/
    );
  });

  it("accepts usable legal research without a search count or HTTPS annotation", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(
      completion(
          {
            country: "DE",
            lawReference: LAW_REFERENCE,
            researchSummary: `${LAW_REFERENCE} applies.`
          },
          { annotations: [], searchRequests: 0 }
        )
      )
      .mockResolvedValueOnce(reportCompletion());
    const result = await fixedWriter(request).generate(profileDraft(), ACTOR);
    expect(result.legalResearch.sources).toEqual([]);
    expect(result.legalResearch.searchRequests).toBe(0);
  });

  it("writes with configured medium reasoning and a natural inline law reference", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(researchCompletion())
      .mockResolvedValueOnce(reportCompletion());
    const result = await fixedWriter(request).generate(profileDraft(), ACTOR);
    expect(result.report).toContain(LAW_REFERENCE);
    const writing = requestBody<{
      reasoning: { effort: string; exclude: boolean };
      response_format: unknown;
    }>(request, 1);
    expect(writing.reasoning).toEqual({ effort: "medium", exclude: true });
    expect(JSON.stringify(writing.response_format)).not.toContain("lawCitation");
    const messages = JSON.stringify(
      requestBody<{ messages: unknown[] }>(request, 1).messages
    );
    expect(messages).toContain("Use this adaptable structure");
    expect(messages).not.toContain("Femboy6767");
    expect(messages).not.toContain("Hungarian Act");
    expect(messages).not.toContain("§130 StGB");
    expect(messages).toContain("country-qualified lawReference");
  });

  it("refines in the same conversation and offers search only when needed", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(researchCompletion())
      .mockResolvedValueOnce(reportCompletion())
      .mockResolvedValueOnce(refinementCompletion());
    const writer = fixedWriter(request);
    const draft = profileDraft();
    const initial = await writer.generate(draft, ACTOR);
    Object.assign(draft, {
      country: initial.country,
      legalResearch: initial.legalResearch,
      context: initial.report,
      writerConversation: initial.conversation
    });

    const refined = await writer.refine(draft, "Make it clearer.", ACTOR);
    expect(refined.report).toContain("Refined report");
    const body = requestBody<{ max_tool_calls: number; tools: unknown[]; messages: unknown[] }>(
      request,
      2
    );
    expect(body.tools).toEqual([{ type: "openrouter:web_search" }]);
    expect(body.max_tool_calls).toBe(2);
    expect(JSON.stringify(body.messages)).toContain("Make it clearer.");
    expect(JSON.stringify(body.messages)).toContain(initial.report);
  });

  it("updates Auto research when refinement searches again", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(researchCompletion())
      .mockResolvedValueOnce(reportCompletion())
      .mockResolvedValueOnce(
        completion(
          {
            country: "FR",
            lawReference: "France's Example Law, Article 1",
            researchSummary: "France's Example Law, Article 1 may apply.",
            report: "France's Example Law, Article 1 may apply. Revised report."
          },
          {
            annotations: [
              {
                type: "url_citation",
                url_citation: {
                  url: "https://example.fr/law",
                  title: "French Law Article 1"
                }
              }
            ],
            searchRequests: 1
          }
        )
      );
    const writer = fixedWriter(request);
    const draft = profileDraft();
    draft.countrySelection = "auto";
    const initial = await writer.generate(draft, ACTOR);
    Object.assign(draft, {
      country: initial.country,
      legalResearch: initial.legalResearch,
      context: initial.report,
      writerConversation: initial.conversation
    });
    const refined = await writer.refine(draft, "Check French law.", ACTOR);
    expect(refined.country).toBe("FR");
    expect(refined.legalResearch.searchRequests).toBe(2);
  });

  it("repairs an invalid refinement inside the same conversation", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(researchCompletion())
      .mockResolvedValueOnce(reportCompletion())
      .mockResolvedValueOnce(refinementCompletion("Missing its law reference."))
      .mockResolvedValueOnce(
        reportCompletion(`${LAW_REFERENCE} may apply. Repaired refinement.`)
      );
    const writer = fixedWriter(request);
    const draft = profileDraft();
    const initial = await writer.generate(draft, ACTOR);
    Object.assign(draft, {
      country: initial.country,
      legalResearch: initial.legalResearch,
      context: initial.report,
      writerConversation: initial.conversation
    });
    const refined = await writer.refine(draft, "Make it shorter.", ACTOR);
    expect(refined.report).toContain("Repaired refinement");
    const repair = requestBody<{ messages: unknown[] }>(request, 3);
    const messages = JSON.stringify(repair.messages);
    expect(messages).toContain("Make it shorter.");
    expect(messages).toContain("Missing its law reference.");
    expect(messages).toContain("Task: Repair the current report.");
  });

  it("repairs invalid output in the same conversation once", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(researchCompletion())
      .mockResolvedValueOnce(reportCompletion("No law reference here."))
      .mockResolvedValueOnce(
        reportCompletion(`${LAW_REFERENCE} may apply. Repaired report.`)
      );
    const result = await fixedWriter(request).generate(profileDraft(), ACTOR);
    expect(result.report).toContain("Repaired report");
    const repair = requestBody<{ messages: unknown[] }>(request, 2);
    expect(JSON.stringify(repair.messages)).toContain("No law reference here.");
    expect(JSON.stringify(repair.messages)).toContain("Task: Repair the current report.");
  });

  it("records each successful request's usage without making another API call", async () => {
    const recordUsage = vi.fn().mockResolvedValue(undefined);
    const request = vi
      .fn()
      .mockResolvedValueOnce(researchCompletion())
      .mockResolvedValueOnce(reportCompletion());
    await fixedWriter(request, recordUsage).generate(profileDraft(), ACTOR);
    expect(recordUsage).toHaveBeenCalledTimes(2);
    expect(recordUsage).toHaveBeenCalledWith(
      "reporter-id",
      expect.objectContaining({
        inputTokens: 100,
        outputTokens: 40,
        reasoningTokens: 10,
        costCredits: 0.001
      })
    );
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("logs usage without raw user or report content", async () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      const request = vi
        .fn()
        .mockResolvedValueOnce(researchCompletion())
        .mockResolvedValueOnce(reportCompletion());
      await fixedWriter(request).generate(profileDraft(), ACTOR);
      const output = write.mock.calls.map((call) => String(call[0])).join("");
      expect(output).toContain('"actorKey":"actor-key"');
      expect(output).toContain('"inputTokens":100');
      expect(output).not.toContain("reporter-id");
      expect(output).not.toContain("profile imagery");
      expect(output).not.toContain("123456789012345678");
    } finally {
      write.mockRestore();
    }
  });

  it("returns specific safe errors for balance and rate limits", async () => {
    await expect(
      fixedWriter(vi.fn().mockResolvedValue(new Response("private", { status: 402 }))).generate(
        profileDraft(),
        ACTOR
      )
    ).rejects.toThrow(/insufficient balance/);
    await expect(
      fixedWriter(vi.fn().mockResolvedValue(new Response("private", { status: 429 }))).generate(
        profileDraft(),
        ACTOR
      )
    ).rejects.toThrow(/rate limited/);
  });
});
