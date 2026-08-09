import { botLog } from "./observability.js";
import type { AiUsage } from "./types.js";

const GROQ_CHAT_COMPLETIONS_URL = "https://api.groq.com/openai/v1/chat/completions";
const REQUEST_TIMEOUT_MS = 45_000;

export interface AiRequestContext {
  actorKey: string;
  userId: string;
}

export type GroqStage = "plan" | "synthesize" | "refine";

export interface GroqCompletion {
  content: string;
  finishReason: string;
  usage: AiUsage;
}

interface GroqResponse {
  choices?: Array<{
    finish_reason?: unknown;
    message?: { content?: unknown; refusal?: unknown };
  }>;
  usage?: {
    prompt_tokens?: unknown;
    completion_tokens?: unknown;
    completion_tokens_details?: { reasoning_tokens?: unknown };
  };
}

export type GroqClientErrorKind =
  | "network"
  | "rate_limited"
  | "refusal"
  | "provider"
  | "malformed"
  | "timeout";

export class GroqClientError extends Error {
  public constructor(
    public readonly kind: GroqClientErrorKind,
    message: string
  ) {
    super(message);
    this.name = "GroqClientError";
  }
}

function numeric(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function usageFrom(value: GroqResponse["usage"]): AiUsage {
  return {
    costCredits: 0,
    inputTokens: numeric(value?.prompt_tokens),
    outputTokens: numeric(value?.completion_tokens),
    reasoningTokens: numeric(value?.completion_tokens_details?.reasoning_tokens),
    searchRequests: 0
  };
}

export class GroqClient {
  private readonly request: typeof globalThis.fetch;

  public constructor(
    private readonly apiKey: string,
    private readonly model: string,
    options: { request?: typeof globalThis.fetch } = {}
  ) {
    this.request = options.request ?? globalThis.fetch;
  }

  public async complete(
    body: Record<string, unknown>,
    deadline: number,
    actor: AiRequestContext,
    stage: GroqStage
  ): Promise<GroqCompletion> {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      this.logFailure(actor, stage, 0, "timeout");
      throw new GroqClientError("timeout", "The AI workflow deadline was exceeded.");
    }

    const requestBody = {
      ...body,
      model: this.model,
      reasoning_effort: "low",
      stream: false
    };
    const startedAt = Date.now();
    let response: Response;
    try {
      response = await this.request(GROQ_CHAT_COMPLETIONS_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(requestBody),
        signal: AbortSignal.timeout(Math.min(REQUEST_TIMEOUT_MS, remaining))
      });
    } catch {
      this.logFailure(actor, stage, Date.now() - startedAt, "network");
      throw new GroqClientError("network", "Groq could not be reached.");
    }

    if (!response.ok) {
      const kind = response.status === 429 ? "rate_limited" : "provider";
      this.logFailure(actor, stage, Date.now() - startedAt, kind, response.status);
      throw new GroqClientError(
        kind,
        response.status === 429 ? "Groq is rate limited." : "Groq is unavailable."
      );
    }

    let payload: GroqResponse;
    try {
      payload = (await response.json()) as GroqResponse;
    } catch {
      this.logFailure(actor, stage, Date.now() - startedAt, "malformed");
      throw new GroqClientError("malformed", "Groq returned malformed JSON.");
    }

    const choice = payload.choices?.[0];
    if (choice?.message?.refusal) {
      this.logFailure(actor, stage, Date.now() - startedAt, "refusal");
      throw new GroqClientError("refusal", "The model declined the request.");
    }
    if (typeof choice?.message?.content !== "string" || !choice.message.content.trim()) {
      this.logFailure(actor, stage, Date.now() - startedAt, "malformed");
      throw new GroqClientError("malformed", "Groq returned no completion.");
    }

    const usage = usageFrom(payload.usage);
    const finishReason =
      typeof choice.finish_reason === "string" ? choice.finish_reason : "unknown";
    botLog("ai_request_completed", {
      actorKey: actor.actorKey,
      costCredits: 0,
      finishReason,
      inputTokens: usage.inputTokens,
      latencyMs: Date.now() - startedAt,
      model: this.model,
      outputTokens: usage.outputTokens,
      reasoningTokens: usage.reasoningTokens,
      responseLength: choice.message.content.length,
      searchRequests: 0,
      stage
    });
    return { content: choice.message.content, finishReason, usage };
  }

  private logFailure(
    actor: AiRequestContext,
    stage: GroqStage,
    latencyMs: number,
    failureCategory: GroqClientErrorKind,
    httpStatus?: number
  ): void {
    botLog(
      "ai_request_failed",
      {
        actorKey: actor.actorKey,
        failureCategory,
        ...(httpStatus === undefined ? {} : { httpStatus }),
        latencyMs,
        model: this.model,
        stage
      },
      "warn"
    );
  }
}
