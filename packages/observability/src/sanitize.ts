import type { Breadcrumb, Context, ErrorEvent, Event, Log, SpanJSON, TraceContext, TransactionEvent } from "@sentry/core";
import type { LifecycleFailureContext, SafeErrorCause, SafeErrorSummary } from "./types.js";

const SAFE_TAGS = new Set([
  "service",
  "operation",
  "report_id",
  "report_trace_id",
  "request_id",
  "stage",
  "outcome",
  "job_kind",
  "event_type",
  "delivery_stage",
  "http.method",
  "http.route",
  "http.status_code",
  "provider.error_code",
  "error_category",
  "discord.error_code"
]);

const SAFE_SPAN_DATA = new Set([
  "http.method",
  "http.request.method",
  "http.status_code",
  "http.response.status_code",
  "http.route",
  "db.system",
  "db.operation"
]);

const HTTP_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"]);
const URL_PATTERN = /\b(?:https?|ftp):\/\/(?:\[[^\]\s]+\]|[^\s"'<>\x5B\x5D)}])+/giu;
const CONNECTION_URL_PATTERN = /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp|smtp):\/\/(?:\[[^\]\s]+\]|[^\s"'<>\x5B\x5D)}])+/giu;
const EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu;
const SECRET_ASSIGNMENT_PATTERN = /\b(authorization|proxy-authorization|cookie|set-cookie|password|passwd|secret|api[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|auth[-_ ]?token|webhook[-_ ]?secret|verification[-_ ]?code|one[-_ ]?time[-_ ]?code|otp)\b\s*[:=]\s*(?:bearer\s+)?(?:"[^"]*"|'[^']*'|[^\s,;]+)/giu;
const NAMED_SECRET_PATTERN = /\b(?:[A-Z0-9_-]{0,40}(?:api[-_ ]?key|secret|token|credential|password|dsa[-_](?:live|test)))[-_: =]+[A-Z0-9._~+/-]{6,}\b/giu;
const BEARER_PATTERN = /\b(?:bearer|basic)\s+[A-Z0-9._~+/-]+=*/giu;
const JWT_PATTERN = /\beyJ[A-Z0-9_-]{8,}\.[A-Z0-9_-]{8,}\.[A-Z0-9_-]{8,}\b/giu;
const COMMON_TOKEN_PATTERN = /\b(?:sk-[A-Z0-9_-]{12,}|gh[pousr]_[A-Z0-9]{12,}|xox[baprs]-[A-Z0-9-]{12,})\b/giu;
const DISCORD_TOKEN_PATTERN = /\b(?:mfa\.[A-Z0-9_-]{20,}|[A-Z0-9_-]{20,}\.[A-Z0-9_-]{6,}\.[A-Z0-9_-]{20,})\b/giu;
const LABELED_CODE_PATTERN = /\b(verification|verify|email|one[- ]time|otp|auth(?:entication)?)\s+(?:code\s*)?(?:is\s*)?[:=]?\s*\d{4,8}\b/giu;
const DISCORD_SNOWFLAKE_PATTERN = /\b\d{17,20}\b/gu;
const SIX_DIGIT_CODE_PATTERN = /\b\d{6}\b/gu;
const RAW_MAIL_HEADERS_PATTERN = /^(?:from|to|subject|date|message-id|mime-version|content-type|content-transfer-encoding|received):\s*.+$/gimu;
const SECRET_ENV_NAME_PATTERN = /(?:SECRET|PASSWORD|PASSWD|TOKEN|(?:ADMIN|API|ENCRYPTION|SESSION|SIGNING|PRIVATE|HMAC)[-_]?KEY|CREDENTIAL|PEPPER|DSN|DATABASE[-_]?URL|PROXY[-_]?URL|WEBHOOK[-_]?URL|COOKIE)/iu;

function configuredSecrets(): string[] {
  const secrets: string[] = [];
  for (const [name, value] of Object.entries(process.env)) {
    if (!SECRET_ENV_NAME_PATTERN.test(name) || value === undefined || value.length < 6 || value.length > 4_096) continue;
    if (!secrets.includes(value)) secrets.push(value);
  }
  return secrets.sort((left, right) => right.length - left.length);
}

export function sanitizeText(value: string, maxLength = 2_000): string {
  const headerMatches = value.match(RAW_MAIL_HEADERS_PATTERN);
  if (headerMatches !== null && headerMatches.length >= 2 && /\r?\n\r?\n/u.test(value)) return "[REDACTED_RAW_MAIL]";
  let scrubbed = value;
  for (const secret of configuredSecrets()) scrubbed = scrubbed.split(secret).join("[REDACTED_CONFIGURED_SECRET]");
  const bounded = scrubbed
    .replaceAll("\r", " ")
    .replaceAll("\n", " ")
    .replaceAll("\t", " ")
    // Replace email addresses before URL and token patterns can consume part of them.
    .replace(EMAIL_PATTERN, "[REDACTED_EMAIL]")
    .replace(SECRET_ASSIGNMENT_PATTERN, "$1=[REDACTED]")
    .replace(NAMED_SECRET_PATTERN, "[REDACTED_SECRET]")
    .replace(BEARER_PATTERN, "[REDACTED_CREDENTIAL]")
    .replace(JWT_PATTERN, "[REDACTED_TOKEN]")
    .replace(COMMON_TOKEN_PATTERN, "[REDACTED_TOKEN]")
    .replace(DISCORD_TOKEN_PATTERN, "[REDACTED_DISCORD_TOKEN]")
    .replace(CONNECTION_URL_PATTERN, "[REDACTED_URL]")
    .replace(URL_PATTERN, "[REDACTED_URL]")
    .replace(LABELED_CODE_PATTERN, "$1 [REDACTED_CODE]")
    .replace(SIX_DIGIT_CODE_PATTERN, "[REDACTED_CODE]")
    .replace(DISCORD_SNOWFLAKE_PATTERN, "[REDACTED_ID]")
    .replace(/([A-Z]:\\Users\\)[^\\]+\\/giu, "$1[REDACTED]\\")
    .replace(/(\/home\/)[^/]+\//gu, "$1[REDACTED]/");
  return bounded.length <= maxLength ? bounded : `${bounded.slice(0, maxLength)}…`;
}

function safeLabel(value: unknown, maxLength = 100): string | undefined {
  if (typeof value !== "string") return undefined;
  const cleaned = sanitizeText(value, maxLength).trim();
  if (!cleaned || cleaned.includes("[REDACTED_") || !/^[A-Za-z0-9_.:/-]+$/u.test(cleaned)) return undefined;
  return cleaned;
}

function safeIdentifier(value: string | undefined): string | undefined {
  if (value === undefined || value.length > 80 || value.includes("@") || /\s/u.test(value)) return undefined;
  const cleaned = sanitizeText(value, 80);
  if (cleaned.includes("[REDACTED_") || !/^[A-Za-z0-9_.:-]+$/u.test(cleaned)) return undefined;
  return cleaned;
}

function safeNumber(value: number | undefined, min: number, max: number): number | undefined {
  if (value === undefined || !Number.isInteger(value) || value < min || value > max) return undefined;
  return value;
}

function safeRoute(value: string | undefined): string | undefined {
  if (value === undefined || !value.startsWith("/") || /[?#@\\]/u.test(value) || value.length > 180) return undefined;
  const route = value.split("/").map((segment) => {
    if (/^(?:\d{4,}|[0-9a-f]{8}-[0-9a-f-]{27,}|[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})$/iu.test(segment)) return ":id";
    return segment;
  }).join("/");
  return /^[A-Za-z0-9_./:{}-]+$/u.test(route) ? route : undefined;
}

export function sanitizeFailureContext(context: LifecycleFailureContext): Record<string, string | number> {
  const output: Record<string, string | number> = {
    service: context.service,
    operation: safeLabel(context.operation, 80) ?? "lifecycle.failure"
  };
  const stringFields: Array<[keyof LifecycleFailureContext, string | undefined]> = [
    ["reportId", context.reportId],
    ["traceId", context.traceId],
    ["requestId", context.requestId]
  ];
  for (const [key, value] of stringFields) {
    const safe = safeIdentifier(value);
    if (safe !== undefined) output[key] = safe;
  }

  const labels: Array<[keyof LifecycleFailureContext, string | undefined]> = [
    ["stage", context.stage],
    ["phase", context.phase],
    ["outcome", context.outcome],
    ["jobKind", context.jobKind],
    ["eventType", context.eventType],
    ["deliveryStage", context.deliveryStage],
    ["method", context.method?.toUpperCase()],
    ["route", safeRoute(context.route)],
    ["providerErrorCode", context.providerErrorCode],
    ["errorCategory", context.errorCategory],
    ["discordErrorCode", typeof context.discordErrorCode === "string" ? context.discordErrorCode : undefined]
  ];
  for (const [key, value] of labels) {
    const safe = key === "method"
      ? (value !== undefined && HTTP_METHODS.has(value) ? value : undefined)
      : safeLabel(value, key === "route" ? 180 : 100);
    if (safe !== undefined) output[key] = safe;
  }
  if (typeof context.upstreamResponseSummary === "string") {
    const summary = sanitizeText(context.upstreamResponseSummary, 1_000).trim();
    if (summary.length > 0) output.upstreamResponseSummary = summary;
  }

  const numbers: Array<[keyof LifecycleFailureContext, number | undefined, number, number]> = [
    ["lifecycleAttempt", context.lifecycleAttempt, 1, 1_000_000],
    ["attempt", context.attempt, 1, 1_000_000],
    ["statusCode", context.statusCode, 100, 599],
    ["providerStatusCode", context.providerStatusCode, 100, 599],
    ["discordHttpStatus", context.discordHttpStatus, 100, 599]
  ];
  for (const [key, value, min, max] of numbers) {
    const safe = safeNumber(value, min, max);
    if (safe !== undefined) output[key] = safe;
  }
  if (typeof context.discordErrorCode === "number" && Number.isInteger(context.discordErrorCode) && context.discordErrorCode >= 0 && context.discordErrorCode <= 1_000_000) {
    output.discordErrorCode = context.discordErrorCode;
  }
  return output;
}

function safeStack(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const lines = value.split(/\r?\n/u).slice(0, 30).map((line) => sanitizeText(line, 300));
  const output = lines.join("\n");
  return output.length > 4_000 ? `${output.slice(0, 4_000)}…` : output;
}

function safeOwnDataValue(value: unknown, key: string): unknown {
  if ((typeof value !== "object" || value === null) && typeof value !== "function") return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

function isError(value: unknown): value is Error {
  try {
    return value instanceof Error;
  } catch {
    return false;
  }
}

function errorName(error: Error): string {
  const ownName = safeOwnDataValue(error, "name");
  if (typeof ownName === "string") return safeLabel(ownName, 100) ?? "Error";
  try {
    const prototype = Object.getPrototypeOf(error) as object | null;
    const constructor = prototype === null ? undefined : safeOwnDataValue(prototype, "constructor");
    const constructorName = safeOwnDataValue(constructor, "name");
    return typeof constructorName === "string" ? safeLabel(constructorName, 100) ?? "Error" : "Error";
  } catch {
    return "Error";
  }
}

function errorNode(error: unknown): SafeErrorCause {
  if (isError(error)) {
    const name = errorName(error);
    // Native V8 Error.stack is exposed through an accessor on some Node versions.
    // Only read Error instances directly, and guard the access for hostile subclasses.
    let rawMessage = safeOwnDataValue(error, "message");
    let rawStack = safeOwnDataValue(error, "stack");
    try {
      if (typeof rawMessage !== "string") rawMessage = error.message;
    } catch {
      // Keep the safe class-name fallback below.
    }
    try {
      if (typeof rawStack !== "string") rawStack = error.stack;
    } catch {
      // Some Error subclasses may override stack with a throwing getter.
    }
    const message = sanitizeText(typeof rawMessage === "string" && rawMessage.length > 0 ? rawMessage : name, 1_000);
    const stack = safeStack(typeof rawStack === "string" ? rawStack : undefined);
    return { name, message, ...(stack === undefined ? {} : { stack }) };
  }
  if (typeof error === "string" || typeof error === "number" || typeof error === "boolean" || typeof error === "bigint") {
    return { name: "Error", message: sanitizeText(String(error), 1_000) };
  }
  const rawMessage = safeOwnDataValue(error, "message");
  const rawName = safeOwnDataValue(error, "name");
  const rawStack = safeOwnDataValue(error, "stack");
  const name = safeLabel(rawName, 100) ?? "Error";
  const message = sanitizeText(typeof rawMessage === "string" ? rawMessage : "Non-Error failure", 1_000);
  const stack = safeStack(typeof rawStack === "string" ? rawStack : undefined);
  return { name, message, ...(stack === undefined ? {} : { stack }) };
}

export function safeErrorSummary(error: unknown): SafeErrorSummary {
  try {
    const primary = errorNode(error);
    const causes: SafeErrorCause[] = [];
    let cause = safeOwnDataValue(error, "cause");
    const seen = new Set<unknown>([error]);
    for (let depth = 0; cause !== undefined && depth < 5 && !seen.has(cause); depth += 1) {
      seen.add(cause);
      causes.push(errorNode(cause));
      cause = safeOwnDataValue(cause, "cause");
    }
    return {
      name: primary.name,
      message: primary.message,
      ...(primary.stack === undefined ? {} : { stack: primary.stack }),
      causes
    };
  } catch {
    return { name: "Error", message: "Non-Error failure", causes: [] };
  }
}

function scrubTags(tags: Record<string, unknown> | undefined): Record<string, string> | undefined {
  if (tags === undefined) return undefined;
  const output: Record<string, string> = {};
  for (const [key, value] of Object.entries(tags)) {
    if (!SAFE_TAGS.has(key)) continue;
    if ((key === "discord.error_code" || key === "provider.error_code") &&
      ((typeof value === "number" && Number.isInteger(value) && value >= 1_000 && value <= 1_000_000) ||
        (typeof value === "string" && /^\d{4,6}$/u.test(value) && Number(value) >= 1_000 && Number(value) <= 1_000_000))) {
      output[key] = String(value);
      continue;
    }
    const safe = safeLabel(value, 180);
    if (safe !== undefined) output[key] = safe;
  }
  return output;
}

function scrubTraceContext(context: Context | undefined): TraceContext | undefined {
  if (context === undefined) return undefined;
  const traceId = safeLabel(context.trace_id, 64);
  const spanId = safeLabel(context.span_id, 64);
  if (traceId === undefined || spanId === undefined) return undefined;
  const output: TraceContext = { trace_id: traceId, span_id: spanId };
  const parentSpanId = safeLabel(context.parent_span_id, 64);
  const op = safeLabel(context.op, 100);
  const status = safeLabel(context.status, 100);
  if (parentSpanId !== undefined) output.parent_span_id = parentSpanId;
  if (op !== undefined) output.op = op;
  if (status !== undefined) output.status = status;
  return output;
}

export function sanitizeSentryBreadcrumb(breadcrumb: Breadcrumb): Breadcrumb | null {
  try {
    const safe: Breadcrumb = {};
    if (breadcrumb.timestamp !== undefined) safe.timestamp = breadcrumb.timestamp;
    const type = safeLabel(breadcrumb.type, 30);
    const category = safeLabel(breadcrumb.category, 80);
    if (type !== undefined) safe.type = type;
    if (category !== undefined) safe.category = category;
    if (breadcrumb.level !== undefined) safe.level = breadcrumb.level;
    if (breadcrumb.message !== undefined) safe.message = sanitizeText(breadcrumb.message, 300);
    // Breadcrumb data often contains request bodies, SQL statements, headers, or full URLs.
    return safe;
  } catch {
    return null;
  }
}

function scrubBreadcrumbs(breadcrumbs: Breadcrumb[] | undefined): Breadcrumb[] | undefined {
  if (breadcrumbs === undefined) return undefined;
  return breadcrumbs.slice(-20).map(sanitizeSentryBreadcrumb).filter((breadcrumb): breadcrumb is Breadcrumb => breadcrumb !== null);
}

function scrubException(event: Event): void {
  for (const exception of event.exception?.values ?? []) {
    if (exception.value !== undefined) exception.value = sanitizeText(exception.value, 1_000);
    if (exception.type !== undefined) exception.type = safeLabel(exception.type, 100) ?? "Error";
    if (exception.mechanism !== undefined) delete exception.mechanism.data;
    for (const frame of exception.stacktrace?.frames ?? []) {
      if (frame.filename !== undefined) frame.filename = sanitizeText(frame.filename, 300);
      if (frame.abs_path !== undefined) frame.abs_path = sanitizeText(frame.abs_path, 300);
      delete frame.vars;
      delete frame.pre_context;
      delete frame.context_line;
      delete frame.post_context;
    }
  }
}

function scrubLifecycleContext(context: Context | undefined): Context | undefined {
  if (context === undefined) return undefined;
  try {
    const service = context.service;
    const operation = context.operation;
    if ((service !== "api" && service !== "bot") || typeof operation !== "string") return undefined;
    const input: LifecycleFailureContext = {
      service,
      operation,
      ...(typeof context.reportId === "string" ? { reportId: context.reportId } : {}),
      ...(typeof context.traceId === "string" ? { traceId: context.traceId } : {}),
      ...(typeof context.requestId === "string" ? { requestId: context.requestId } : {}),
      ...(typeof context.stage === "string" ? { stage: context.stage } : {}),
      ...(typeof context.phase === "string" ? { phase: context.phase } : {}),
      ...(typeof context.outcome === "string" ? { outcome: context.outcome } : {}),
      ...(typeof context.jobKind === "string" ? { jobKind: context.jobKind } : {}),
      ...(typeof context.eventType === "string" ? { eventType: context.eventType } : {}),
      ...(typeof context.deliveryStage === "string" ? { deliveryStage: context.deliveryStage } : {}),
      ...(typeof context.lifecycleAttempt === "number" ? { lifecycleAttempt: context.lifecycleAttempt } : {}),
      ...(typeof context.attempt === "number" ? { attempt: context.attempt } : {}),
      ...(typeof context.method === "string" ? { method: context.method } : {}),
      ...(typeof context.route === "string" ? { route: context.route } : {}),
      ...(typeof context.statusCode === "number" ? { statusCode: context.statusCode } : {}),
      ...(typeof context.providerStatusCode === "number" ? { providerStatusCode: context.providerStatusCode } : {}),
      ...(typeof context.providerErrorCode === "string" ? { providerErrorCode: context.providerErrorCode } : {}),
      ...(typeof context.errorCategory === "string" ? { errorCategory: context.errorCategory } : {}),
      ...(typeof context.upstreamResponseSummary === "string" ? { upstreamResponseSummary: context.upstreamResponseSummary } : {}),
      ...(typeof context.discordErrorCode === "string" || typeof context.discordErrorCode === "number" ? { discordErrorCode: context.discordErrorCode } : {}),
      ...(typeof context.discordHttpStatus === "number" ? { discordHttpStatus: context.discordHttpStatus } : {})
    };
    return sanitizeFailureContext(input);
  } catch {
    return undefined;
  }
}

export function sanitizeSentryEvent(event: ErrorEvent): ErrorEvent | null {
  try {
    if (event.message !== undefined) event.message = sanitizeText(event.message, 1_000);
    if (event.logentry?.message !== undefined) event.logentry.message = sanitizeText(event.logentry.message, 1_000);
    if (event.logentry?.params !== undefined) event.logentry.params = event.logentry.params.map((value) => typeof value === "string" ? sanitizeText(value, 500) : "[REDACTED]");
    const tags = scrubTags(event.tags);
    const breadcrumbs = scrubBreadcrumbs(event.breadcrumbs);
    if (tags === undefined) delete event.tags;
    else event.tags = tags;
    if (breadcrumbs === undefined) delete event.breadcrumbs;
    else event.breadcrumbs = breadcrumbs;
    scrubException(event);

    delete event.request;
    delete event.user;
    delete event.extra;
    delete event.server_name;
    delete event.fingerprint;
    delete event.threads;
    delete event.debug_meta;

    const trace = scrubTraceContext(event.contexts?.trace);
    const lifecycle = scrubLifecycleContext(event.contexts?.lifecycle);
    event.contexts = {
      ...(trace === undefined ? {} : { trace }),
      ...(lifecycle === undefined ? {} : { lifecycle })
    };
    return event;
  } catch {
    return null;
  }
}

function safeTransactionName(value: string | undefined): string {
  if (value === undefined) return "transaction";
  const match = /^(?:(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)\s+)?(\/[^?#]*)$/u.exec(value);
  if (match === null) return "transaction";
  const route = safeRoute(match[2]);
  return route === undefined ? "transaction" : `${match[1] === undefined ? "" : `${match[1]} `}${route}`;
}

function scrubSpan(span: SpanJSON): SpanJSON {
  const op = safeLabel(span.op, 80);
  if (op === undefined) {
    delete span.op;
  } else {
    span.op = op;
  }
  if (span.description !== undefined) span.description = op ?? "operation";
  const data = span.data;
  if (data !== undefined) {
    const clean: NonNullable<SpanJSON["data"]> = {};
    for (const [key, value] of Object.entries(data)) {
      if (!SAFE_SPAN_DATA.has(key)) continue;
      if (typeof value === "string") {
        const safe = key === "http.method" || key === "http.request.method"
          ? (HTTP_METHODS.has(value.toUpperCase()) ? value.toUpperCase() : undefined)
          : safeLabel(value, 100);
        if (safe !== undefined) clean[key] = safe;
      } else if (typeof value === "number" && Number.isFinite(value)) {
        clean[key] = value;
      }
    }
    span.data = clean;
  }
  return span;
}

export function sanitizeSentryTransaction(event: TransactionEvent): TransactionEvent | null {
  try {
    const originalTransaction = event.transaction;
    if (sanitizeSentryEvent(event as unknown as ErrorEvent) === null) return null;
    event.transaction = safeTransactionName(originalTransaction);
    if (event.spans !== undefined) event.spans = event.spans.map(scrubSpan);
    return event;
  } catch {
    return null;
  }
}

function sanitizeLogValue(value: unknown): unknown {
  if (typeof value === "string") return sanitizeText(value, 1_000);
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  return "[REDACTED]";
}

export function sanitizeSentryLog(log: Log): Log | null {
  try {
    const attributes = log.attributes ?? {};
    const safeAttributes: NonNullable<Log["attributes"]> = {};
    for (const [key, value] of Object.entries(attributes)) {
      if (SAFE_TAGS.has(key) || key === "service") safeAttributes[key] = sanitizeLogValue(value);
    }
    log.attributes = safeAttributes;
    log.message = sanitizeText(log.message, 1_000);
    return log;
  } catch {
    return null;
  }
}
