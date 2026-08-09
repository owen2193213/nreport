import { describe, expect, it, vi } from "vitest";

import {
  BraveResearchClient,
  validateResearchQuery
} from "../src/brave-research.js";
import type { AiRequestContext } from "../src/groq-client.js";
import type { ReportDraft } from "../src/types.js";

const ACTOR: AiRequestContext = { actorKey: "actor-key", userId: "reporter-id" };

function draft(): ReportDraft {
  return {
    flow: "message_urf",
    country: "DE",
    countrySelection: "override",
    reportType: "sub_other_hate_speech",
    reportBrief: "The message contains a threat.",
    reportedUserId: "123456789012345678",
    reportedUsername: "SensitiveUser",
    guildIdOrInviteCode: "private-invite",
    messageUrl: "https://discord.com/channels/111/222/333",
    messageSnapshot: {
      messageId: "333333333333333333",
      channelId: "222222222222222222",
      channelName: "private-channel",
      serverId: "111111111111111111",
      serverName: "Sensitive Server",
      authorId: "123456789012345678",
      authorUsername: "SensitiveUser",
      authorDisplayName: "Sensitive Display",
      authorBot: false,
      content: "coded term",
      createdAt: "2026-08-09T00:00:00.000Z",
      attachments: [
        {
          name: "evidence.txt",
          url: "https://cdn.discordapp.com/attachments/private/evidence.txt",
          contentType: "text/plain"
        }
      ],
      embeds: []
    }
  };
}

function termResponse(): Response {
  return new Response(
    JSON.stringify({
      type: "search",
      web: {
        type: "search",
        results: [
          {
            title: "Definition source",
            url: "https://dictionary.example/term",
            description: "A useful definition of the coded term.",
            extra_snippets: ["A second contextual usage."]
          },
          {
            title: "Duplicate",
            url: "https://dictionary.example/term",
            description: "Duplicate result."
          },
          {
            title: "Unsafe HTTP",
            url: "http://unsafe.example/term",
            description: "Not HTTPS."
          },
          {
            title: "Credentials",
            url: "https://user:pass@example.test/private",
            description: "Credential-bearing URL."
          }
        ]
      }
    }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}

function lawResponse(): Response {
  return new Response(
    JSON.stringify({
      grounding: {
        generic: [
          {
            url: "https://www.gesetze-im-internet.de/gg/art_1.html",
            title: "Basic Law Article 1",
            snippets: [
              "Human dignity shall be inviolable.",
              "It is the duty of all state authority to respect and protect it."
            ]
          }
        ],
        map: []
      },
      sources: {
        "https://www.gesetze-im-internet.de/gg/art_1.html": {
          title: "Basic Law Article 1",
          hostname: "gesetze-im-internet.de",
          age: []
        }
      }
    }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}

function requestBody(request: ReturnType<typeof vi.fn>, index = 0): Record<string, unknown> {
  const init = request.mock.calls[index]?.[1] as RequestInit | undefined;
  if (typeof init?.body !== "string") throw new Error("Expected JSON body.");
  return JSON.parse(init.body) as Record<string, unknown>;
}

function requestHeaders(request: ReturnType<typeof vi.fn>, index = 0): Record<string, string> {
  const value = (request.mock.calls[index]?.[1] as RequestInit | undefined)?.headers;
  if (!value || value instanceof Headers || Array.isArray(value)) {
    throw new Error("Expected object headers.");
  }
  return value;
}

describe("validateResearchQuery", () => {
  it("normalizes a safe query", () => {
    expect(validateResearchQuery("  Austrian   dangerous threat law  ", draft())).toBe(
      "Austrian dangerous threat law"
    );
  });

  it("rejects oversized, identifying, and URL-bearing queries", () => {
    expect(() => validateResearchQuery("x".repeat(401), draft())).toThrow(
      /400 characters/
    );
    expect(() =>
      validateResearchQuery(Array.from({ length: 51 }, () => "word").join(" "), draft())
    ).toThrow(/50 words/);
    expect(() => validateResearchQuery("user 123456789012345678", draft())).toThrow(
      /identifier/
    );
    expect(() =>
      validateResearchQuery("https://discord.com/channels/1/2/3", draft())
    ).toThrow(/URL/);
    expect(() => validateResearchQuery("contact person@example.test", draft())).toThrow(
      /email/
    );
  });

  it.each(["SensitiveUser law", "Sensitive Server law", "private-invite law"])(
    "rejects a known sensitive draft value in %s",
    (query) => {
      expect(() => validateResearchQuery(query, draft())).toThrow(/draft detail/);
    }
  );
});

describe("BraveResearchClient", () => {
  it("retrieves and compacts terminology snippets", async () => {
    const request = vi.fn().mockResolvedValue(termResponse());
    const client = new BraveResearchClient("brave-secret", {
      request: request as unknown as typeof fetch
    });

    const result = await client.search(
      "term",
      "meaning of coded term",
      "DE",
      Date.now() + 5_000,
      ACTOR
    );

    const url = new URL(String(request.mock.calls[0]?.[0]));
    expect(`${url.origin}${url.pathname}`).toBe(
      "https://api.search.brave.com/res/v1/web/search"
    );
    expect(url.searchParams.get("q")).toBe("meaning of coded term");
    expect(url.searchParams.get("count")).toBe("3");
    expect(url.searchParams.get("country")).toBe("DE");
    expect(requestHeaders(request)["X-Subscription-Token"]).toBe("brave-secret");
    expect(result).toEqual({
      kind: "term",
      query: "meaning of coded term",
      searchRequests: 1,
      sources: [
        {
          hostname: "dictionary.example",
          snippets: ["A useful definition of the coded term.", "A second contextual usage."],
          title: "Definition source",
          url: "https://dictionary.example/term"
        }
      ]
    });
  });

  it("retrieves focused legal passages through LLM Context", async () => {
    const request = vi.fn().mockResolvedValue(lawResponse());
    const client = new BraveResearchClient("brave-secret", {
      request: request as unknown as typeof fetch
    });

    const result = await client.search(
      "law",
      "Germany official Basic Law Article 1",
      "DE",
      Date.now() + 5_000,
      ACTOR
    );

    expect(request.mock.calls[0]?.[0]).toBe(
      "https://api.search.brave.com/res/v1/llm/context"
    );
    expect(requestBody(request)).toEqual({
      q: "Germany official Basic Law Article 1",
      country: "DE",
      count: 5,
      maximum_number_of_urls: 3,
      maximum_number_of_tokens: 2048,
      maximum_number_of_tokens_per_url: 1024,
      context_threshold_mode: "strict",
      enable_source_metadata: true,
      enable_local: false,
      goggles:
        "$boost=5,site=eur-lex.europa.eu\n$boost=5,site=e-justice.europa.eu\n$boost=5,site=n-lex.europa.eu"
    });
    expect(result.sources[0]).toEqual({
      hostname: "www.gesetze-im-internet.de",
      snippets: [
        "Human dignity shall be inviolable.",
        "It is the duty of all state authority to respect and protect it."
      ],
      title: "Basic Law Article 1",
      url: "https://www.gesetze-im-internet.de/gg/art_1.html"
    });
  });

  it.each([429, 500])("retries HTTP %s once and counts both requests", async (status) => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(new Response("temporary", { status }))
      .mockResolvedValueOnce(termResponse());
    const result = await new BraveResearchClient("key", {
      request: request as unknown as typeof fetch
    }).search("term", "coded term meaning", "DE", Date.now() + 5_000, ACTOR);

    expect(request).toHaveBeenCalledTimes(2);
    expect(result.searchRequests).toBe(2);
  });

  it("does not retry permanent errors", async () => {
    const request = vi.fn().mockResolvedValue(new Response("bad request", { status: 400 }));
    await expect(
      new BraveResearchClient("key", {
        request: request as unknown as typeof fetch
      }).search("law", "German law", "DE", Date.now() + 5_000, ACTOR)
    ).rejects.toMatchObject({ kind: "provider", searchRequests: 1 });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("rejects empty results and exhausted deadlines", async () => {
    const empty = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ web: { results: [] } }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      })
    );
    await expect(
      new BraveResearchClient("key", {
        request: empty as unknown as typeof fetch
      }).search("term", "unknown term", "DE", Date.now() + 5_000, ACTOR)
    ).rejects.toMatchObject({ kind: "empty", searchRequests: 1 });

    const never = vi.fn();
    await expect(
      new BraveResearchClient("key", {
        request: never as unknown as typeof fetch
      }).search("law", "German law", "DE", Date.now() - 1, ACTOR)
    ).rejects.toMatchObject({ kind: "timeout", searchRequests: 0 });
    expect(never).not.toHaveBeenCalled();
  });
});
