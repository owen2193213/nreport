import { createHmac } from "node:crypto";

interface LogFields {
  [key: string]: unknown;
}

type LogLevel = "info" | "warn" | "error";
type DiagnosticSink = (event: string, fields: LogFields, level: LogLevel) => void;
let diagnosticSink: DiagnosticSink | undefined;

export function setBotDiagnosticSink(sink: DiagnosticSink | undefined): void {
  diagnosticSink = sink;
}

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
  const rawError = (error as Error & { rawError?: unknown }).rawError;
  return {
    errorName: allowedNames.has(error.name) ? error.name : "Error",
    ...(code === undefined ? {} : { errorCode: code }),
    ...(status === undefined ? {} : { httpStatus: status }),
    ...(isDiscordValidationFailure(error) ? { discordValidation: discordValidationSummary(rawError) } : {})
  };
}

export function isDiscordValidationFailure(error: unknown): boolean {
  const candidate = error as { code?: unknown; status?: unknown } | null;
  return candidate?.status === 400 && String(candidate.code) === "50035";
}

function discordValidationSummary(rawError: unknown): { message?: string; paths: string[] } {
  const candidate = rawError as { message?: unknown; errors?: unknown } | null;
  const paths: string[] = [];
  collectValidationPaths(candidate?.errors, [], paths);
  return {
    ...(typeof candidate?.message === "string" ? { message: candidate.message.slice(0, 1_000) } : {}),
    paths: paths.slice(0, 50)
  };
}

function collectValidationPaths(value: unknown, parents: string[], output: string[]): void {
  if (typeof value !== "object" || value === null) return;
  for (const [key, child] of Object.entries(value)) {
    if (key === "_errors" && Array.isArray(child)) {
      for (const issue of child) {
        const code = typeof (issue as { code?: unknown })?.code === "string" ? (issue as { code: string }).code : "invalid";
        output.push(`${parents.join(".")}:${code}`.slice(0, 256));
      }
    } else {
      collectValidationPaths(child, [...parents, key], output);
    }
  }
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
  try { diagnosticSink?.(event, fields, level); } catch { /* diagnostics never stop bot work */ }
}

export function pseudonymousActorKey(userId: string, secret: string): string {
  return createHmac("sha256", secret)
    .update("ai-usage\0")
    .update(userId)
    .digest("hex")
    .slice(0, 16);
}
