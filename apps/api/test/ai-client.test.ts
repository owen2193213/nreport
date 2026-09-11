import { describe, expect, it, vi } from "vitest";

import {
  AiClient,
  type AiRequestContext,
  type AiClientError
} from "../src/preparation/ai-client.js";

const ACTOR: AiRequestContext = { traceId: "33333333-3333-4333-8333-333333333333", userId: "reporter-id" };
const CEREBRAS_MODEL = "qwen-3.8-27b";

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
      model: CEREBRAS_MODEL,
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
  describe("Cerebras transport", () => {
    it("sends reasoning requests to Cerebras with the bounded completion budget", async () => {
      const request = vi.fn().mockResolvedValue(success());
      const client = new AiClient("ai-secret", CEREBRAS_MODEL, {
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
        "https://api.cerebras.ai/v1/chat/completions"
      );
      expect(headers(request).Authorization).toBe("Bearer ai-secret");
      expect(headers(request)["HTTP-Referer"]).toBeUndefined();
      expect(headers(request)["X-Title"]).toBeUndefined();
      expect(body(request)).toMatchObject({
        model: CEREBRAS_MODEL,
        max_completion_tokens: 3_000,
        reasoning_effort: "high",
        stream: false
      });
      expect(body(request).provider).toBeUndefined();
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

    it("handles upstream error objects in response payloads", async () => {
      const canary = "CANARY_UNSAFE_PROVIDER_CAUSE";
      const request = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            error: { message: canary, code: 504 }
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      );

      await expect(
        new AiClient("key", CEREBRAS_MODEL, {
          request: request as unknown as typeof fetch
        }).complete({}, Date.now() + 5_000, ACTOR, "plan")
      ).rejects.toMatchObject({
        kind: "provider",
        message: "Cerebras returned an upstream error."
      });
    });
  });

  it("uses zero separate reasoning tokens when the response omits the detail", async () => {
    const request = vi.fn().mockResolvedValue(success('{"ok":true}', "stop", null));
    const result = await new AiClient("key", CEREBRAS_MODEL, {
      request: request as unknown as typeof fetch
    }).complete({ messages: [] }, Date.now() + 5_000, ACTOR, "synthesize");

    expect(result.usage.outputTokens).toBe(35);
    expect(result.usage.reasoningTokens).toBe(0);
  });

  it("rejects token-limit completions before returning truncated JSON", async () => {
    const request = vi.fn().mockResolvedValue(success('{"ok":', "length"));

    await expect(
      new AiClient("key", CEREBRAS_MODEL, {
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
      new AiClient("key", CEREBRAS_MODEL, {
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
      new AiClient("key", CEREBRAS_MODEL, {
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

    const result = await new AiClient("key", CEREBRAS_MODEL, {
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

    const result = await new AiClient("key", CEREBRAS_MODEL, {
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
      new AiClient("key", CEREBRAS_MODEL, {
        request: request as unknown as typeof fetch
      }).complete({}, Date.now() + 5_000, ACTOR, "plan")
    ).rejects.toMatchObject({ kind: "malformed" });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("rejects exhausted deadlines without making a request", async () => {
    const request = vi.fn();
    const client = new AiClient("key", CEREBRAS_MODEL, {
      request: request as unknown as typeof fetch
    });

    await expect(client.complete({}, Date.now() - 1, ACTOR, "refine")).rejects.toEqual(
      expect.objectContaining<Partial<AiClientError>>({ kind: "timeout" })
    );
    expect(request).not.toHaveBeenCalled();
  });

  it("serializes only bounded provider failure metadata", async () => {
    const canary = "CANARY_PROVIDER_BODY_AND_REASONING";
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const request = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: { message: canary, code: `secret-${canary}` },
          reasoning: canary
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );

    await expect(
      new AiClient("key", CEREBRAS_MODEL, {
        request: request as unknown as typeof fetch
      }).complete({}, Date.now() + 5_000, ACTOR, "plan")
    ).rejects.toMatchObject({ kind: "provider" });

    const serialized = write.mock.calls.map(([line]) => String(line)).join("");
    expect(serialized).not.toContain(canary);
    expect(JSON.parse(serialized)).toMatchObject({
      event: "ai_request_failed",
      traceId: ACTOR.traceId,
      outcome: "failed",
      durationMs: expect.any(Number) as number,
      failureCategory: "provider",
      providerCodeCategory: "string",
      stage: "plan"
    });
    expect(JSON.parse(serialized)).not.toHaveProperty("actorKey");
  });

  it("honors an already-aborted caller signal without making a request", async () => {
    const request = vi.fn();
    const controller = new AbortController();
    const reason = new DOMException("Preparation cancelled", "AbortError");
    controller.abort(reason);

    await expect(
      new AiClient("key", CEREBRAS_MODEL, {
        request: request as unknown as typeof fetch
      }).complete({}, Date.now() + 5_000, ACTOR, "plan", controller.signal)
    ).rejects.toBe(reason);
    expect(request).not.toHaveBeenCalled();
  });

  it("aborts an active request once and releases its request listener", async () => {
    const controller = new AbortController();
    const reason = new DOMException("Preparation cancelled", "AbortError");
    let activeListeners = 0;
    const request = vi.fn((_url: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        const requestSignal = init?.signal;
        if (!requestSignal) throw new Error("Expected a request signal.");
        activeListeners += 1;
        requestSignal.addEventListener("abort", () => {
          activeListeners -= 1;
          reject(requestSignal.reason instanceof Error ? requestSignal.reason : new Error("Request aborted."));
        }, { once: true });
      }));
    const running = new AiClient("key", CEREBRAS_MODEL, {
      request: request as unknown as typeof fetch
    }).complete({}, Date.now() + 5_000, ACTOR, "plan", controller.signal);
    await vi.waitFor(() => expect(activeListeners).toBe(1));

    controller.abort(reason);

    await expect(running).rejects.toBe(reason);
    expect(activeListeners).toBe(0);
    expect(request).toHaveBeenCalledOnce();
  });

  it("categorizes an untrusted finish reason without logging it", async () => {
    const canary = "CANARY_MALICIOUS_FINISH_REASON";
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const request = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ finish_reason: canary, message: { content: null, refusal: "declined" } }]
    }), { status: 200, headers: { "Content-Type": "application/json" } }));

    await expect(new AiClient("key", CEREBRAS_MODEL, {
      request: request as unknown as typeof fetch
    }).complete({}, Date.now() + 5_000, ACTOR, "plan")).rejects.toMatchObject({ kind: "refusal" });

    const lines = write.mock.calls.map(([line]) => String(line));
    const serialized = lines.join("");
    expect(serialized).not.toContain(canary);
    const event = lines
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((record) => record.failureCategory === "refusal");
    expect(event).toMatchObject({ finishReasonCategory: "other" });
  });
});
