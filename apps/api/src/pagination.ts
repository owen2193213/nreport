const MAX_EVENT_ID = 9223372036854775807n;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isEventCursor(value: unknown): value is string | null {
  return value === null || (typeof value === "string" && /^\d{1,19}$/.test(value) && BigInt(value) <= MAX_EVENT_ID);
}

export function isReportCursor(value: unknown): value is { createdAt: string; id: string } {
  if (typeof value !== "object" || value === null) return false;
  const { createdAt, id } = value as Record<string, unknown>;
  if (typeof id !== "string" || !UUID.test(id) || typeof createdAt !== "string") return false;
  // Cursors emitted by PostgreSQL retain six fractional digits; old cursors used
  // three. Validate the calendar date without discarding that SQL precision.
  const parts = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})\.(\d{1,6})Z$/.exec(createdAt);
  if (parts === null || createdAt.startsWith("0000-")) return false;
  const normalized = `${parts[1]}.${parts[2]!.padEnd(3, "0").slice(0, 3)}Z`;
  const date = new Date(normalized);
  return Number.isFinite(date.getTime()) && date.toISOString() === normalized;
}
