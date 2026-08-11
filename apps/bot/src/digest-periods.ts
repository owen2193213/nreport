import type { DigestFrequency } from "./notification-preferences.js";

export interface DigestPeriod {
  startAt: Date;
  endAt: Date;
}

export function closedDigestPeriod(
  frequency: Exclude<DigestFrequency, "off">,
  now = new Date()
): DigestPeriod {
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  if (frequency === "daily") {
    return { startAt: new Date(today.getTime() - 86_400_000), endAt: today };
  }
  if (frequency === "weekly") {
    const daysSinceMonday = (today.getUTCDay() + 6) % 7;
    const endAt = new Date(today.getTime() - daysSinceMonday * 86_400_000);
    return { startAt: new Date(endAt.getTime() - 7 * 86_400_000), endAt };
  }
  const endAt = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
  return {
    startAt: new Date(Date.UTC(endAt.getUTCFullYear(), endAt.getUTCMonth() - 1, 1)),
    endAt
  };
}
