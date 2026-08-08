import { describe, expect, it, vi } from "vitest";

import { DsaApi, GUILD_REPORT_REASONS, USER_MESSAGE_REPORT_REASONS } from "../src/index.js";

describe("report contracts", () => {
  it("keeps report reason catalogs within Discord select limits", () => {
    expect(USER_MESSAGE_REPORT_REASONS).toHaveLength(18);
    expect(GUILD_REPORT_REASONS).toHaveLength(5);
    expect(USER_MESSAGE_REPORT_REASONS.length).toBeLessThanOrEqual(25);
  });

  it("uses the interaction id as the stable create idempotency key", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ internalReportId: "report-1" }), {
        status: 202,
        headers: { "content-type": "application/json" }
      })
    );
    const api = new DsaApi({
      baseUrl: "https://api.example.test",
      apiKey: "secret",
      fetch: fetchMock
    });
    await api.createReport("123456789012345678", {
      country: "DE",
      flow: "message_urf",
      reportReason: "The message contains hateful content.",
      reportType: "sub_other_hate_speech",
      submitterDiscordUserId: "1197857362942378017",
      messageUrl: "https://discord.com/channels/@me/123456789012345678/123456789012345679",
      context: "Test context"
    });

    const init = fetchMock.mock.calls[0]?.[1];
    expect(new Headers(init?.headers).get("idempotency-key")).toBe(
      "create:123456789012345678"
    );
    expect(JSON.parse(init?.body as string)).toMatchObject({
      reportReason: "The message contains hateful content."
    });
  });

  it("uses an appeal-specific idempotency key for a manual appeal retry", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ internalReportId: "report-1" }), {
        status: 202,
        headers: { "content-type": "application/json" }
      })
    );
    const api = new DsaApi({
      baseUrl: "https://api.example.test",
      apiKey: "secret",
      fetch: fetchMock
    });

    await api.retryAppeal(
      "report/with spaces",
      "123456789012345678",
      "1197857362942378017"
    );

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toBe(
      "https://api.example.test/v1/reports/report%2Fwith%20spaces/retry-appeal"
    );
    expect(init?.method).toBe("POST");
    expect(new Headers(init?.headers).get("idempotency-key")).toBe(
      "appeal-retry:123456789012345678"
    );
    expect(JSON.parse(init?.body as string)).toEqual({
      submitterDiscordUserId: "1197857362942378017"
    });
  });
});
