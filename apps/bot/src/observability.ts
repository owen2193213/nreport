interface LogFields {
  [key: string]: boolean | number | string | null | undefined;
}

type LogLevel = "info" | "warn" | "error";

export function errorFields(error: unknown): LogFields {
  if (!(error instanceof Error)) return { errorType: typeof error };
  const candidate = error as Error & { code?: string | number; status?: number };
  return {
    errorName: error.name,
    ...(candidate.code === undefined ? {} : { errorCode: String(candidate.code) }),
    ...(candidate.status === undefined ? {} : { httpStatus: candidate.status })
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
