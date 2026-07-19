import { CookieJar } from "tough-cookie";
import { ProxyAgent, request } from "undici";
import type { Dispatcher } from "undici";

import { DiscordDsaError, DiscordDsaHttpError } from "./errors.js";
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
      throw new DiscordDsaError(
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
      throw new DiscordDsaHttpError(
        `Discord returned HTTP ${response.statusCode} for ${requestOptions.method} ${url.pathname}.`,
        response.statusCode,
        retryAfterSeconds === undefined ? undefined : { retryAfterSeconds }
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
