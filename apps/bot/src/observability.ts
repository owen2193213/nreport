import { createHmac } from "node:crypto";

interface LogFields {
  [key: string]: unknown;
}

type LogLevel = "info" | "warn" | "error";

export function errorFields(error: unknown): LogFields {
  if (!(error instanceof Error)) return { errorName: "UnknownError" };
  const candidate = error as Error & {
    code?: string | number;
    status?: number;
  };
  const allowedNames = new Set([
    "AbortError", "AggregateError", "DiscordAPIError", "DsaApiError", "Error",
    "FetchError", "RangeError", "ReferenceError", "SyntaxError", "TypeError"
  ]);
  const code = candidate.code === undefined ? undefined : String(candidate.code).slice(0, 64);
  const status = Number.isInteger(candidate.status) && candidate.status! >= 100 && candidate.status! <= 599
    ? candidate.status
    : undefined;
  return {
    errorName: allowedNames.has(error.name) ? error.name : "Error",
    ...(code === undefined ? {} : { errorCode: code }),
    ...(status === undefined ? {} : { httpStatus: status })
  };
}

export function safeErrorCategory(error: unknown): string {
  const candidate = error as { code?: unknown; status?: unknown; name?: unknown } | null;
  const status = typeof candidate?.status === "number" ? candidate.status : undefined;
  const code = typeof candidate?.code === "string" || typeof candidate?.code === "number"
    ? String(candidate.code)
    : undefined;
  if (status === 401 || status === 403) return "authentication";
  if (status === 429) return "rate_limited";
  if (status !== undefined && status >= 500) return "upstream";
  if (candidate?.name === "AbortError" || code === "ETIMEDOUT") return "timeout";
  if (["ECONNABORTED", "ECONNREFUSED", "ECONNRESET", "ENETUNREACH", "EPIPE"].includes(code ?? "")) return "network";
  if (candidate?.name === "DiscordAPIError") return "discord";
  return "unexpected";
}

export function botLog(event: string, fields: LogFields = {}, level: LogLevel = "info"): void {
  const record = JSON.stringify({
    timestamp: new Date().toISOString(),
    level,
    service: "nreport-discord-dsa-bot",
    event,
    ...fields
  });
  const stream = level === "error" ? process.stderr : process.stdout;
  stream.write(`${record}\n`);
}

export function pseudonymousActorKey(userId: string, secret: string): string {
  return createHmac("sha256", secret)
    .update("ai-usage\0")
    .update(userId)
    .digest("hex")
    .slice(0, 16);
}
