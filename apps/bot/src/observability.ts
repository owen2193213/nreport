interface LogFields {
  [key: string]: unknown;
}

type LogLevel = "info" | "warn" | "error";

export function errorFields(error: unknown): LogFields {
  if (!(error instanceof Error)) return { errorType: typeof error };
  const candidate = error as Error & {
    code?: string | number;
    status?: number;
    rawError?: { message?: string; code?: number; errors?: unknown };
  };
  return {
    errorName: error.name,
    errorMessage: error.message,
    ...(candidate.code === undefined ? {} : { errorCode: String(candidate.code) }),
    ...(candidate.status === undefined ? {} : { httpStatus: candidate.status }),
    ...(candidate.rawError?.errors === undefined ? {} : { validationErrors: candidate.rawError.errors })
  };
}

export function botLog(event: string, fields: LogFields = {}, level: LogLevel = "info"): void {
  const record = JSON.stringify({
    timestamp: new Date().toISOString(),
    level,
    service: "discord-dsa-bot",
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
import { createHmac } from "node:crypto";
