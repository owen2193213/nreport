import { botLog } from "./observability.js";
import { readDiagnosticResponse } from "@discord-dsa/contracts";
import type { AiRequestContext } from "./fireworks-client.js";
import { capturedMessageSnapshot, type ReportDraft } from "./types.js";

const BRAVE_WEB_URL = "https://api.search.brave.com/res/v1/web/search";
const BRAVE_LLM_CONTEXT_URL = "https://api.search.brave.com/res/v1/llm/context";
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_QUERY_CHARACTERS = 400;
const MAX_QUERY_WORDS = 50;
const MAX_SOURCES = 3;
const MAX_SNIPPETS_PER_SOURCE = 4;
const MAX_SNIPPET_CHARACTERS = 1_200;
const BRAVE_COUNTRIES = new Set([
  "AR",
  "AU",
  "AT",
  "BE",
  "BR",
  "CA",
  "CL",
  "DK",
  "FI",
  "FR",
  "DE",
  "GR",
  "HK",
  "IN",
  "ID",
  "IT",
  "JP",
  "KR",
  "MY",
  "MX",
  "NL",
  "NZ",
  "NO",
  "CN",
  "PL",
  "PT",
  "PH",
  "RU",
  "SA",
  "ZA",
  "ES",
  "SE",
  "CH",
  "TW",
  "TR",
  "GB",
  "US",
  "ALL"
]);
const OFFICIAL_LAW_GOGGLE = [
  "$boost=5,site=eur-lex.europa.eu",
  "$boost=5,site=e-justice.europa.eu",
  "$boost=5,site=n-lex.europa.eu"
].join("\n");

export type ResearchKind = "term" | "law";

export function braveSearchCountry(country: string): string {
  const normalized = country.toUpperCase();
  return BRAVE_COUNTRIES.has(normalized) ? normalized : "ALL";
}

export interface ResearchSource {
  title: string;
  url: string;
  hostname: string;
  snippets: string[];
}

export interface ResearchMaterial {
  kind: ResearchKind;
  query: string;
  sources: ResearchSource[];
  searchRequests: number;
}

export type BraveResearchErrorKind =
  | "invalid_query"
  | "network"
  | "rate_limited"
  | "provider"
  | "malformed"
  | "empty"
  | "timeout";

export class BraveResearchError extends Error {
  public constructor(
    public readonly kind: BraveResearchErrorKind,
    message: string,
    public readonly searchRequests = 0,
    public readonly retryable = false
  ) {
    super(message);
    this.name = "BraveResearchError";
  }
}

function normalizedQuery(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function sensitiveDraftValues(draft: ReportDraft): string[] {
  const snapshot = capturedMessageSnapshot(draft.messageEvidence);
  return [
    draft.reportedUserId,
    draft.reportedUsername,
    draft.guildIdOrInviteCode,
    draft.messageUrl,
    draft.profileTargetRaw,
    draft.reportedUserServerId,
    snapshot?.messageId,
    snapshot?.channelId,
    snapshot?.channelName,
    snapshot?.serverId,
    snapshot?.serverName,
    snapshot?.authorId,
    snapshot?.authorUsername,
    snapshot?.authorDisplayName,
    ...((snapshot?.attachments ?? []).map((attachment) => attachment.url))
  ].flatMap((value) => (typeof value === "string" && value.trim().length >= 3 ? [value.trim()] : []));
}

export function validateResearchQuery(query: string, draft: ReportDraft): string {
  const normalized = normalizedQuery(query);
  if (!normalized) {
    throw new BraveResearchError("invalid_query", "A research query is required.");
  }
  if (normalized.length > MAX_QUERY_CHARACTERS) {
    throw new BraveResearchError(
      "invalid_query",
      "A research query must contain no more than 400 characters."
    );
  }
  if (normalized.split(" ").length > MAX_QUERY_WORDS) {
    throw new BraveResearchError(
      "invalid_query",
      "A research query must contain no more than 50 words."
    );
  }
  if (/\b\d{15,22}\b/.test(normalized)) {
    throw new BraveResearchError(
      "invalid_query",
      "A research query must not contain a Discord identifier."
    );
  }
  if (/https?:\/\//i.test(normalized)) {
    throw new BraveResearchError(
      "invalid_query",
      "A research query must not contain a URL."
    );
  }
  if (/\b[^\s@]+@[^\s@]+\.[^\s@]+\b/i.test(normalized)) {
    throw new BraveResearchError(
      "invalid_query",
      "A research query must not contain an email address."
    );
  }
  const folded = normalized.toLocaleLowerCase("en");
  if (
    sensitiveDraftValues(draft).some((value) =>
      folded.includes(value.toLocaleLowerCase("en"))
    )
  ) {
    throw new BraveResearchError(
      "invalid_query",
      "A research query must not contain a sensitive draft detail."
    );
  }
  return normalized;
}

interface BraveWebResponse {
  web?: {
    results?: Array<{
      title?: unknown;
      url?: unknown;
      description?: unknown;
      extra_snippets?: unknown;
    }>;
  };
}

interface BraveContextResponse {
  grounding?: {
    generic?: Array<{
      title?: unknown;
      url?: unknown;
      snippets?: unknown;
    }>;
  };
  sources?: Record<string, { title?: unknown; hostname?: unknown }>;
}

function safeUrl(value: unknown): URL | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) return undefined;
    return url;
  } catch {
    return undefined;
  }
}

function text(value: unknown, limit: number): string {
  return typeof value === "string" ? value.trim().slice(0, limit) : "";
}

function snippets(values: unknown[]): string[] {
  return values
    .flatMap((value) => {
      const snippet = text(value, MAX_SNIPPET_CHARACTERS);
      return snippet ? [snippet] : [];
    })
    .slice(0, MAX_SNIPPETS_PER_SOURCE);
}

function unknownArray(value: unknown): unknown[] {
  if (!Array.isArray(value)) return [];
  return value.map((item: unknown) => item);
}

function compactWeb(payload: BraveWebResponse): ResearchSource[] {
  const seen = new Set<string>();
  const sources: ResearchSource[] = [];
  for (const result of payload.web?.results ?? []) {
    const url = safeUrl(result.url);
    if (!url || seen.has(url.toString())) continue;
    const resultSnippets = snippets([
      result.description,
      ...unknownArray(result.extra_snippets)
    ]);
    if (resultSnippets.length === 0) continue;
    seen.add(url.toString());
    sources.push({
      hostname: url.hostname,
      snippets: resultSnippets,
      title: text(result.title, 200) || url.hostname,
      url: url.toString()
    });
    if (sources.length === MAX_SOURCES) break;
  }
  return sources;
}

function compactContext(payload: BraveContextResponse): ResearchSource[] {
  const seen = new Set<string>();
  const sources: ResearchSource[] = [];
  for (const result of payload.grounding?.generic ?? []) {
    const url = safeUrl(result.url);
    if (!url || seen.has(url.toString())) continue;
    const resultSnippets = snippets(Array.isArray(result.snippets) ? result.snippets : []);
    if (resultSnippets.length === 0) continue;
    const metadata = payload.sources?.[url.toString()];
    seen.add(url.toString());
    sources.push({
      hostname: url.hostname,
      snippets: resultSnippets,
      title: text(result.title ?? metadata?.title, 200) || url.hostname,
      url: url.toString()
    });
    if (sources.length === MAX_SOURCES) break;
  }
  return sources;
}

export class BraveResearchClient {
  private readonly request: typeof globalThis.fetch;

  public constructor(
    private readonly apiKey: string,
    options: { request?: typeof globalThis.fetch } = {}
  ) {
    this.request = options.request ?? globalThis.fetch;
  }

  public async search(
    kind: ResearchKind,
    query: string,
    country: string,
    deadline: number,
    actor: AiRequestContext
  ): Promise<ResearchMaterial> {
    let attempts = 0;
    for (;;) {
      if (deadline <= Date.now()) {
        const timeout = new BraveResearchError(
          "timeout",
          "The research deadline was exceeded.",
          attempts
        );
        botLog(
          "ai_search_failed",
          {
            actorKey: actor.actorKey,
            failureCategory: timeout.kind,
            kind,
            searchRequests: timeout.searchRequests
          },
          "warn"
        );
        throw timeout;
      }
      try {
        attempts += 1;
        const payload = await this.requestOnce(kind, query, country, deadline, actor);
        const sources = kind === "term" ? compactWeb(payload as BraveWebResponse) : compactContext(payload as BraveContextResponse);
        if (sources.length === 0) {
          throw new BraveResearchError("empty", "Brave returned no usable sources.", attempts);
        }
        botLog("ai_search_completed", {
          actorKey: actor.actorKey,
          kind,
          latencyAttempts: attempts,
          resultCount: sources.length
        });
        return { kind, query, sources, searchRequests: attempts };
      } catch (error) {
        const researchError =
          error instanceof BraveResearchError
            ? error
            : new BraveResearchError(
                "network",
                "Brave could not be reached.",
                attempts,
                true
              );
        const retryable = attempts === 1 && researchError.retryable && deadline > Date.now();
        if (retryable) continue;
        const finalError = new BraveResearchError(
          researchError.kind,
          researchError.message,
          Math.max(attempts, researchError.searchRequests),
          false
        );
        botLog(
          "ai_search_failed",
          {
            actorKey: actor.actorKey,
            failureCategory: finalError.kind,
            kind,
            searchRequests: finalError.searchRequests
          },
          "warn"
        );
        throw finalError;
      }
    }
  }

  private async requestOnce(
    kind: ResearchKind,
    query: string,
    country: string,
    deadline: number,
    actor: AiRequestContext
  ): Promise<BraveWebResponse | BraveContextResponse> {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new BraveResearchError("timeout", "The research deadline was exceeded.");
    }
    const url = new URL(kind === "term" ? BRAVE_WEB_URL : BRAVE_LLM_CONTEXT_URL);
    const braveCountry = braveSearchCountry(country);
    let body: string | undefined;
    if (kind === "term") {
      url.searchParams.set("q", query);
      url.searchParams.set("country", braveCountry);
      url.searchParams.set("count", "3");
    } else {
      body = JSON.stringify({
        q: query,
        country: braveCountry,
        count: 5,
        maximum_number_of_urls: 3,
        maximum_number_of_tokens: 2048,
        maximum_number_of_tokens_per_url: 1024,
        context_threshold_mode: "strict",
        enable_source_metadata: true,
        enable_local: false,
        goggles: OFFICIAL_LAW_GOGGLE
      });
    }

    let response: Response;
    try {
      response = await this.request(url.toString(), {
        method: kind === "term" ? "GET" : "POST",
        headers: {
          Accept: "application/json",
          "Accept-Encoding": "gzip",
          "X-Subscription-Token": this.apiKey,
          ...(kind === "law" ? { "Content-Type": "application/json" } : {})
        },
        ...(body === undefined ? {} : { body }),
        signal: AbortSignal.timeout(Math.min(REQUEST_TIMEOUT_MS, remaining))
      });
    } catch {
      throw new BraveResearchError("network", "Brave could not be reached.", 0, true);
    }
    if (!response.ok) {
      const failureKind = response.status === 429 ? "rate_limited" : "provider";
      const retryable = response.status === 429 || response.status >= 500;
      const responseDiagnostic = await readDiagnosticResponse(response.clone(), [query]);
      botLog(
        "ai_search_http_failed",
        {
          actorKey: actor.actorKey,
          endpoint: kind === "term" ? "web_search" : "llm_context",
          httpStatus: response.status,
          kind,
          method: kind === "term" ? "GET" : "POST",
          provider: "brave",
          queryCharacters: query.length,
          queryWords: query.split(/\s+/).length,
          requestParameterNames: kind === "term" ? "q,country,count" : "q,country,count,maximum_number_of_urls,maximum_number_of_tokens,maximum_number_of_tokens_per_url,context_threshold_mode,enable_source_metadata,enable_local,goggles",
          response: responseDiagnostic,
          ...(responseDiagnostic.requestId === undefined ? {} : { requestId: responseDiagnostic.requestId }),
          ...(actor.traceId === undefined ? {} : { traceId: actor.traceId })
        },
        "warn"
      );
      throw new BraveResearchError(failureKind, "Brave search is unavailable.", 0, retryable);
    }
    try {
      return (await response.json()) as BraveWebResponse | BraveContextResponse;
    } catch {
      throw new BraveResearchError("malformed", "Brave returned malformed JSON.");
    }
  }
}
