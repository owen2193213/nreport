import type {
  CreateReportInput,
  ReportDetail,
  ReportLifecycleEvent,
  ReportSummary
} from "./types.js";
import type { ActionHistoryPage, AnalyticsPeriod, ReportAnalytics } from "./analytics.js";

interface ApiErrorBody {
  error?: { code?: string; message?: string };
}

export class DsaApiError extends Error {
  public constructor(
    public readonly status: number,
    public readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "DsaApiError";
  }
}

export interface DsaApiOptions {
  baseUrl: string;
  apiKey: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export class DsaApi {
  private readonly baseUrl: URL;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  public constructor(options: DsaApiOptions) {
    this.baseUrl = new URL(options.baseUrl);
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 15_000;
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await this.fetchImpl(new URL(path, this.baseUrl), {
      ...init,
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        accept: "application/json",
        ...init.headers
      },
      signal: AbortSignal.timeout(this.timeoutMs)
    });
    const body = (await response.json()) as T | ApiErrorBody;
    if (!response.ok) {
      const apiError = body as ApiErrorBody;
      throw new DsaApiError(
        response.status,
        apiError.error?.code ?? "unknown_error",
        apiError.error?.message ?? `HTTP ${response.status}`
      );
    }
    return body as T;
  }

  public countries(): Promise<{ countries: string[] }> {
    return this.request("/v1/countries");
  }

  public createReport(interactionId: string, input: CreateReportInput): Promise<ReportDetail> {
    return this.request("/v1/reports", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": `create:${interactionId}`
      },
      body: JSON.stringify(input)
    });
  }

  public report(internalReportId: string): Promise<ReportDetail> {
    return this.request(`/v1/reports/${encodeURIComponent(internalReportId)}`);
  }

  public reportsFor(discordUserId: string): Promise<{ reports: ReportSummary[] }> {
    return this.request(`/v1/users/${encodeURIComponent(discordUserId)}/reports`);
  }

  public analyticsFor(discordUserId: string, period: AnalyticsPeriod): Promise<ReportAnalytics> {
    const query = new URLSearchParams({ period });
    return this.request(
      `/v1/users/${encodeURIComponent(discordUserId)}/analytics?${query.toString()}`
    );
  }

  public communityAnalytics(period: AnalyticsPeriod): Promise<ReportAnalytics> {
    const query = new URLSearchParams({ period });
    return this.request(`/v1/analytics/community?${query.toString()}`);
  }

  public actionHistory(
    discordUserId: string,
    query: {
      period?: AnalyticsPeriod;
      startAt?: string;
      endAt?: string;
      after?: string;
      limit?: number;
    }
  ): Promise<ActionHistoryPage> {
    const search = new URLSearchParams();
    if (query.period !== undefined) search.set("period", query.period);
    if (query.startAt !== undefined) search.set("startAt", query.startAt);
    if (query.endAt !== undefined) search.set("endAt", query.endAt);
    if (query.after !== undefined) search.set("after", query.after);
    if (query.limit !== undefined) search.set("limit", query.limit.toString());
    const suffix = search.size > 0 ? `?${search.toString()}` : "";
    return this.request(
      `/v1/users/${encodeURIComponent(discordUserId)}/action-history${suffix}`
    );
  }

  public retryReport(
    internalReportId: string,
    interactionId: string,
    discordUserId: string,
    overrides: { reportReason?: string; context?: string } = {}
  ): Promise<ReportDetail> {
    return this.request(`/v1/reports/${encodeURIComponent(internalReportId)}/retry`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": `retry:${interactionId}`
      },
      body: JSON.stringify({ submitterDiscordUserId: discordUserId, ...overrides })
    });
  }

  public retryAppeal(
    internalReportId: string,
    interactionId: string,
    discordUserId: string
  ): Promise<ReportDetail> {
    return this.request(
      `/v1/reports/${encodeURIComponent(internalReportId)}/retry-appeal`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": `appeal-retry:${interactionId}`
        },
        body: JSON.stringify({ submitterDiscordUserId: discordUserId })
      }
    );
  }

  public lifecycleEvents(
    afterEventId: string,
    limit = 100
  ): Promise<{ events: ReportLifecycleEvent[] }> {
    const query = new URLSearchParams({ after: afterEventId, limit: limit.toString() });
    return this.request(`/v1/report-events?${query.toString()}`);
  }
}
