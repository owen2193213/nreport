interface LogFields { [key: string]: unknown }
type LogLevel = "info" | "warn" | "error";

export function preparationLog(event: string, fields: LogFields = {}, level: LogLevel = "info"): void {
  const record = JSON.stringify({
    timestamp: new Date().toISOString(),
    level,
    service: "discord-dsa-api",
    event,
    ...fields
  });
  (level === "error" ? process.stderr : process.stdout).write(`${record}\n`);
}
