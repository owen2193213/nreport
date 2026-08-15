import { describe, expect, it, vi } from "vitest";

import {
  AiClient,
  type AiRequestContext,
  type AiClientError
} from "../src/ai-client.js";

const ACTOR: AiRequestContext = { actorKey: "actor-key", userId: "reporter-id" };
const FIREWORKS_MODEL = "accounts/fireworks/models/deepseek-v4-flash-0731";
const OPENROUTER_MODEL = "deepseek/deepseek-v4-flash-0731";

function success(
  content = '{"ok":true}',
  finishReason = "stop",
  reasoningTokens: number | null = 12
): Response {
  return new Response(
    JSON.stringify({
      id: "chatcmpl-safe-id",
      object: "chat.completion",
      created: 1,
      model: OPENROUTER_MODEL,
      choices: [
        {
          index: 0,
          finish_reason: finishReason,
          message: { role: "assistant", content, reasoning_content: "private reasoning" }
        }
      ],
      usage: {
        prompt_tokens: 120,
        completion_tokens: 35,
        total_tokens: 155,
        ...(reasoningTokens === null
          ? {}
          : { completion_tokens_details: { reasoning_tokens: reasoningTokens } })
      }
    }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}

function body(request: ReturnType<typeof vi.fn>): Record<string, unknown> {
  const init = request.mock.calls[0]?.[1] as RequestInit | undefined;
  if (typeof init?.body !== "string") throw new Error("Expected JSON body.");
  return JSON.parse(init.body) as Record<string, unknown>;
}

function headers(request: ReturnType<typeof vi.fn>): Record<string, string> {
  const value = (request.mock.calls[0]?.[1] as RequestInit | undefined)?.headers;
  if (!value || value instanceof Headers || Array.isArray(value)) {
    throw new Error("Expected object headers.");
  }
  return value;
}

describe("AiClient", () => {
  describe("OpenRouter provider", () => {
    it("sends requests to OpenRouter endpoint with required headers and DeepSeek V4 Flash", async () => {
      const request = vi.fn().mockResolvedValue(success());
      const client = new AiClient("openrouter-secret", OPENROUTER_MODEL, {
        provider: "openrouter",
        request: request as unknown as typeof fetch
      });

      const result = await client.complete(
        {
          messages: [{ role: "user", content: "Return JSON" }],
          max_completion_tokens: 8_192,
          reasoning_effort: "high"
        },
        Date.now() + 5_000,
        ACTOR,
        "plan"
      );

      expect(request.mock.calls[0]?.[0]).toBe(
        "https://openrouter.ai/api/v1/chat/completions"
      );
      const reqHeaders = headers(request);
      expect(reqHeaders.Authorization).toBe("Bearer openrouter-secret");
      expect(reqHeaders["HTTP-Referer"]).toBe("https://discord.com");
      expect(reqHeaders["X-Title"]).toBe("Discord DSA");
      expect(body(request)).toMatchObject({
        model: OPENROUTER_MODEL,
        max_completion_tokens: 8_192,
        reasoning_effort: "high",
        stream: false
      });
      expect(result).toEqual({
        content: '{"ok":true}',
        finishReason: "stop",
        usage: {
          costCredits: 0,
          inputTokens: 120,
          outputTokens: 35,
          reasoningTokens: 12,
          searchRequests: 0
        }
      });
    });
  });

  describe("Fireworks provider", () => {
    it("sends reasoning request directly to Fireworks endpoint", async () => {
      const request = vi.fn().mockResolvedValue(success());
      const client = new AiClient("fireworks-secret", FIREWORKS_MODEL, {
        provider: "fireworks",
        request: request as unknown as typeof fetch
      });

      const result = await client.complete(
        {
          messages: [{ role: "user", content: "Return JSON" }],
          max_completion_tokens: 8_192,
          reasoning_effort: "high"
        },
        Date.now() + 5_000,
        ACTOR,
        "plan"
      );

      expect(request.mock.calls[0]?.[0]).toBe(
        "https://api.fireworks.ai/inference/v1/chat/completions"
      );
      expect(headers(request).Authorization).toBe("Bearer fireworks-secret");
      expect(body(request)).toMatchObject({
        model: FIREWORKS_MODEL,
        max_completion_tokens: 8_192,
        reasoning_effort: "high",
        stream: false
      });
      expect(result).toEqual({
        content: '{"ok":true}',
        finishReason: "stop",
        usage: {
          costCredits: 0,
          inputTokens: 120,
          outputTokens: 35,
          reasoningTokens: 12,
          searchRequests: 0
        }
      });
    });
  });

  it("uses zero separate reasoning tokens when the response omits the detail", async () => {
    const request = vi.fn().mockResolvedValue(success('{"ok":true}', "stop", null));
    const result = await new AiClient("key", OPENROUTER_MODEL, {
      request: request as unknown as typeof fetch
    }).complete({ messages: [] }, Date.now() + 5_000, ACTOR, "synthesize");

    expect(result.usage.outputTokens).toBe(35);
    expect(result.usage.reasoningTokens).toBe(0);
  });

  it("rejects token-limit completions before returning truncated JSON", async () => {
    const request = vi.fn().mockResolvedValue(success('{"ok":', "length"));

    await expect(
      new AiClient("key", OPENROUTER_MODEL, {
        request: request as unknown as typeof fetch
      }).complete({}, Date.now() + 5_000, ACTOR, "plan")
    ).rejects.toMatchObject({ kind: "incomplete" });
  });

  it("rejects a refusal separately from malformed JSON", async () => {
    const request = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [
            {
              finish_reason: "stop",
              message: { role: "assistant", content: null, refusal: "Declined" }
            }
          ]
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );

    await expect(
      new AiClient("key", OPENROUTER_MODEL, {
        request: request as unknown as typeof fetch
      }).complete({ messages: [] }, Date.now() + 5_000, ACTOR, "synthesize")
    ).rejects.toMatchObject({ kind: "refusal" });
  });

  it.each([
    [429, "rate_limited"],
    [500, "provider"]
  ] as const)("maps HTTP %s to %s", async (status, kind) => {
    const request = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: { message: "sensitive provider text" } }), {
        status,
        headers: { "Content-Type": "application/json" }
      })
    );

    await expect(
      new AiClient("key", OPENROUTER_MODEL, {
        request: request as unknown as typeof fetch
      }).complete({}, Date.now() + 5_000, ACTOR, "plan")
    ).rejects.toMatchObject({ kind });
  });

  it.each([429, 500])("retries transient HTTP %s failures up to three attempts", async (status) => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(new Response("temporary", { status }))
      .mockResolvedValueOnce(new Response("temporary", { status }))
      .mockResolvedValueOnce(success());

    const result = await new AiClient("key", OPENROUTER_MODEL, {
      request: request as unknown as typeof fetch
    }).complete({}, Date.now() + 5_000, ACTOR, "synthesize");

    expect(request).toHaveBeenCalledTimes(3);
    expect(result.content).toBe('{"ok":true}');
  });

  it("retries transient network failures up to three attempts", async () => {
    const request = vi
      .fn()
      .mockRejectedValueOnce(new Error("temporary network failure"))
      .mockRejectedValueOnce(new Error("temporary network failure"))
      .mockResolvedValueOnce(success());

    const result = await new AiClient("key", OPENROUTER_MODEL, {
      request: request as unknown as typeof fetch
    }).complete({}, Date.now() + 5_000, ACTOR, "synthesize");

    expect(request).toHaveBeenCalledTimes(3);
    expect(result.content).toBe('{"ok":true}');
  });

  it("does not retry malformed provider payloads", async () => {
    const request = vi.fn().mockResolvedValue(
      new Response("not-json", {
        status: 200,
        headers: { "Content-Type": "text/plain" }
      })
    );

    await expect(
      new AiClient("key", OPENROUTER_MODEL, {
        request: request as unknown as typeof fetch
      }).complete({}, Date.now() + 5_000, ACTOR, "plan")
    ).rejects.toMatchObject({ kind: "malformed" });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("rejects exhausted deadlines without making a request", async () => {
    const request = vi.fn();
    const client = new AiClient("key", OPENROUTER_MODEL, {
      request: request as unknown as typeof fetch
    });

    await expect(client.complete({}, Date.now() - 1, ACTOR, "refine")).rejects.toEqual(
      expect.objectContaining<Partial<AiClientError>>({ kind: "timeout" })
    );
    expect(request).not.toHaveBeenCalled();
  });
});
