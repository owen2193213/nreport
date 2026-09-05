import { describe, expect, it, vi } from "vitest";
import { ANALYTICS_PERIODS, DsaApi } from "../src/index.js";

describe("analytics contracts", () => {
  it("keeps the approved period catalog stable", () => {
    expect(ANALYTICS_PERIODS).toEqual(["24h", "7d", "30d", "ytd", "365d", "all"]);
  });

  it("encodes personal, community, and history requests", async () => {
    const fetchMock = vi.fn().mockImplementation(() =>
      Promise.resolve(new Response(JSON.stringify({ availability: "available" }), {
        headers: { "content-type": "application/json" }
      }))
    );
    const api = new DsaApi({
      baseUrl: "https://api.example.test",
      apiKey: "test-key",
      fetch: fetchMock as typeof fetch
    });

    await api.analytics({ period: "7d" });
    await api.communityAnalytics("30d");
    await api.actionHistory({
      period: "7d",
      limit: 10
    });

    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      "https://api.example.test/v1/analytics?period=7d",
      "https://api.example.test/v1/analytics/community?period=30d",
      "https://api.example.test/v1/action-history?period=7d&limit=10"
    ]);
  });

  it("encodes exact-range analytics and digest activity requests", async () => {
    const fetchMock = vi.fn().mockImplementation(() =>
      Promise.resolve(new Response("{}", { headers: { "content-type": "application/json" } }))
    );
    const api = new DsaApi({
      baseUrl: "https://api.example.test", apiKey: "test-key", fetch: fetchMock as typeof fetch
    });
    const startAt = "2026-08-03T00:00:00.000Z";
    const endAt = "2026-08-10T00:00:00.000Z";

    await api.analytics({ startAt, endAt });
    await api.digestActivity(startAt, endAt);

    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      "https://api.example.test/v1/analytics?startAt=2026-08-03T00%3A00%3A00.000Z&endAt=2026-08-10T00%3A00%3A00.000Z",
      "https://api.example.test/v1/digest-activity?startAt=2026-08-03T00%3A00%3A00.000Z&endAt=2026-08-10T00%3A00%3A00.000Z"
    ]);
  });
});
