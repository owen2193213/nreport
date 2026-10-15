import {
  preparationLog as botLog,
  providerCodeCategory,
  providerFinishReasonCategory,
  requestAbortSignal,
  responseSize,
  type ProviderFinishReasonCategory
} from "./observability.js";
import { safeErrorSummary } from "@nreport/observability";
import type { AiUsage } from "./types.js";

export const CEREBRAS_CHAT_COMPLETIONS_URL =
  "https://api.cerebras.ai/v1/chat/completions";
export const MAX_COMPLETION_TOKENS = 3_000;
const REQUEST_TIMEOUT_MS = 150_000;
const MAX_PROVIDER_ERROR_BYTES = 4_096;
const MAX_PROVIDER_ERROR_FIELD_CHARACTERS = 512;

export interface AiRequestContext {
  userId: string;
  reportId: string;
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
  | "payment_required"
  | "refusal"
  | "provider"
  | "malformed"
  | "incomplete"
  | "timeout";

export class AiClientError extends Error {
  public constructor(
    public readonly kind: AiClientErrorKind,
    message: string,
    options: {
      cause?: unknown;
      stage?: AiStage;
      httpStatus?: number;
      providerMessage?: string;
      providerCode?: string;
    } = {}
  ) {
    super(message, options);
    this.name = "AiClientError";
    this.stage = options.stage;
    this.httpStatus = options.httpStatus;
    this.providerMessage = options.providerMessage;
    this.providerCode = options.providerCode;
  }

  public readonly stage: AiStage | undefined;
  public readonly httpStatus: number | undefined;
  public readonly providerMessage: string | undefined;
  public readonly providerCode: string | undefined;
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

export type AiClientSleep = (milliseconds: number, signal?: AbortSignal) => Promise<void>;

export interface AiClientOptions {
  request?: typeof globalThis.fetch;
  sleep?: AiClientSleep;
}

function defaultSleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const rejectAbort: (reason: unknown) => void = reject;
    if (signal?.aborted) {
      rejectAbort(signal.reason);
      return;
    }
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve();
    };
    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rejectAbort(signal?.reason);
    };
    const timer = setTimeout(finish, milliseconds);
    timer.unref?.();
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function retryAfterSecondsFromHeader(response: Response): number | undefined {
  const header = response.headers.get("retry-after");
  if (header === null) return undefined;
  const trimmed = header.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) return undefined;
  const value = Number(trimmed);
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

async function boundedResponseText(response: Response): Promise<{ text: string; truncated: boolean }> {
  const reader = response.body?.getReader();
  if (reader === undefined) return { text: "", truncated: false };
  const decoder = new TextDecoder();
  let text = "";
  let bytesRead = 0;
  let done = false;
  let truncated = false;
  try {
    while (bytesRead < MAX_PROVIDER_ERROR_BYTES) {
      const chunk = await reader.read();
      if (chunk.done) {
        done = true;
        break;
      }
      const remaining = MAX_PROVIDER_ERROR_BYTES - bytesRead;
      const bytes = chunk.value.subarray(0, remaining);
      bytesRead += bytes.byteLength;
      text += decoder.decode(bytes, { stream: true });
      if (bytes.byteLength < chunk.value.byteLength) {
        truncated = true;
        break;
      }
    }
    if (bytesRead >= MAX_PROVIDER_ERROR_BYTES) truncated = true;
    text += decoder.decode();
  } catch {
    truncated = true;
  } finally {
    if (!done) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  return { text, truncated };
}

function safeProviderField(value: unknown): string | undefined {
  if (typeof value !== "string" || value.trim() === "") return undefined;
  const summary = safeErrorSummary(new Error(value));
  return summary.message.slice(0, MAX_PROVIDER_ERROR_FIELD_CHARACTERS) || undefined;
}

function providerFailureDetails(text: string): { providerMessage?: string; providerCode?: string } {
  if (text === "") return {};
  try {
    const payload: unknown = JSON.parse(text);
    if (typeof payload === "object" && payload !== null && "error" in payload) {
      const upstreamError = payload.error;
      if (typeof upstreamError === "object" && upstreamError !== null) {
        const record = upstreamError as { message?: unknown; code?: unknown };
        const providerMessage = safeProviderField(record.message);
        const providerCode = safeProviderField(typeof record.code === "string" ? record.code : undefined);
        if (providerMessage !== undefined || providerCode !== undefined) {
          return {
            ...(providerMessage === undefined ? {} : { providerMessage }),
            ...(providerCode === undefined ? {} : { providerCode })
          };
        }
      }
    }
  } catch {
    // Unstructured bodies may contain echoed request content; preserve only allowlisted error fields.
  }
  return {};
}

export class AiClient {
  private readonly request: typeof globalThis.fetch;
  private readonly sleep: AiClientSleep;

  public constructor(
    private readonly apiKey: string,
    private readonly model: string,
    options: AiClientOptions = {}
  ) {
    this.request = options.request ?? globalThis.fetch;
    this.sleep = options.sleep ?? defaultSleep;
  }

  /**
   * Waits before a retry, honoring a numeric Retry-After (seconds) when given,
   * else exponential backoff (1s, then 2s) with small jitter. Returns false
   * without sleeping when the wait would cross the workflow deadline, so the
   * caller can give up instead of retrying past it.
   */
  private async waitBeforeRetry(
    attempt: number,
    deadline: number,
    signal?: AbortSignal,
    retryAfterSeconds?: number
  ): Promise<boolean> {
    const base =
      retryAfterSeconds !== undefined ? retryAfterSeconds * 1_000 : attempt === 1 ? 1_000 : 2_000;
    const delayMs = base + Math.random() * base * 0.2;
    if (delayMs > deadline - Date.now()) return false;
    await this.sleep(delayMs, signal);
    return true;
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
        if (attempts < 3 && deadline > Date.now() && (await this.waitBeforeRetry(attempts, deadline, signal))) {
          continue;
        }
        throw new AiClientError(
          failureCategory,
          isTimeout
            ? `${this.providerName} request timed out after ${Math.round((Date.now() - startedAt) / 1000)}s.`
            : `${this.providerName} could not be reached.`,
          { cause: fetchError, stage }
        );
      }

      if (!response.ok) {
        const kind = response.status === 402
          ? "payment_required"
          : response.status === 429 ? "rate_limited" : "provider";
        const size = responseSize(response);
        const body = await boundedResponseText(response);
        const failureDetails = providerFailureDetails(body.text);
        this.logFailure(
          actor,
          stage,
          Date.now() - startedAt,
          kind,
          response.status,
          {
            ...(size === undefined ? {} : { responseSize: size }),
            ...(body.truncated ? { providerErrorTruncated: true } : {}),
            ...failureDetails
          },
          attempts
        );
        const retryable = response.status === 429 || response.status >= 500;
        if (
          attempts < 3 &&
          retryable &&
          deadline > Date.now() &&
          (await this.waitBeforeRetry(attempts, deadline, signal, retryAfterSecondsFromHeader(response)))
        ) {
          continue;
        }
        const upstreamMessage = failureDetails.providerMessage;
        const safeMessage = upstreamMessage === undefined
          ? response.status === 402
            ? `${this.providerName} requires payment for this request.`
            : response.status === 429
            ? `${this.providerName} is rate limited.`
            : `${this.providerName} is unavailable.`
          : `${this.providerName} returned HTTP ${response.status}: ${upstreamMessage}`;
        throw new AiClientError(
          kind,
          safeMessage,
          {
            cause: new Error(`${this.providerName} returned HTTP ${response.status}.`),
            stage,
            httpStatus: response.status,
            ...failureDetails
          }
        );
      }

      let payload: ChatCompletionResponse;
      try {
        payload = (await response.json()) as ChatCompletionResponse;
      } catch (error) {
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
        throw new AiClientError("malformed", `${this.providerName} returned malformed JSON.`, {
          cause: error, stage, httpStatus: response.status
        });
      }

      if (payload.error) {
        const providerMessage = safeProviderField(payload.error.message);
        const providerCode = safeProviderField(typeof payload.error.code === "string" ? payload.error.code : undefined);
        const failureDetails = {
          ...(providerMessage === undefined ? {} : { providerMessage }),
          ...(providerCode === undefined ? {} : { providerCode })
        };
        this.logFailure(
          actor,
          stage,
          Date.now() - startedAt,
          "provider",
          response.status,
          { providerCodeCategory: providerCodeCategory(payload.error.code), ...failureDetails },
          attempts
        );
        throw new AiClientError(
          "provider",
          providerMessage === undefined
            ? `${this.providerName} returned an upstream error.`
            : `${this.providerName} returned an upstream error: ${providerMessage}`,
          { cause: new Error(`${this.providerName} returned an upstream error.`), stage, httpStatus: response.status, ...failureDetails }
        );
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
        reportId: actor.reportId, traceId: actor.traceId
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
      providerErrorTruncated?: boolean;
      providerMessage?: string;
      providerCode?: string;
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
        reportId: actor.reportId, traceId: actor.traceId,
        ...metadata
      },
      "warn"
    );
  }
}

