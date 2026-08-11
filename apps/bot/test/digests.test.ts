import { describe, expect, it, vi } from "vitest";

import { closedDigestPeriod } from "../src/digest-periods.js";
import { BotDatabase } from "../src/database.js";
import type { DigestActivity } from "@discord-dsa/contracts";
import { digestMessage } from "../src/digest-ui.js";
import { analyticsFixture, communityFixture } from "./analytics-fixtures.js";

function activityFixture(newReports: number, outcomeChanges: number): DigestActivity {
  return {
    interval: {
      period: "custom", startAt: "2026-08-03T00:00:00.000Z", endAt: "2026-08-10T00:00:00.000Z",
      asOf: "2026-08-11T12:00:00.000Z", timezone: "UTC"
    },
    newReports,
    outcomeChanges: {
      total: outcomeChanges, actioned: outcomeChanges, closedNoAction: 0,
      appealActioned: 0, appealDenied: 0
    },
    eligible: newReports >= 3 || outcomeChanges >= 3
  };
}

describe("closed digest periods", () => {
  it("uses the previous UTC day", () => {
    expect(closedDigestPeriod("daily", new Date("2026-08-11T12:30:00Z"))).toEqual({
      startAt: new Date("2026-08-10T00:00:00.000Z"),
      endAt: new Date("2026-08-11T00:00:00.000Z")
    });
  });

  it("uses Monday-to-Monday ISO weeks", () => {
    expect(closedDigestPeriod("weekly", new Date("2026-08-11T12:30:00Z"))).toEqual({
      startAt: new Date("2026-08-03T00:00:00.000Z"),
      endAt: new Date("2026-08-10T00:00:00.000Z")
    });
  });

  it("uses the previous UTC calendar month", () => {
    expect(closedDigestPeriod("monthly", new Date("2026-08-11T12:30:00Z"))).toEqual({
      startAt: new Date("2026-07-01T00:00:00.000Z"),
      endAt: new Date("2026-08-01T00:00:00.000Z")
    });
  });

  it("creates digest jobs idempotently for the exact closed period", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const database = new BotDatabase("postgres://unused", { query } as never);
    const period = closedDigestPeriod("weekly", new Date("2026-08-11T12:30:00Z"));

    await database.ensureDigestJob("user-1", "weekly", period);

    expect(String(query.mock.calls[0]?.[0])).toContain("ON CONFLICT");
    expect(query.mock.calls[0]?.[1]).toEqual(["user-1", "weekly", period.startAt, period.endAt]);
  });

  it("renders a bounded weekly digest without personal report content or ban claims", async () => {
    const payload = await digestMessage({
      frequency: "weekly",
      activity: activityFixture(3, 4),
      personal: analyticsFixture(),
      community: communityFixture()
    });
    const text = JSON.stringify(payload);
    expect(text).toContain("Your week in reports");
    expect(text).toContain("Community snapshot");
    expect(text).toContain("/analytics");
    expect(text.toLowerCase()).not.toContain("ban");
    expect(text).not.toContain("submitted explanation");
  });

  it("omits the Community snapshot when privacy thresholds are not met", async () => {
    const payload = await digestMessage({
      frequency: "monthly",
      activity: activityFixture(3, 0),
      personal: analyticsFixture(),
      community: communityFixture({ availability: "insufficient_community_data" })
    });
    expect(JSON.stringify(payload)).not.toContain("Community snapshot");
  });
});
