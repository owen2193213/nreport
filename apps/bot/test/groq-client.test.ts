import { describe, expect, it, vi } from "vitest";

import {
  GroqClient,
  type GroqClientError,
  type AiRequestContext
} from "../src/groq-client.js";

const ACTOR: AiRequestContext = { actorKey: "actor-key", userId: "reporter-id" };

function success(content = '{"ok":true}'): Response {
  return new Response(
    JSON.stringify({
      id: "chatcmpl-safe-id",
      object: "chat.completion",
      created: 1,
      model: "openai/gpt-oss-120b",
      choices: [
        {
          index: 0,
          finish_reason: "stop",
          message: { role: "assistant", content, refusal: null }
        }
      ],
      usage: {
        prompt_tokens: 120,
        completion_tokens: 35,
        total_tokens: 155,
        completion_tokens_details: { reasoning_tokens: 12 }
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

describe("GroqClient", () => {
  it("sends a low-reasoning strict completion directly to Groq", async () => {
    const request = vi.fn().mockResolvedValue(success());
    const client = new GroqClient("groq-secret", "openai/gpt-oss-120b", {
      request: request as unknown as typeof fetch
    });

    const result = await client.complete(
      {
        messages: [{ role: "user", content: "Return JSON" }],
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "boolean_result",
            strict: true,
            schema: {
              type: "object",
              properties: { ok: { type: "boolean" } },
              required: ["ok"],
              additionalProperties: false
            }
          }
        }
      },
      Date.now() + 5_000,
      ACTOR,
      "plan"
    );

    expect(request.mock.calls[0]?.[0]).toBe(
      "https://api.groq.com/openai/v1/chat/completions"
    );
    expect(headers(request).Authorization).toBe("Bearer groq-secret");
    expect(body(request)).toMatchObject({
      model: "openai/gpt-oss-120b",
      reasoning_effort: "low",
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

  it("rejects a model refusal separately from malformed JSON", async () => {
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
      new GroqClient("key", "model", {
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
      new GroqClient("key", "model", {
        request: request as unknown as typeof fetch
      }).complete({ messages: [] }, Date.now() + 5_000, ACTOR, "plan")
    ).rejects.toMatchObject({ kind });
  });

  it.each([429, 500])("retries transient HTTP %s failures once", async (status) => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(new Response("temporary", { status }))
      .mockResolvedValueOnce(success());
    const result = await new GroqClient("key", "model", {
      request: request as unknown as typeof fetch
    }).complete({ messages: [] }, Date.now() + 5_000, ACTOR, "synthesize");

    expect(request).toHaveBeenCalledTimes(2);
    expect(result.content).toBe('{"ok":true}');
  });

  it("retries a transient network failure once", async () => {
    const request = vi
      .fn()
      .mockRejectedValueOnce(new Error("temporary network failure"))
      .mockResolvedValueOnce(success());
    const result = await new GroqClient("key", "model", {
      request: request as unknown as typeof fetch
    }).complete({ messages: [] }, Date.now() + 5_000, ACTOR, "synthesize");

    expect(request).toHaveBeenCalledTimes(2);
    expect(result.content).toBe('{"ok":true}');
  });

  it("rejects malformed and missing completion payloads", async () => {
    const malformed = vi.fn().mockResolvedValue(
      new Response("not-json", { status: 200, headers: { "Content-Type": "text/plain" } })
    );
    await expect(
      new GroqClient("key", "model", {
        request: malformed as unknown as typeof fetch
      }).complete({}, Date.now() + 5_000, ACTOR, "plan")
    ).rejects.toMatchObject({ kind: "malformed" });

    const missing = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ choices: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      })
    );
    await expect(
      new GroqClient("key", "model", {
        request: missing as unknown as typeof fetch
      }).complete({}, Date.now() + 5_000, ACTOR, "plan")
    ).rejects.toMatchObject({ kind: "malformed" });
  });

  it("rejects exhausted deadlines without making a request", async () => {
    const request = vi.fn();
    const client = new GroqClient("key", "model", {
      request: request as unknown as typeof fetch
    });

    await expect(client.complete({}, Date.now() - 1, ACTOR, "refine")).rejects.toEqual(
      expect.objectContaining<Partial<GroqClientError>>({ kind: "timeout" })
    );
    expect(request).not.toHaveBeenCalled();
  });

  it("maps fetch failures to a safe network error", async () => {
    const request = vi.fn().mockRejectedValue(new Error("secret network detail"));
    await expect(
      new GroqClient("key", "model", {
        request: request as unknown as typeof fetch
      }).complete({}, Date.now() + 5_000, ACTOR, "plan")
    ).rejects.toMatchObject({ kind: "network" });
  });
});
