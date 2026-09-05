import { describe, expect, it, vi } from "vitest";

import {
  DSA_ADMIN_BASE_PATH,
  DSA_API_BASE_PATH,
  DsaAdminApi,
  DsaApi,
  DsaApiError,
  NREPORT_DISCORD_DSA_SERVICE
} from "../src/index.js";

describe("account-owned API client", () => {
  it("exports the stable NReport Discord DSA namespace", () => {
    expect(DSA_API_BASE_PATH).toBe("/v1/discord/dsa");
    expect(DSA_ADMIN_BASE_PATH).toBe("/v1/admin/discord/dsa");
    expect(NREPORT_DISCORD_DSA_SERVICE).toEqual({
      category: "discord",
      type: "dsa",
      version: "v1"
    });
  });

  it("creates an AI report with an explicit caller idempotency key and no submitter identity", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ reportId: "report-1", status: "queued" }), {
        status: 202,
        headers: { "content-type": "application/json" }
      })
    );
    const api = new DsaApi({
      baseUrl: "https://api.example.test",
      apiKey: "dsa_live_key_secret",
      fetch: fetchMock
    });

    await api.createReport("create:interaction-1", {
      flow: "message",
      useAi: true,
      target: {
        messageUrl: "https://discord.com/channels/@me/123456789012345678/123456789012345679"
      },
      description: "The message appears to contain unlawful hate speech."
    });

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url instanceof URL ? url.pathname : undefined).toBe("/v1/discord/dsa/reports");
    expect(new Headers(init?.headers).get("idempotency-key")).toBe(
      "create:interaction-1"
    );
    expect(JSON.parse(init?.body as string)).not.toHaveProperty("submitterDiscordUserId");
  });

  it("uses account-scoped reads without a Discord user id", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ reports: [], next: null }), {
        headers: { "content-type": "application/json" }
      })
    );
    const api = new DsaApi({
      baseUrl: "https://api.example.test",
      apiKey: "dsa_live_key_secret",
      fetch: fetchMock
    });

    await api.reports({ after: "cursor-1", limit: 25 });

    const [url] = fetchMock.mock.calls[0] ?? [];
    expect(url instanceof URL ? url.href : undefined).toBe(
      "https://api.example.test/v1/discord/dsa/reports?after=cursor-1&limit=25"
    );
  });

  it("keeps administrator credentials in a separate client", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ accountId: "account-1", username: "alice" }), {
        status: 201,
        headers: { "content-type": "application/json" }
      })
    );
    const admin = new DsaAdminApi({
      baseUrl: "https://api.example.test",
      adminKey: "admin-secret",
      fetch: fetchMock
    });

    await admin.createAccount({ username: "alice" });

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url instanceof URL ? url.pathname : undefined).toBe("/v1/admin/discord/dsa/accounts");
    expect(new Headers(init?.headers).get("authorization")).toBe(
      "Bearer admin-secret"
    );
  });

  it("supports administrator operations that intentionally return no content", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }));
    const admin = new DsaAdminApi({
      baseUrl: "https://api.example.test",
      adminKey: "admin-secret",
      fetch: fetchMock
    });

    await expect(admin.assignWebhookDestination("account-1", null)).resolves.toBeUndefined();

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url instanceof URL ? url.pathname : undefined).toBe("/v1/admin/discord/dsa/accounts/account-1/webhook-destination");
    expect(JSON.parse(init?.body as string)).toEqual({ destinationId: null });
  });

  it("retains the request correlation id from the common error envelope", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: {
            code: "credits_exhausted",
            message: "No report credits are available.",
            requestId: "request-123"
          }
        }),
        { status: 402, headers: { "content-type": "application/json" } }
      )
    );
    const api = new DsaApi({
      baseUrl: "https://api.example.test",
      apiKey: "dsa_live_key_secret",
      fetch: fetchMock
    });

    const error = await api.account().catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(DsaApiError);
    expect(error).toMatchObject({
      status: 402,
      code: "credits_exhausted",
      requestId: "request-123"
    });
  });

  it("wraps non-JSON upstream failures in a stable client error", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response("gateway unavailable", { status: 502, headers: { "content-type": "text/plain" } })
    );
    const api = new DsaApi({
      baseUrl: "https://api.example.test",
      apiKey: "dsa_live_key_secret",
      fetch: fetchMock
    });

    await expect(api.account()).rejects.toMatchObject({
      status: 502,
      code: "unknown_error",
      message: "HTTP 502"
    });
  });
});
