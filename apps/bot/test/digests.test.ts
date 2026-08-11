import { describe, expect, it, vi } from "vitest";

import { closedDigestPeriod } from "../src/digest-periods.js";
import { BotDatabase } from "../src/database.js";

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
});
