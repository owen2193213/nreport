import type { ActionHistoryPage, AnalyticsPeriod, DigestActivity, ReportAnalytics } from "./analytics.js";
import type {
  AdminAccountView,
  AdminApiKeyView,
  AdminCreateAccountInput,
  ApiAccountView,
  ApiErrorEnvelope,
  CreateReportInput,
  CursorPage,
  GlobalUsageView,
  ReportDetail,
  ReportLifecycleEvent,
  ReportRetryMode,
  ReportSummary,
  WebhookDestinationView
} from "./types.js";
import { DSA_ADMIN_BASE_PATH, DSA_API_BASE_PATH } from "./types.js";

export class DsaApiError extends Error {
  public constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly requestId?: string
  ) {
    super(message);
    this.name = "DsaApiError";
  }
}

interface HttpClientOptions {
  baseUrl: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

class HttpClient {
  private readonly baseUrl: URL;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  public constructor(options: HttpClientOptions, private readonly credential: string) {
    this.baseUrl = new URL(options.baseUrl);
    this.fetchImpl = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 15_000;
  }

  protected async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await this.fetchImpl(new URL(path, this.baseUrl), {
      ...init,
      headers: {
        authorization: `Bearer ${this.credential}`,
        accept: "application/json",
        ...init.headers
      },
      signal: AbortSignal.timeout(this.timeoutMs)
    });
    if (response.status === 204 && response.ok) return undefined as T;
    const rawBody = await response.text();
    let body: T | Partial<ApiErrorEnvelope> | undefined;
    try {
      body = rawBody.length === 0 ? undefined : JSON.parse(rawBody) as T | Partial<ApiErrorEnvelope>;
    } catch {
      body = undefined;
    }
    if (!response.ok) {
      const detail = (body as Partial<ApiErrorEnvelope> | undefined)?.error;
      throw new DsaApiError(
        response.status,
        detail?.code ?? "unknown_error",
        detail?.message ?? `HTTP ${response.status}`,
        detail?.requestId
      );
    }
    if (body === undefined) {
      throw new DsaApiError(response.status, "invalid_response", "API returned an invalid JSON response.");
    }
    return body as T;
  }
}

export interface DsaApiOptions extends HttpClientOptions { apiKey: string }

export class DsaApi extends HttpClient {
  public constructor(options: DsaApiOptions) {
    super(options, options.apiKey);
  }

  public account(): Promise<ApiAccountView> {
    return this.request(`${DSA_API_BASE_PATH}/account`);
  }

  public catalog(): Promise<Record<string, unknown>> {
    return this.request(`${DSA_API_BASE_PATH}/catalog`);
  }

  /** @deprecated Use catalog(). */
  public countries(): Promise<{ countries: string[] }> {
    return this.request<Record<string, unknown>>(`${DSA_API_BASE_PATH}/catalog`).then((value) => ({
      countries: value.countries as string[]
    }));
  }

  public createReport(idempotencyKey: string, input: CreateReportInput): Promise<ReportDetail> {
    return this.request(`${DSA_API_BASE_PATH}/reports`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": idempotencyKey },
      body: JSON.stringify(input)
    });
  }

  public report(reportId: string): Promise<ReportDetail> {
    return this.request(`${DSA_API_BASE_PATH}/reports/${encodeURIComponent(reportId)}`);
  }

  public reports(query: { after?: string; limit?: number } = {}): Promise<CursorPage<ReportSummary>> {
    const search = paginationQuery(query);
    return this.request(`${DSA_API_BASE_PATH}/reports${search}`);
  }

  public retryReport(reportId: string, idempotencyKey: string, mode: ReportRetryMode): Promise<ReportDetail> {
    return this.request(`${DSA_API_BASE_PATH}/reports/${encodeURIComponent(reportId)}/retries`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": idempotencyKey },
      body: JSON.stringify({ mode })
    });
  }

  public events(query: { after?: string; limit?: number } = {}): Promise<CursorPage<ReportLifecycleEvent>> {
    return this.request(`${DSA_API_BASE_PATH}/events${paginationQuery(query)}`);
  }

  public analytics(query: { period?: AnalyticsPeriod; startAt?: string; endAt?: string }): Promise<ReportAnalytics> {
    return this.request(`${DSA_API_BASE_PATH}/analytics${dateQuery(query)}`);
  }

  public communityAnalytics(period: AnalyticsPeriod): Promise<ReportAnalytics> {
    return this.request(`${DSA_API_BASE_PATH}/analytics/community?${new URLSearchParams({ period })}`);
  }

  public digestActivity(startAt: string, endAt: string): Promise<DigestActivity> {
    return this.request(`${DSA_API_BASE_PATH}/digest-activity${dateQuery({ startAt, endAt })}`);
  }

  public actionHistory(query: { period?: AnalyticsPeriod; startAt?: string; endAt?: string; after?: string; limit?: number }): Promise<ActionHistoryPage> {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) if (value !== undefined) search.set(key, String(value));
    return this.request(`${DSA_API_BASE_PATH}/action-history${search.size === 0 ? "" : `?${search}`}`);
  }
}

export interface DsaAdminApiOptions extends HttpClientOptions { adminKey: string }

export class DsaAdminApi extends HttpClient {
  public constructor(options: DsaAdminApiOptions) {
    super(options, options.adminKey);
  }

  public createAccount(input: AdminCreateAccountInput): Promise<AdminAccountView> {
    return this.request(`${DSA_ADMIN_BASE_PATH}/accounts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input)
    });
  }

  public accounts(): Promise<{ items: AdminAccountView[] }> {
    return this.request(`${DSA_ADMIN_BASE_PATH}/accounts`);
  }

  public account(accountId: string): Promise<AdminAccountView> {
    return this.request(`${DSA_ADMIN_BASE_PATH}/accounts/${encodeURIComponent(accountId)}`);
  }

  public issueKey(accountId: string): Promise<{ keyId: string; apiKey: string; prefix: string }> {
    return this.request(`${DSA_ADMIN_BASE_PATH}/accounts/${encodeURIComponent(accountId)}/keys`, { method: "POST" });
  }

  public rotateKey(accountId: string, overlapSeconds = 600): Promise<{ keyId: string; apiKey: string; prefix: string }> {
    return this.request(`${DSA_ADMIN_BASE_PATH}/accounts/${encodeURIComponent(accountId)}/keys/rotate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ overlapSeconds })
    });
  }

  public keys(accountId: string): Promise<{ items: AdminApiKeyView[] }> {
    return this.request(`${DSA_ADMIN_BASE_PATH}/accounts/${encodeURIComponent(accountId)}/keys`);
  }

  public async revokeKey(accountId: string, keyId: string, reason: string): Promise<void> {
    await this.request(`${DSA_ADMIN_BASE_PATH}/accounts/${encodeURIComponent(accountId)}/keys/${encodeURIComponent(keyId)}`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason })
    });
  }

  public suspendAccount(accountId: string, reason: string): Promise<AdminAccountView> {
    return this.accountStatus(accountId, "suspend", reason);
  }

  public reinstateAccount(accountId: string, reason: string): Promise<AdminAccountView> {
    return this.accountStatus(accountId, "reinstate", reason);
  }

  public adjustCredits(accountId: string, delta: number, reason: string): Promise<AdminAccountView> {
    return this.request(`${DSA_ADMIN_BASE_PATH}/accounts/${encodeURIComponent(accountId)}/credits`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ delta, reason })
    });
  }

  public usage(): Promise<GlobalUsageView> {
    return this.request(`${DSA_ADMIN_BASE_PATH}/usage`);
  }

  public diagnostics(): Promise<Record<string, number>> {
    return this.request(`${DSA_ADMIN_BASE_PATH}/diagnostics`);
  }

  public webhookDestinations(): Promise<{ items: WebhookDestinationView[] }> {
    return this.request(`${DSA_ADMIN_BASE_PATH}/webhook-destinations`);
  }

  public createWebhookDestination(input: { name: string; url: string; signingSecret: string }): Promise<WebhookDestinationView> {
    return this.request(`${DSA_ADMIN_BASE_PATH}/webhook-destinations`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input)
    });
  }

  public updateWebhookDestination(
    destinationId: string,
    input: { name?: string; url?: string; signingSecret?: string; status?: "active" | "disabled" }
  ): Promise<WebhookDestinationView> {
    return this.request(`${DSA_ADMIN_BASE_PATH}/webhook-destinations/${encodeURIComponent(destinationId)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input)
    });
  }

  public async assignWebhookDestination(accountId: string, destinationId: string | null): Promise<void> {
    await this.request(`${DSA_ADMIN_BASE_PATH}/accounts/${encodeURIComponent(accountId)}/webhook-destination`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ destinationId })
    });
  }

  private accountStatus(accountId: string, action: "suspend" | "reinstate", reason: string): Promise<AdminAccountView> {
    return this.request(`${DSA_ADMIN_BASE_PATH}/accounts/${encodeURIComponent(accountId)}/${action}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason })
    });
  }
}

function paginationQuery(query: { after?: string; limit?: number }): string {
  const search = new URLSearchParams();
  if (query.after !== undefined) search.set("after", query.after);
  if (query.limit !== undefined) search.set("limit", String(query.limit));
  return search.size === 0 ? "" : `?${search}`;
}

function dateQuery(query: { period?: AnalyticsPeriod; startAt?: string; endAt?: string }): string {
  const search = new URLSearchParams();
  if (query.period !== undefined) search.set("period", query.period);
  if (query.startAt !== undefined) search.set("startAt", query.startAt);
  if (query.endAt !== undefined) search.set("endAt", query.endAt);
  return search.size === 0 ? "" : `?${search}`;
}
