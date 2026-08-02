import { describe, expect, it, vi } from "vitest";
import { reportReasons } from "@discord-dsa/contracts";

import type { AiRequestContext } from "../src/report-writer.js";
import { ReportWriter, ReportWriterError } from "../src/report-writer.js";
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
    content?: string;
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
            content: options.content ?? JSON.stringify(value),
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

function researchCompletion(
  country = "DE",
  reportReason = "The profile imagery contains unlawful hate speech.",
  reportType = "sub_other_hate_speech"
): Response {
  return completion(
    {
      country,
      lawReference: LAW_REFERENCE,
      reportReason,
      reportType,
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
    { report },
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
  return new ReportWriter("secret", "minimax/minimax-m2.7", COUNTRIES, {
    recordUsage: recordUsage as unknown as (userId: string, usage: AiUsage) => Promise<void>,
    request: request as unknown as typeof globalThis.fetch
  });
}

function requestBody<T>(request: ReturnType<typeof vi.fn>, index: number): T {
  const body = (request.mock.calls[index]?.[1] as RequestInit | undefined)?.body;
  if (typeof body !== "string") throw new Error("Expected a JSON request body.");
  return JSON.parse(body) as T;
}

function requestHeaders(
  request: ReturnType<typeof vi.fn>,
  index: number
): Record<string, string> {
  const headers = (request.mock.calls[index]?.[1] as RequestInit | undefined)?.headers;
  if (!headers || headers instanceof Headers || Array.isArray(headers)) {
    throw new Error("Expected object request headers.");
  }
  return headers;
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
      max_tool_calls?: number;
      max_tokens?: number;
      messages: unknown[];
      plugins?: unknown[];
      stream: boolean;
      tools: unknown[];
    }>(request, 0);
    expect(research.max_tool_calls).toBeUndefined();
    expect(research.max_tokens).toBeUndefined();
    expect(research.plugins).toBeUndefined();
    expect(research.stream).toBe(false);
    expect(research.tools).toEqual([
      {
        type: "openrouter:web_search",
        parameters: {
          engine: "parallel",
          max_results: 2,
          max_total_results: 4,
          max_characters: 2_500,
          max_uses: 2
        }
      }
    ]);
    const text = JSON.stringify(research.messages);
    expect(text).toContain("Germany (DE)");
    expect(text).toContain("123456789012345678");
    expect(text).toContain("Example Display");
    expect(text).toContain("profile imagery");
    expect(text).toContain("impartially identify the strongest likely legal fit");
    expect(text).toContain("without using list order or presumed location");
    expect(text).toContain("then confirm that country's law");
    expect(text).toContain("skip terminology search");
    expect(text).not.toContain("Child sexual abuse material");
    expect(text).not.toContain("sub_csam");
    expect(text).not.toContain("Germany's Criminal Code");
    expect(text).not.toContain('"type":"image_url"');
    expect(text).not.toContain("https://cdn.discordapp.com/avatar.png");
    expect(text).not.toContain("https://cdn.discordapp.com/banner.png");
  });

  it("infers an Auto category and reason while reporting ordered progress", async () => {
    const inferredReason = "The profile imagery targets a protected group with hateful content.";
    const request = vi
      .fn()
      .mockResolvedValueOnce(
        researchCompletion("DE", inferredReason, "sub_other_hate_speech")
      )
      .mockResolvedValueOnce(reportCompletion());
    const draft = profileDraft();
    delete draft.country;
    delete draft.reportType;
    delete draft.reportBrief;
    draft.countrySelection = "auto";
    const progress: unknown[] = [];

    const result = await fixedWriter(request).generate(draft, ACTOR, (update) => {
      progress.push(update);
    });

    expect(result).toMatchObject({
      country: "DE",
      reportReason: inferredReason,
      reportType: "sub_other_hate_speech"
    });
    expect(progress).toEqual([
      {
        stage: "research",
        country: "Auto",
        reportReason: "Auto",
        reportType: "Auto"
      },
      {
        stage: "write",
        country: "DE",
        reportReason: inferredReason,
        reportType: "Other: hate speech"
      }
    ]);
    expect(request).toHaveBeenCalledTimes(2);
    const research = requestBody<{
      messages: unknown[];
      provider: Record<string, unknown>;
      response_format: Record<string, unknown>;
      tool_choice: string;
    }>(request, 0);
    const prompt = JSON.stringify(research.messages);
    expect(prompt).toContain("Report category: Auto");
    expect(prompt).toContain("Reporter explanation: Auto");
    expect(prompt).toContain("sub_other_hate_speech");
    expect(prompt).toContain("search its exact evidence wording");
    expect(prompt).toContain("then use web search to identify and confirm");
    expect(research.tool_choice).toBe("required");
    expect(research.response_format).toEqual({
      type: "json_schema",
      json_schema: {
        name: "discord_dsa_research",
        strict: true,
        schema: {
          type: "object",
          properties: {
            country: { type: "string", enum: [...COUNTRIES] },
            reportType: {
              type: "string",
              enum: reportReasons("user_urf").map((reason) => reason.value)
            },
            reportReason: { type: "string", minLength: 1, maxLength: 512 },
            lawReference: { type: "string", minLength: 1 },
            researchSummary: { type: "string", minLength: 1 }
          },
          required: [
            "country",
            "reportType",
            "reportReason",
            "lawReference",
            "researchSummary"
          ],
          additionalProperties: false
        }
      }
    });
    expect(research.provider).toEqual({
      require_parameters: true,
      data_collection: "deny",
      order: [
        "sambanova/minimax-m2.7-dedicated",
        "mara",
        "fireworks",
        "groq",
        "sambanova"
      ]
    });
    expect(prompt).toContain("reportReason");
    expect(prompt).toContain("reportType");
    const writingPrompt = JSON.stringify(
      requestBody<{ messages: unknown[] }>(request, 1).messages
    );
    expect(writingPrompt).toContain("Other: hate speech");
    expect(writingPrompt).toContain(inferredReason);
    expect(writingPrompt).toContain(LAW_REFERENCE);
    expect(writingPrompt).not.toContain("Supported countries:");
    expect(writingPrompt).not.toContain("Child sexual abuse material");
    expect(writingPrompt).not.toContain("sub_csam");
    expect(writingPrompt).not.toContain("openrouter:web_search");
  });

  it("treats a literal Auto reason as omitted instead of a fixed supplied reason", async () => {
    const inferredReason = "The profile imagery targets a protected group with hateful content.";
    const request = vi
      .fn()
      .mockResolvedValueOnce(
        researchCompletion("DE", inferredReason, "sub_other_hate_speech")
      )
      .mockResolvedValueOnce(reportCompletion());
    const draft = profileDraft();
    draft.reportBrief = "Auto";

    const result = await fixedWriter(request).generate(draft, ACTOR);

    expect(result.reportReason).toBe(inferredReason);
    expect(JSON.stringify(requestBody<{ messages: unknown[] }>(request, 0).messages)).toContain(
      "Reporter explanation: Auto"
    );
  });

  it("normalizes a supported country display name and requests strict JSON", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(researchCompletion("Germany"))
      .mockResolvedValueOnce(reportCompletion());
    const draft = profileDraft();
    delete draft.country;
    draft.countrySelection = "auto";

    const result = await fixedWriter(request).generate(draft, ACTOR);

    expect(result.country).toBe("DE");
    const research = requestBody<{ response_format: { type: string } }>(request, 0);
    expect(research.response_format.type).toBe("json_schema");
  });

  it("does not send media or media URLs for any report category", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(
        researchCompletion(
          "DE",
          "The profile imagery contains unlawful hate speech.",
          "sub_csam"
        )
      )
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
      .mockResolvedValueOnce(
        researchCompletion("DE", "The attached media contains hateful imagery.")
      )
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

  it("rewrites a denied report instead of fixing its prior reason as the new reason", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(
        researchCompletion(
          "DE",
          "A clearer evidence-grounded replacement reason.",
          "sub_other_hate_speech"
        )
      )
      .mockResolvedValueOnce(reportCompletion("A newly written report under the researched law."));
    const draft = profileDraft();
    delete draft.reportBrief;
    draft.resubmitOfReportId = "denied-report-id";
    draft.rewriteRequest = {
      previousReportReason: "The old denied reason.",
      previousContext: "The old denied report text.",
      instruction: "Make the evidence and requested action clearer."
    };

    const result = await fixedWriter(request).generate(draft, ACTOR);

    const body = requestBody<{ messages: unknown[] }>(request, 0);
    const text = JSON.stringify(body.messages);
    expect(text).toContain("Reporter explanation: Rewrite");
    expect(text).toContain("The old denied reason.");
    expect(text).toContain("Make the evidence and requested action clearer.");
    expect(text).not.toContain("Fixed reporter explanation");
    expect(result.reportReason).toBe("A clearer evidence-grounded replacement reason.");
  });

  it("uses tighter bounded search for a fixed country without bounding research output", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(researchCompletion())
      .mockResolvedValueOnce(reportCompletion());
    await fixedWriter(request).generate(profileDraft(), ACTOR);
    const body = requestBody<{
      max_tool_calls?: number;
      max_tokens?: number;
      plugins?: unknown[];
      provider: Record<string, unknown>;
      response_format: {
        json_schema: { schema: { required: string[] } };
      };
      stream: boolean;
      tool_choice: string;
      tools: unknown[];
    }>(request, 0);
    expect(body.max_tool_calls).toBeUndefined();
    expect(body.max_tokens).toBeUndefined();
    expect(body.plugins).toBeUndefined();
    expect(body.tool_choice).toBe("required");
    expect(body.stream).toBe(false);
    expect(body.provider).toEqual({
      require_parameters: true,
      data_collection: "deny",
      order: [
        "sambanova/minimax-m2.7-dedicated",
        "mara",
        "fireworks",
        "groq",
        "sambanova"
      ]
    });
    expect(body.response_format.json_schema.schema.required).toEqual([
      "lawReference",
      "researchSummary"
    ]);
    expect(body.tools).toEqual([
      {
        type: "openrouter:web_search",
        parameters: {
          engine: "parallel",
          max_results: 2,
          max_total_results: 4,
          max_characters: 2_500,
          max_uses: 2
        }
      }
    ]);
    expect(JSON.stringify(body)).not.toContain("allowed_domains");
    const prompt = JSON.stringify(
      requestBody<{ messages: unknown[] }>(request, 0).messages
    );
    expect(prompt).toContain(
      "Return raw JSON containing exactly these string properties: lawReference, researchSummary."
    );
    expect(prompt).not.toContain("Report category: Auto");
    expect(prompt).not.toContain("Child sexual abuse material");
    expect(prompt).not.toContain("sub_csam");
  });

  it("keeps application-owned values and rejects an unsupported Auto country", async () => {
    const fixedRequest = vi
      .fn()
      .mockResolvedValueOnce(
        researchCompletion("FR", "AI rewrote the reason.", "sub_csam")
      )
      .mockResolvedValueOnce(reportCompletion());
    const fixed = await fixedWriter(fixedRequest).generate(profileDraft(), ACTOR);
    expect(fixed).toMatchObject({
      country: "DE",
      reportReason: "The profile imagery contains unlawful hate speech.",
      reportType: "sub_other_hate_speech"
    });

    const autoRequest = vi
      .fn()
      .mockResolvedValueOnce(researchCompletion("US"))
      .mockResolvedValueOnce(researchCompletion("US"));
    const auto = profileDraft();
    delete auto.country;
    auto.countrySelection = "auto";
    await expect(fixedWriter(autoRequest).generate(auto, ACTOR)).rejects.toThrow(
      /supported country/
    );
  });

  it("retries usable legal research that reports zero searches", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(
        completion(
          {
            country: "DE",
            lawReference: LAW_REFERENCE,
            reportReason: "The profile imagery contains unlawful hate speech.",
            reportType: "sub_other_hate_speech",
            researchSummary: `${LAW_REFERENCE} applies.`
          },
          { annotations: [], searchRequests: 0 }
        )
      )
      .mockResolvedValueOnce(researchCompletion())
      .mockResolvedValueOnce(reportCompletion());
    const result = await fixedWriter(request).generate(profileDraft(), ACTOR);
    expect(result.legalResearch.searchRequests).toBe(1);
    expect(request).toHaveBeenCalledTimes(3);
    expect(
      JSON.stringify(requestBody<{ messages: unknown[] }>(request, 1).messages)
    ).toContain("Previous research attempt did not use the required legal web search");
  });

  it("stops after one zero-search research retry", async () => {
    const zeroSearchResearch = completion(
      {
        country: "DE",
        lawReference: LAW_REFERENCE,
        reportReason: "The profile imagery contains unlawful hate speech.",
        reportType: "sub_other_hate_speech",
        researchSummary: `${LAW_REFERENCE} protects human dignity.`
      },
      { searchRequests: 0 }
    );
    const request = vi
      .fn()
      .mockResolvedValueOnce(zeroSearchResearch)
      .mockResolvedValueOnce(zeroSearchResearch.clone());

    await expect(fixedWriter(request).generate(profileDraft(), ACTOR)).rejects.toThrow(
      /did not use the required web search after one retry/
    );
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("retries malformed research JSON once without logging or replaying it", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(
        completion({}, { content: "analysis before a malformed object", searchRequests: 1 })
      )
      .mockResolvedValueOnce(researchCompletion())
      .mockResolvedValueOnce(reportCompletion());

    await expect(fixedWriter(request).generate(profileDraft(), ACTOR)).resolves.toMatchObject({
      country: "DE"
    });
    expect(request).toHaveBeenCalledTimes(3);
    const retryBody = JSON.stringify(requestBody<{ messages: unknown[] }>(request, 1));
    expect(retryBody).toContain("Previous research attempt returned invalid structured data");
    expect(retryBody).not.toContain("analysis before a malformed object");
  });

  it("stops after one malformed research retry", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(
        completion({}, { content: "first malformed response", searchRequests: 1 })
      )
      .mockResolvedValueOnce(
        completion({}, { content: "second malformed response", searchRequests: 1 })
      );

    await expect(fixedWriter(request).generate(profileDraft(), ACTOR)).rejects.toThrow(
      /AI research returned invalid JSON/
    );
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("accepts an internal law reference longer than the final report limit", async () => {
    const detailedLawReference = `Germany, Criminal Code, Section 176 (${`detail `.repeat(100)})`;
    expect(detailedLawReference.length).toBeGreaterThan(512);
    const request = vi
      .fn()
      .mockResolvedValueOnce(
        completion(
          {
            country: "DE",
            lawReference: detailedLawReference,
            reportReason: "The profile imagery contains unlawful hate speech.",
            reportType: "sub_other_hate_speech",
            researchSummary: "The provision may be relevant to the reported conduct."
          },
          { searchRequests: 1 }
        )
      )
      .mockResolvedValueOnce(reportCompletion("Concise reviewed report."));

    const result = await fixedWriter(request).generate(profileDraft(), ACTOR);

    expect(result.legalResearch.lawReference).toBe(detailedLawReference);
    expect(result.report).toBe("Concise reviewed report.");
  });

  it("writes with mandatory reasoning headroom and a natural inline law reference", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(researchCompletion())
      .mockResolvedValueOnce(reportCompletion());
    const result = await fixedWriter(request).generate(profileDraft(), ACTOR);
    expect(result.report).toContain(LAW_REFERENCE);
    const writing = requestBody<{
      max_tokens: number;
      provider: Record<string, unknown>;
      reasoning: { enabled: boolean; exclude: boolean };
      response_format: unknown;
    }>(request, 1);
    expect(writing.max_tokens).toBe(4_096);
    expect(writing.reasoning).toEqual({ enabled: true, exclude: true });
    expect(writing.provider).toEqual({
      zdr: true,
      require_parameters: true,
      data_collection: "deny",
      order: [
        "sambanova/minimax-m2.7-dedicated",
        "mara",
        "fireworks",
        "groq",
        "sambanova"
      ]
    });
    expect(JSON.stringify(writing.response_format)).not.toContain("lawCitation");
    const messages = JSON.stringify(
      requestBody<{ messages: unknown[] }>(request, 1).messages
    );
    expect(messages).toContain("Use this adaptable structure");
    expect(messages).not.toContain("Femboy6767");
    expect(messages).not.toContain("Hungarian Act");
    expect(messages).not.toContain("§130 StGB");
    expect(messages).toContain("country-qualified lawReference");
    expect(messages).toContain("Never wrap the JSON in Markdown or a code fence");
  });

  it("accepts one whole-response Markdown JSON fence from a provider", async () => {
    const report = `${LAW_REFERENCE} may apply. Review requested.`;
    const request = vi
      .fn()
      .mockResolvedValueOnce(researchCompletion())
      .mockResolvedValueOnce(
        completion(
          { report },
          { content: `\`\`\`json\n${JSON.stringify({ report })}\n\`\`\`` }
        )
      );

    await expect(fixedWriter(request).generate(profileDraft(), ACTOR)).resolves.toMatchObject({
      report
    });
  });

  it("refines in the same conversation using the existing research", async () => {
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
      reportReason: initial.reportReason,
      reportType: initial.reportType,
      writerConversation: initial.conversation
    });

    const refined = await writer.refine(draft, "Make it clearer.", ACTOR);
    expect(refined.report).toContain("Refined report");
    const body = requestBody<{
      max_tokens: number;
      messages: unknown[];
      reasoning: { enabled: boolean; exclude: boolean };
      response_format: unknown;
    }>(request, 2);
    expect(body.max_tokens).toBe(4_096);
    expect(body.reasoning).toEqual({ enabled: true, exclude: true });
    expect(body.response_format).toEqual({
      type: "json_schema",
      json_schema: {
        name: "discord_dsa_report",
        strict: true,
        schema: {
          type: "object",
          properties: {
            report: { type: "string", minLength: 1, maxLength: 512 }
          },
          required: ["report"],
          additionalProperties: false
        }
      }
    });
    expect(JSON.stringify(body.messages)).toContain("Make it clearer.");
    expect(JSON.stringify(body.messages)).toContain(initial.report);
  });

  it("preserves Auto research during refinement", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(researchCompletion())
      .mockResolvedValueOnce(reportCompletion())
      .mockResolvedValueOnce(refinementCompletion("Refined report."));
    const writer = fixedWriter(request);
    const draft = profileDraft();
    draft.countrySelection = "auto";
    const initial = await writer.generate(draft, ACTOR);
    Object.assign(draft, {
      country: initial.country,
      legalResearch: initial.legalResearch,
      context: initial.report,
      reportReason: initial.reportReason,
      reportType: initial.reportType,
      writerConversation: initial.conversation
    });
    const refined = await writer.refine(draft, "Make it clearer.", ACTOR);
    expect(refined.country).toBe("DE");
    expect(refined.legalResearch).toEqual(initial.legalResearch);
  });

  it("repairs an invalid refinement inside the same conversation", async () => {
    const overlength = "x".repeat(513);
    const request = vi
      .fn()
      .mockResolvedValueOnce(researchCompletion())
      .mockResolvedValueOnce(reportCompletion())
      .mockResolvedValueOnce(refinementCompletion(overlength))
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
      reportReason: initial.reportReason,
      reportType: initial.reportType,
      writerConversation: initial.conversation
    });
    const refined = await writer.refine(draft, "Make it shorter.", ACTOR);
    expect(refined.report).toContain("Repaired refinement");
    const repair = requestBody<{
      max_tokens: number;
      messages: unknown[];
      reasoning: { enabled: boolean; exclude: boolean };
    }>(request, 3);
    expect(repair.max_tokens).toBe(4_096);
    expect(repair.reasoning).toEqual({ enabled: true, exclude: true });
    const messages = JSON.stringify(repair.messages);
    expect(messages).toContain("Make it shorter.");
    expect(messages).toContain(overlength);
    expect(messages).toContain("Task: Repair the current report.");
  });

  it("repairs invalid output in the same conversation once", async () => {
    const overlength = "y".repeat(513);
    const request = vi
      .fn()
      .mockResolvedValueOnce(researchCompletion())
      .mockResolvedValueOnce(reportCompletion(overlength))
      .mockResolvedValueOnce(
        reportCompletion(`${LAW_REFERENCE} may apply. Repaired report.`)
      );
    const result = await fixedWriter(request).generate(profileDraft(), ACTOR);
    expect(result.report).toContain("Repaired report");
    const repair = requestBody<{ messages: unknown[] }>(request, 2);
    expect(JSON.stringify(repair.messages)).toContain(overlength);
    expect(JSON.stringify(repair.messages)).toContain("Task: Repair the current report.");
  });

  it("preserves the latest invalid AI report for manual repair", async () => {
    const first = "a".repeat(513);
    const repaired = "b".repeat(514);
    const request = vi
      .fn()
      .mockResolvedValueOnce(researchCompletion())
      .mockResolvedValueOnce(reportCompletion(first))
      .mockResolvedValueOnce(reportCompletion(repaired));

    const failure = await fixedWriter(request)
      .generate(profileDraft(), ACTOR)
      .then(
        () => undefined,
        (error: unknown) => error
      );
    expect(failure).toBeInstanceOf(ReportWriterError);
    if (!(failure instanceof ReportWriterError)) throw new Error("Expected ReportWriterError.");
    expect(failure.candidateReport).toBe(repaired);
    expect(failure.country).toBe("DE");
    expect(failure.legalResearch?.country).toBe("DE");
    expect(failure.reportReason).toBe("The profile imagery contains unlawful hate speech.");
    expect(failure.reportType).toBe("sub_other_hate_speech");
    expect(failure.conversation?.length).toBeGreaterThan(0);
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

  it("requests and safely logs OpenRouter routing diagnostics", async () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      const request = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            error: {
              code: 404,
              message:
                "No allowed providers are available for the selected model; private upstream detail",
              metadata: { error_type: "not_found", provider_code: "NO_ENDPOINTS" }
            },
            openrouter_metadata: {
              strategy: "direct",
              attempt: 0,
              attempts: [
                { provider: "Mara", model: "minimax/minimax-m2.7", status: 404 },
                { provider: "Fireworks", model: "minimax/minimax-m2.7", status: 502 }
              ],
              endpoints: {
                total: 2,
                available: [
                  { provider: "Mara", selected: false },
                  { provider: "Fireworks", selected: false }
                ]
              },
              pipeline: [
                {
                  type: "server_tool",
                  name: "web-search",
                  data: { private: "must not be logged" }
                }
              ]
            }
          }),
          {
            status: 404,
            headers: {
              "Content-Type": "application/json",
              "Retry-After": "3",
              "X-Generation-Id": "gen-safe123"
            }
          }
        )
      );

      await expect(fixedWriter(request).generate(profileDraft(), ACTOR)).rejects.toThrow(
        /temporarily unavailable/
      );
      const headers = requestHeaders(request, 0);
      expect(headers["X-OpenRouter-Metadata"]).toBe("enabled");
      const output = write.mock.calls.map((call) => String(call[0])).join("");
      expect(output).toContain('"openRouterErrorCode":404');
      expect(output).toContain('"openRouterErrorType":"not_found"');
      expect(output).toContain('"openRouterProviderCode":"NO_ENDPOINTS"');
      expect(output).toContain('"openRouterMessageCategory":"no_allowed_providers"');
      expect(output).toContain('"openRouterGenerationId":"gen-safe123"');
      expect(output).toContain('"routingAttempt":0');
      expect(output).toContain('"routingEndpointTotal":2');
      expect(output).toContain('"routingEndpointAvailable":2');
      expect(output).toContain('"routingEndpointSelected":0');
      expect(output).toContain('"routingProviders":"Fireworks,Mara"');
      expect(output).toContain('"routingAttempts":"Mara:404,Fireworks:502"');
      expect(output).toContain('"routingPipeline":"server_tool:web-search"');
      expect(output).toContain('"retryAfterSeconds":3');
      expect(output).not.toContain("private upstream detail");
      expect(output).not.toContain("must not be logged");
    } finally {
      write.mockRestore();
    }
  });

  it("identifies the failed AI stage in safe response errors", async () => {
    await expect(
      fixedWriter(
        vi.fn().mockResolvedValue(new Response("not json", { status: 200 }))
      ).generate(profileDraft(), ACTOR)
    ).rejects.toThrow(/AI legal research returned a malformed response/);

    const writingRequest = vi
      .fn()
      .mockResolvedValueOnce(researchCompletion())
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ choices: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        })
      );
    await expect(fixedWriter(writingRequest).generate(profileDraft(), ACTOR)).rejects.toThrow(
      /AI report writing returned no completion/
    );
  });
});
