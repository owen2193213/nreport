import { readDiagnosticResponse } from "@discord-dsa/contracts";
import { botLog } from "./observability.js";
import type { AiUsage } from "./types.js";

const FIREWORKS_CHAT_COMPLETIONS_URL =
  "https://api.fireworks.ai/inference/v1/chat/completions";
const REQUEST_TIMEOUT_MS = 45_000;

export interface AiRequestContext {
  actorKey: string;
  userId: string;
  traceId?: string;
}

export type FireworksStage = "plan" | "synthesize" | "refine";

export interface FireworksCompletion {
  content: string;
  finishReason: string;
  usage: AiUsage;
}

interface FireworksResponse {
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

export type FireworksClientErrorKind =
  | "network"
  | "rate_limited"
  | "refusal"
  | "provider"
  | "malformed"
  | "incomplete"
  | "timeout";

export class FireworksClientError extends Error {
  public constructor(
    public readonly kind: FireworksClientErrorKind,
    message: string
  ) {
    super(message);
    this.name = "FireworksClientError";
  }
}

function numeric(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function usageFrom(value: FireworksResponse["usage"]): AiUsage {
  return {
    costCredits: 0,
    inputTokens: numeric(value?.prompt_tokens),
    outputTokens: numeric(value?.completion_tokens),
    reasoningTokens: numeric(value?.completion_tokens_details?.reasoning_tokens),
    searchRequests: 0
  };
}

export class FireworksClient {
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
    stage: FireworksStage
  ): Promise<FireworksCompletion> {
    const requestBody = {
      ...body,
      model: this.model,
      stream: false
    };
    let attempts = 0;
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        this.logFailure(actor, stage, 0, "timeout");
        throw new FireworksClientError("timeout", "The AI workflow deadline was exceeded.");
      }

      attempts += 1;
      const startedAt = Date.now();
      let response: Response;
      try {
        response = await this.request(FIREWORKS_CHAT_COMPLETIONS_URL, {
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
        if (attempts === 1 && deadline > Date.now()) continue;
        throw new FireworksClientError("network", "Fireworks could not be reached.");
      }

      if (!response.ok) {
        const kind = response.status === 429 ? "rate_limited" : "provider";
        const responseDiagnostic = await readDiagnosticResponse(response.clone(), [JSON.stringify(requestBody)]);
        this.logFailure(actor, stage, Date.now() - startedAt, kind, response.status, responseDiagnostic, attempts);
        const retryable = response.status === 429 || response.status >= 500;
        if (attempts === 1 && retryable && deadline > Date.now()) continue;
        throw new FireworksClientError(
          kind,
          response.status === 429 ? "Fireworks is rate limited." : "Fireworks is unavailable."
        );
      }

      let payload: FireworksResponse;
      try {
        payload = (await response.json()) as FireworksResponse;
      } catch {
        this.logFailure(actor, stage, Date.now() - startedAt, "malformed");
        throw new FireworksClientError("malformed", "Fireworks returned malformed JSON.");
      }

      const choice = payload.choices?.[0];
      if (choice?.message?.refusal) {
        this.logFailure(actor, stage, Date.now() - startedAt, "refusal");
        throw new FireworksClientError("refusal", "The model declined the request.");
      }
      if (choice?.finish_reason === "length") {
        this.logFailure(actor, stage, Date.now() - startedAt, "incomplete");
        throw new FireworksClientError("incomplete", "Fireworks exhausted the completion budget.");
      }
      if (typeof choice?.message?.content !== "string" || !choice.message.content.trim()) {
        this.logFailure(actor, stage, Date.now() - startedAt, "malformed");
        throw new FireworksClientError("malformed", "Fireworks returned no completion.");
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
    stage: FireworksStage,
    latencyMs: number,
    failureCategory: FireworksClientErrorKind,
    httpStatus?: number,
    response?: unknown,
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
        stage,
        ...(attempts === undefined ? {} : { attempts }),
        ...(actor.traceId === undefined ? {} : { traceId: actor.traceId }),
        ...(response === undefined ? {} : { response })
      },
      "warn"
    );
  }
}
