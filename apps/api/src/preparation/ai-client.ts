import {
  preparationLog as botLog,
  providerCodeCategory,
  requestAbortSignal,
  responseSize
} from "./observability.js";
import type { AiUsage } from "./types.js";

export const OPENROUTER_CHAT_COMPLETIONS_URL =
  "https://openrouter.ai/api/v1/chat/completions";
const REQUEST_TIMEOUT_MS = 150_000;

export interface AiRequestContext {
  actorKey: string;
  userId: string;
  traceId?: string;
}

export type AiStage = "plan" | "synthesize" | "refine";

export interface AiCompletion {
  content: string;
  finishReason: string;
  usage: AiUsage;
}

interface ChatCompletionResponse {
  error?: { message?: unknown; code?: unknown };
  choices?: Array<{
    finish_reason?: unknown;
    message?: { content?: unknown; refusal?: unknown };
  }>;
  usage?: {
    prompt_tokens?: unknown;
    completion_tokens?: unknown;
    completion_tokens_details?: { reasoning_tokens?: unknown };
    cost?: unknown;
  };
}

export type AiClientErrorKind =
  | "network"
  | "rate_limited"
  | "refusal"
  | "provider"
  | "malformed"
  | "incomplete"
  | "timeout";

export class AiClientError extends Error {
  public constructor(
    public readonly kind: AiClientErrorKind,
    message: string
  ) {
    super(message);
    this.name = "AiClientError";
  }
}

function numeric(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function usageFrom(value: ChatCompletionResponse["usage"]): AiUsage {
  return {
    costCredits: 0,
    inputTokens: numeric(value?.prompt_tokens),
    outputTokens: numeric(value?.completion_tokens),
    reasoningTokens: numeric(value?.completion_tokens_details?.reasoning_tokens),
    searchRequests: 0
  };
}

export interface AiClientOptions {
  request?: typeof globalThis.fetch;
}

export class AiClient {
  private readonly request: typeof globalThis.fetch;

  public constructor(
    private readonly apiKey: string,
    private readonly model: string,
    options: AiClientOptions = {}
  ) {
    this.request = options.request ?? globalThis.fetch;
  }

  public get endpoint(): string {
    return OPENROUTER_CHAT_COMPLETIONS_URL;
  }

  public get providerName(): string {
    return "OpenRouter";
  }

  public async complete(
    body: Record<string, unknown>,
    deadline: number,
    actor: AiRequestContext,
    stage: AiStage,
    signal?: AbortSignal
  ): Promise<AiCompletion> {
    const requestBody: Record<string, unknown> = {
      ...body,
      model: this.model,
      stream: false
    };
    if (!body.provider) requestBody.provider = { allow_fallbacks: true };
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://discord.com",
      "X-Title": "Discord DSA"
    };
    let attempts = 0;
    for (;;) {
      if (signal?.aborted) throw signal.reason;
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        this.logFailure(actor, stage, 0, "timeout");
        throw new AiClientError("timeout", "The AI workflow deadline was exceeded.");
      }

      attempts += 1;
      const startedAt = Date.now();
      let response: Response;
      try {
        response = await this.request(this.endpoint, {
          method: "POST",
          headers,
          body: JSON.stringify(requestBody),
          signal: requestAbortSignal(deadline, REQUEST_TIMEOUT_MS, signal)
        });
      } catch (fetchError) {
        if (signal?.aborted) throw signal.reason;
        const isTimeout =
          fetchError instanceof Error &&
          (fetchError.name === "TimeoutError" || fetchError.name === "AbortError");
        const failureCategory = isTimeout ? "timeout" : "network";
        this.logFailure(
          actor,
          stage,
          Date.now() - startedAt,
          failureCategory,
          undefined,
          undefined,
          attempts
        );
        if (attempts < 3 && deadline > Date.now()) continue;
        throw new AiClientError(
          failureCategory,
          isTimeout
            ? `${this.providerName} request timed out after ${Math.round((Date.now() - startedAt) / 1000)}s.`
            : `${this.providerName} could not be reached.`
        );
      }

      if (!response.ok) {
        const kind = response.status === 429 ? "rate_limited" : "provider";
        const size = responseSize(response);
        this.logFailure(
          actor,
          stage,
          Date.now() - startedAt,
          kind,
          response.status,
          size === undefined ? undefined : { responseSize: size },
          attempts
        );
        const retryable = response.status === 429 || response.status >= 500;
        if (attempts < 3 && retryable && deadline > Date.now()) continue;
        throw new AiClientError(
          kind,
          response.status === 429
            ? `${this.providerName} is rate limited.`
            : `${this.providerName} is unavailable.`
        );
      }

      let payload: ChatCompletionResponse;
      try {
        payload = (await response.json()) as ChatCompletionResponse;
      } catch {
        const size = responseSize(response);
        this.logFailure(
          actor,
          stage,
          Date.now() - startedAt,
          "malformed",
          response.status,
          size === undefined ? undefined : { responseSize: size },
          attempts
        );
        throw new AiClientError("malformed", `${this.providerName} returned malformed JSON.`);
      }

      if (payload.error) {
        const errorMessage =
          typeof payload.error.message === "string"
            ? payload.error.message
            : `${this.providerName} returned an upstream error.`;
        this.logFailure(
          actor,
          stage,
          Date.now() - startedAt,
          "provider",
          response.status,
          { providerCodeCategory: providerCodeCategory(payload.error.code) },
          attempts
        );
        throw new AiClientError("provider", errorMessage);
      }

      const choice = payload.choices?.[0];
      if (choice?.message?.refusal) {
        this.logFailure(
          actor,
          stage,
          Date.now() - startedAt,
          "refusal",
          response.status,
          { finishReason: typeof choice.finish_reason === "string" ? choice.finish_reason : "unknown" },
          attempts
        );
        throw new AiClientError("refusal", "The model declined the request.");
      }
      if (choice?.finish_reason === "length") {
        this.logFailure(
          actor,
          stage,
          Date.now() - startedAt,
          "incomplete",
          response.status,
          {
            finishReason: "length",
            responseSize: JSON.stringify(payload).length
          },
          attempts
        );
        throw new AiClientError(
          "incomplete",
          `${this.providerName} exhausted the completion budget.`
        );
      }
      if (typeof choice?.message?.content !== "string" || !choice.message.content.trim()) {
        this.logFailure(
          actor,
          stage,
          Date.now() - startedAt,
          "malformed",
          response.status,
          {
            finishReason: typeof choice?.finish_reason === "string" ? choice.finish_reason : "unknown",
            responseSize: JSON.stringify(payload).length
          },
          attempts
        );
        throw new AiClientError("malformed", `${this.providerName} returned no completion.`);
      }

      const usage = usageFrom(payload.usage);
      const finishReason =
        typeof choice.finish_reason === "string" ? choice.finish_reason : "unknown";
      botLog("ai_request_completed", {
        actorKey: actor.actorKey,
        attempts,
        costCredits: 0,
        finishReason,
        inputTokens: usage.inputTokens,
        latencyMs: Date.now() - startedAt,
        model: this.model,
        outputTokens: usage.outputTokens,
        provider: "openrouter",
        reasoningTokens: usage.reasoningTokens,
        responseLength: choice.message.content.length,
        searchRequests: 0,
        stage
      });
      return { content: choice.message.content, finishReason, usage };
    }
  }

  private logFailure(
    actor: AiRequestContext,
    stage: AiStage,
    latencyMs: number,
    failureCategory: AiClientErrorKind,
    httpStatus?: number,
    metadata?: {
      finishReason?: string;
      providerCodeCategory?: "missing" | "number" | "string" | "other";
      responseSize?: number;
    },
    attempts?: number
  ): void {
    botLog(
      "ai_request_failed",
      {
        actorKey: actor.actorKey,
        failureCategory,
        ...(httpStatus === undefined ? {} : { httpStatus }),
        latencyMs,
        model: this.model,
        provider: "openrouter",
        stage,
        ...(attempts === undefined ? {} : { attempts }),
        ...(actor.traceId === undefined ? {} : { traceId: actor.traceId }),
        ...metadata
      },
      "warn"
    );
  }
}

