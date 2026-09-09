interface LogFields { [key: string]: unknown }
type LogLevel = "info" | "warn" | "error";

export function requestAbortSignal(
  deadline: number,
  requestTimeoutMs: number,
  callerSignal?: AbortSignal
): AbortSignal {
  if (callerSignal?.aborted) return AbortSignal.abort(callerSignal.reason);
  const timeout = AbortSignal.timeout(
    Math.max(0, Math.min(requestTimeoutMs, deadline - Date.now()))
  );
  return callerSignal ? AbortSignal.any([callerSignal, timeout]) : timeout;
}

export function responseSize(response: Response): number | undefined {
  const header = response.headers.get("content-length");
  if (header === null) return undefined;
  const value = Number(header);
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

export function providerCodeCategory(value: unknown): "missing" | "number" | "string" | "other" {
  if (value === undefined || value === null) return "missing";
  if (typeof value === "number") return "number";
  if (typeof value === "string") return "string";
  return "other";
}

export function preparationLog(event: string, fields: LogFields = {}, level: LogLevel = "info"): void {
  const record = JSON.stringify({
    timestamp: new Date().toISOString(),
    level,
    service: "nreport-discord-dsa-api",
    event,
    ...fields
  });
  (level === "error" ? process.stderr : process.stdout).write(`${record}\n`);
}
