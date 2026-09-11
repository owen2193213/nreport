import {
  preparationLog as botLog,
  providerCodeCategory,
  providerFinishReasonCategory,
  requestAbortSignal,
  responseSize,
  type ProviderFinishReasonCategory
} from "./observability.js";
import type { AiUsage } from "./types.js";

export const CEREBRAS_CHAT_COMPLETIONS_URL =
  "https://api.cerebras.ai/v1/chat/completions";
export const MAX_COMPLETION_TOKENS = 3_000;
const REQUEST_TIMEOUT_MS = 150_000;

export interface AiRequestContext {
  userId: string;
  traceId: string;
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
    return CEREBRAS_CHAT_COMPLETIONS_URL;
  }

  public get providerName(): string {
    return "Cerebras";
  }

  public async complete(
    body: Record<string, unknown>,
    deadline: number,
    actor: AiRequestContext,
    stage: AiStage,
    signal?: AbortSignal
  ): Promise<AiCompletion> {
    const requestedMaxCompletionTokens = body.max_completion_tokens;
    const maxCompletionTokens =
      typeof requestedMaxCompletionTokens === "number" &&
      Number.isFinite(requestedMaxCompletionTokens)
        ? Math.max(1, Math.min(MAX_COMPLETION_TOKENS, Math.floor(requestedMaxCompletionTokens)))
        : MAX_COMPLETION_TOKENS;
    const requestBody: Record<string, unknown> = {
      ...body,
      max_completion_tokens: maxCompletionTokens,
      model: this.model,
      stream: false
    };
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      "Content-Type": "application/json"
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
        this.logFailure(
          actor,
          stage,
          Date.now() - startedAt,
          "provider",
          response.status,
          { providerCodeCategory: providerCodeCategory(payload.error.code) },
          attempts
        );
        throw new AiClientError("provider", `${this.providerName} returned an upstream error.`);
      }

      const choice = payload.choices?.[0];
      if (choice?.message?.refusal) {
        this.logFailure(
          actor,
          stage,
          Date.now() - startedAt,
          "refusal",
          response.status,
          { finishReasonCategory: providerFinishReasonCategory(choice.finish_reason) },
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
            finishReasonCategory: "length",
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
            finishReasonCategory: providerFinishReasonCategory(choice?.finish_reason),
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
        attempts,
        costCredits: 0,
        finishReason,
        inputTokens: usage.inputTokens,
        durationMs: Date.now() - startedAt,
        model: this.model,
        outputTokens: usage.outputTokens,
        provider: "cerebras",
        reasoningTokens: usage.reasoningTokens,
        responseLength: choice.message.content.length,
        searchRequests: 0,
        stage,
        outcome: "completed",
        traceId: actor.traceId
      });
      return { content: choice.message.content, finishReason, usage };
    }
  }

  private logFailure(
    actor: AiRequestContext,
    stage: AiStage,
    durationMs: number,
    failureCategory: AiClientErrorKind,
    httpStatus?: number,
    metadata?: {
      finishReasonCategory?: ProviderFinishReasonCategory;
      providerCodeCategory?: "missing" | "number" | "string" | "other";
      responseSize?: number;
    },
    attempts?: number
  ): void {
    botLog(
      "ai_request_failed",
      {
        failureCategory,
        ...(httpStatus === undefined ? {} : { httpStatus }),
        durationMs,
        model: this.model,
        provider: "cerebras",
        stage,
        outcome: "failed",
        ...(attempts === undefined ? {} : { attempts }),
        traceId: actor.traceId,
        ...metadata
      },
      "warn"
    );
  }
}

