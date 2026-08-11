import { describe, expect, it, vi } from "vitest";
import { ANALYTICS_PERIODS, DsaApi } from "../src/index.js";

describe("analytics contracts", () => {
  it("keeps the approved period catalog stable", () => {
    expect(ANALYTICS_PERIODS).toEqual(["24h", "7d", "30d", "ytd", "365d", "all"]);
  });

  it("encodes personal, community, and history requests", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ availability: "available" })
    });
    const api = new DsaApi({
      baseUrl: "https://api.example.test",
      apiKey: "test-key",
      fetch: fetchMock as typeof fetch
    });

    await api.analyticsFor("1197857362942378017", "7d");
    await api.communityAnalytics("30d");
    await api.actionHistory("1197857362942378017", {
      period: "7d",
      limit: 10
    });

    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      "https://api.example.test/v1/users/1197857362942378017/analytics?period=7d",
      "https://api.example.test/v1/analytics/community?period=30d",
      "https://api.example.test/v1/users/1197857362942378017/action-history?period=7d&limit=10"
    ]);
  });

  it("encodes exact-range analytics and digest activity requests", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({}) });
    const api = new DsaApi({
      baseUrl: "https://api.example.test", apiKey: "test-key", fetch: fetchMock as typeof fetch
    });
    const startAt = "2026-08-03T00:00:00.000Z";
    const endAt = "2026-08-10T00:00:00.000Z";

    await api.analyticsForRange("1197857362942378017", startAt, endAt);
    await api.communityAnalyticsForRange(startAt, endAt);
    await api.digestActivity("1197857362942378017", startAt, endAt);

    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      "https://api.example.test/v1/users/1197857362942378017/analytics?startAt=2026-08-03T00%3A00%3A00.000Z&endAt=2026-08-10T00%3A00%3A00.000Z",
      "https://api.example.test/v1/analytics/community?startAt=2026-08-03T00%3A00%3A00.000Z&endAt=2026-08-10T00%3A00%3A00.000Z",
      "https://api.example.test/v1/users/1197857362942378017/digest-activity?startAt=2026-08-03T00%3A00%3A00.000Z&endAt=2026-08-10T00%3A00%3A00.000Z"
    ]);
  });
});
