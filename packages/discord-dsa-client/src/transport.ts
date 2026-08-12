import { CookieJar } from "tough-cookie";
import { ProxyAgent, request } from "undici";
import type { Dispatcher } from "undici";

import {
  DiscordDsaError,
  DiscordDsaHttpError,
  DiscordDsaNetworkError
} from "./errors.js";
import type { JsonRequest, JsonTransport } from "./types.js";

const DEFAULT_BASE_URL = "https://discord.com/api/v9/reporting/unauthenticated/";
const FORBIDDEN_CALLER_HEADERS = new Set([
  "authorization",
  "content-length",
  "cookie",
  "host",
  "proxy-authorization"
]);

export interface UndiciTransportOptions {
  baseUrl?: string;
  proxyUrl?: string;
  defaultHeaders?: Record<string, string>;
  cookieJar?: CookieJar;
  serializedCookies?: string;
  timeoutMs?: number;
}

function sanitizeHeaders(headers: Record<string, string>): Record<string, string> {
  const sanitized: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const normalized = name.toLowerCase();
    if (FORBIDDEN_CALLER_HEADERS.has(normalized)) {
      throw new DiscordDsaError(`Header ${normalized} is managed by the transport.`);
    }
    sanitized[normalized] = value;
  }
  return sanitized;
}

function normalizeBaseUrl(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

function headerValues(value: string | string[] | undefined): string[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function parseRetryAfter(value: string | string[] | undefined): number | undefined {
  const first = headerValues(value)[0];
  if (!first) return undefined;
  const seconds = Number(first);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined;
}

export function discordResponseRequestId(headers: Record<string, string | string[] | undefined>): string | undefined {
  const value = headerValues(headers["x-request-id"] ?? headers["request-id"])[0];
  return value?.slice(0, 200);
}

function safeDetail(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  return value
    .replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, "[redacted-email]")
    .replace(/\b[A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{20,}\b/g, "[redacted-token]")
    .slice(0, 180);
}

function collectValidationDetails(
  value: unknown,
  path: string,
  output: string[],
  depth = 0
): void {
  if (depth > 6 || output.length >= 8 || typeof value !== "object" || value === null) {
    return;
  }
  const record = value as Record<string, unknown>;
  if (Array.isArray(record._errors)) {
    for (const item of record._errors) {
      if (output.length >= 8 || typeof item !== "object" || item === null) break;
      const error = item as Record<string, unknown>;
      const code = safeDetail(error.code);
      const message = safeDetail(error.message);
      const detail = [code, message].filter((part) => part !== undefined).join(": ");
      if (detail.length > 0) output.push(`${path || "request"}: ${detail}`);
    }
  }
  for (const [key, child] of Object.entries(record)) {
    if (key === "_errors" || output.length >= 8) continue;
    const safeKey = key.replace(/[^A-Za-z0-9_[\].-]/g, "").slice(0, 80);
    collectValidationDetails(child, path ? `${path}.${safeKey}` : safeKey, output, depth + 1);
  }
}

export function summarizeDiscordErrorBody(responseText: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(responseText);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
  const body = parsed as Record<string, unknown>;
  const parts: string[] = [];
  if (typeof body.code === "number" || typeof body.code === "string") {
    parts.push(`code ${String(body.code).slice(0, 40)}`);
  }
  const message = safeDetail(body.message);
  if (message !== undefined) parts.push(message);
  const validationDetails: string[] = [];
  collectValidationDetails(body.errors, "", validationDetails);
  parts.push(...validationDetails);
  if (parts.length === 0) return undefined;
  return parts.join("; ").slice(0, 450);
}

export class UndiciJsonTransport implements JsonTransport {
  private readonly baseUrl: string;
  private readonly defaultHeaders: Record<string, string>;
  private readonly cookieJar: CookieJar;
  private readonly dispatcher?: Dispatcher;
  private readonly timeoutMs: number;

  public constructor(options: UndiciTransportOptions = {}) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl ?? DEFAULT_BASE_URL);
    this.defaultHeaders = sanitizeHeaders(options.defaultHeaders ?? {});
    this.cookieJar =
      options.cookieJar ??
      (options.serializedCookies === undefined
        ? new CookieJar()
        : CookieJar.deserializeSync(options.serializedCookies));
    this.timeoutMs = options.timeoutMs ?? 15_000;
    if (options.proxyUrl !== undefined) {
      this.dispatcher = new ProxyAgent(options.proxyUrl);
    }
  }

  public exportCookies(): string {
    return JSON.stringify(this.cookieJar.serializeSync());
  }

  public async resolveRedirect(urlString: string): Promise<string> {
    const url = new URL(urlString);
    const headers = { ...this.defaultHeaders };
    const cookie = await this.cookieJar.getCookieString(url.toString());
    if (cookie.length > 0) headers.cookie = cookie;

    let response: Awaited<ReturnType<typeof request>>;
    try {
      response = await request(url, {
        method: "GET",
        headers,
        ...(this.dispatcher === undefined ? {} : { dispatcher: this.dispatcher }),
        headersTimeout: this.timeoutMs,
        bodyTimeout: this.timeoutMs
      });
    } catch (error) {
      throw new DiscordDsaNetworkError(`Network request failed for GET ${url.pathname}.`, {
        cause: error
      });
    }

    await response.body.text();
    if (response.statusCode < 300 || response.statusCode >= 400) {
      throw new DiscordDsaHttpError(
        `Discord returned HTTP ${response.statusCode} for GET ${url.pathname}.`,
        response.statusCode
      );
    }
    const location = headerValues(response.headers.location)[0];
    if (!location) {
      throw new DiscordDsaError("Discord review link redirect did not include a location.");
    }
    return new URL(location, url).toString();
  }

  public async requestJson<T>(requestOptions: JsonRequest): Promise<T> {
    const url = new URL(requestOptions.path.replace(/^\//, ""), this.baseUrl);
    const headers = {
      ...this.defaultHeaders,
      ...sanitizeHeaders(requestOptions.headers ?? {})
    };
    const cookie = await this.cookieJar.getCookieString(url.toString());
    if (cookie.length > 0) headers.cookie = cookie;

    let body: string | undefined;
    if (requestOptions.body !== undefined) {
      body = JSON.stringify(requestOptions.body);
      headers["content-type"] ??= "application/json";
    }

    let response: Awaited<ReturnType<typeof request>>;
    try {
      response = await request(url, {
        method: requestOptions.method,
        headers,
        ...(body === undefined ? {} : { body }),
        ...(this.dispatcher === undefined ? {} : { dispatcher: this.dispatcher }),
        headersTimeout: this.timeoutMs,
        bodyTimeout: this.timeoutMs
      });
    } catch (error) {
      throw new DiscordDsaNetworkError(
        `Network request failed for ${requestOptions.method} ${url.pathname}.`,
        { cause: error }
      );
    }

    for (const setCookie of headerValues(response.headers["set-cookie"])) {
      await this.cookieJar.setCookie(setCookie, url.toString(), { ignoreError: true });
    }

    const responseText = await response.body.text();
    if (response.statusCode < 200 || response.statusCode >= 300) {
      const retryAfterSeconds = parseRetryAfter(response.headers["retry-after"]);
      const responseSummary = summarizeDiscordErrorBody(responseText);
      const requestId = discordResponseRequestId(response.headers);
      throw new DiscordDsaHttpError(
        `Discord returned HTTP ${response.statusCode} for ${requestOptions.method} ${url.pathname}.`,
        response.statusCode,
        retryAfterSeconds === undefined && responseSummary === undefined && requestId === undefined
          ? undefined
          : {
              ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
              ...(responseSummary === undefined ? {} : { responseSummary }),
              ...(requestId === undefined ? {} : { requestId })
            }
      );
    }

    if (responseText.length === 0) return undefined as T;
    try {
      return JSON.parse(responseText) as T;
    } catch (error) {
      throw new DiscordDsaError(
        `Discord returned non-JSON data for ${requestOptions.method} ${url.pathname}.`,
        { cause: error }
      );
    }
  }

  public async close(): Promise<void> {
    await this.dispatcher?.close();
  }
}
