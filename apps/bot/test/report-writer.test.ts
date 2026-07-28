import { describe, expect, it, vi } from "vitest";

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
  return new ReportWriter("secret", "deepseek/deepseek-v4-flash", COUNTRIES, {
    reasoningEffort: "high",
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
      max_tokens?: number;
      messages: unknown[];
      tools: unknown[];
    }>(request, 0);
    expect(research.max_tool_calls).toBe(2);
    expect(research.max_tokens).toBeUndefined();
    expect(research.tools).toEqual([
      {
        type: "openrouter:web_search",
        parameters: {
          engine: "exa",
          max_results: 3,
          max_total_results: 5,
          max_characters: 2_500
        }
      }
    ]);
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
        stage: "research_complete",
        country: "DE",
        lawReference: LAW_REFERENCE,
        reportReason: inferredReason,
        reportType: "Other: hate speech",
        searchRequests: 1
      },
      { stage: "write", reportReason: inferredReason }
    ]);
    const research = requestBody<{
      messages: unknown[];
      provider: Record<string, unknown>;
      response_format: { type: string };
    }>(request, 0);
    const prompt = JSON.stringify(research.messages);
    expect(prompt).toContain("Report category: Auto");
    expect(prompt).toContain("Reporter explanation: Auto");
    expect(prompt).toContain("sub_other_hate_speech");
    expect(research.response_format).toEqual({ type: "json_object" });
    expect(research.provider).toEqual({ data_collection: "deny" });
    expect(prompt).toContain("reportReason");
    expect(prompt).toContain("reportType");
  });

  it("normalizes a supported country display name and requests JSON mode", async () => {
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
    expect(research.response_format).toEqual({ type: "json_object" });
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

  it("uses tighter bounded search for a fixed country without bounding research output", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(researchCompletion())
      .mockResolvedValueOnce(reportCompletion());
    await fixedWriter(request).generate(profileDraft(), ACTOR);
    const body = requestBody<{
      max_tool_calls: number;
      max_tokens?: number;
      tools: unknown[];
    }>(request, 0);
    expect(body.max_tool_calls).toBe(1);
    expect(body.max_tokens).toBeUndefined();
    expect(body.tools).toEqual([
      {
        type: "openrouter:web_search",
        parameters: {
          engine: "exa",
          max_results: 3,
          max_total_results: 3,
          max_characters: 2_500
        }
      }
    ]);
    expect(JSON.stringify(body)).not.toContain("allowed_domains");
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
            reportReason: "The profile imagery contains unlawful hate speech.",
            reportType: "sub_other_hate_speech",
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

  it("accepts an internal law reference longer than the final report limit", async () => {
    const detailedLawReference = `Germany, Criminal Code, Section 176 (${`detail `.repeat(100)})`;
    expect(detailedLawReference.length).toBeGreaterThan(512);
    const request = vi
      .fn()
      .mockResolvedValueOnce(
        completion({
          country: "DE",
          lawReference: detailedLawReference,
          reportReason: "The profile imagery contains unlawful hate speech.",
          reportType: "sub_other_hate_speech",
          researchSummary: "The provision may be relevant to the reported conduct."
        })
      )
      .mockResolvedValueOnce(reportCompletion("Concise reviewed report."));

    const result = await fixedWriter(request).generate(profileDraft(), ACTOR);

    expect(result.legalResearch.lawReference).toBe(detailedLawReference);
    expect(result.report).toBe("Concise reviewed report.");
  });

  it("writes with configured high reasoning and a natural inline law reference", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(researchCompletion())
      .mockResolvedValueOnce(reportCompletion());
    const result = await fixedWriter(request).generate(profileDraft(), ACTOR);
    expect(result.report).toContain(LAW_REFERENCE);
    const writing = requestBody<{
      provider: Record<string, unknown>;
      reasoning: { effort: string; exclude: boolean };
      response_format: unknown;
    }>(request, 1);
    expect(writing.reasoning).toEqual({ effort: "high", exclude: true });
    expect(writing.provider).toEqual({
      zdr: true,
      data_collection: "deny",
      require_parameters: true
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
    const body = requestBody<{ messages: unknown[]; response_format: unknown }>(request, 2);
    expect(body.response_format).toEqual({ type: "json_object" });
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
    const repair = requestBody<{ messages: unknown[] }>(request, 3);
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
});
