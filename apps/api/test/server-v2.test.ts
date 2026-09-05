/* eslint-disable @typescript-eslint/require-await, @typescript-eslint/no-unsafe-member-access */
import { describe, expect, it, vi } from "vitest";

import type { AppConfig } from "../src/config.js";
import { buildV2Server } from "../src/server-v2.js";

const config = {
  adminApiKey: "admin-key",
  apiKeyPepper: "p".repeat(32),
  aiApiKey: "ai-key",
  aiModel: "model",
  braveSearchApiKey: "brave-key",
  preparationConcurrency: 2,
  databaseUrl: "postgres://unused",
  emailDomain: "reports.example.test",
  environment: "test",
  port: 3000,
  sessionEncryptionKey: Buffer.alloc(32),
  webhookSecret: "w".repeat(32),
  workerEnabled: false
} satisfies AppConfig;

const principal = {
  accountId: "11111111-1111-4111-8111-111111111111",
  username: "Alice",
  status: "active" as const,
  availableCredits: 3,
  reservedCredits: 0,
  keyPrefix: "dsa_live_key"
};

describe("v2 account-owned server", () => {
  it("publishes OpenAPI and creates a queued report without doing preparation inline", async () => {
    const create = vi.fn(async () => ({
      created: true,
      report: {
        id: "22222222-2222-4222-8222-222222222222",
        account_id: principal.accountId,
        flow: "message",
        use_ai: true,
        request_input: {
          flow: "message",
          useAi: true,
          target: {
            messageUrl: "https://discord.com/channels/@me/123456789012345678/123456789012345679"
          }
        },
        prepared_input: null,
        status: "queued",
        lifecycle_attempt: 1,
        created_at: new Date("2026-09-04T00:00:00.000Z"),
        updated_at: new Date("2026-09-04T00:00:00.000Z")
      }
    }));
    const server = await buildV2Server(config, {
      healthcheck: vi.fn(),
      accounts: {
        authenticate: vi.fn(async () => principal),
        accountView: vi.fn(),
        createAccount: vi.fn()
      },
      reports: { create }
    } as never);

    const openapi = await server.inject({ method: "GET", url: "/openapi.json" });
    const catalog = await server.inject({
      method: "GET",
      url: "/v1/discord/dsa/catalog",
      headers: { authorization: "Bearer personal-key" }
    });
    const response = await server.inject({
      method: "POST",
      url: "/v1/discord/dsa/reports",
      headers: {
        authorization: "Bearer personal-key",
        "idempotency-key": "create:interaction-1"
      },
      payload: {
        flow: "message",
        useAi: true,
        target: {
          messageUrl: "https://discord.com/channels/@me/123456789012345678/123456789012345679"
        }
      }
    });

    expect(openapi.statusCode).toBe(200);
    expect(openapi.json().info.title).toBe("NReport API");
    expect(openapi.json().paths["/v1/discord/dsa/reports"].post).toBeDefined();
    expect(openapi.json().paths["/v1/discord/dsa/reports/{reportId}"].get.parameters).toContainEqual(
      expect.objectContaining({ in: "path", name: "reportId", required: true })
    );
    expect(openapi.json().paths["/v1/reports"]).toBeUndefined();
    expect(catalog.json().service).toEqual({ category: "discord", type: "dsa", version: "v1" });
    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({ status: "queued", accountId: principal.accountId });
    expect(create).toHaveBeenCalledOnce();
    await server.close();
  });

  it("returns malformed report identifiers as the same private 404 without querying storage", async () => {
    const findOwned = vi.fn();
    const server = await buildV2Server(config, {
      healthcheck: vi.fn(),
      accounts: { authenticate: vi.fn(async () => principal), accountView: vi.fn(), createAccount: vi.fn() },
      reports: { create: vi.fn(), findOwned }
    } as never);

    const response = await server.inject({
      method: "GET",
      url: "/v1/discord/dsa/reports/not-a-uuid",
      headers: { authorization: "Bearer personal-key" }
    });

    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe("report_not_found");
    expect(findOwned).not.toHaveBeenCalled();
    await server.close();
  });

  it("removes media URLs from account-owned evidence responses", async () => {
    const report = {
      id: "22222222-2222-4222-8222-222222222222",
      account_id: principal.accountId,
      flow: "message",
      use_ai: true,
      request_input: {
        flow: "message",
        useAi: true,
        target: {
          messageUrl: "https://discord.com/channels/@me/123456789012345678/123456789012345679",
          messageEvidence: {
            source: "context_menu",
            status: "captured",
            capturedAt: "2026-09-04T00:00:00.000Z",
            snapshot: {
              messageId: "123456789012345679", channelId: "123456789012345678", channelName: null,
              serverId: null, serverName: null, authorId: "123456789012345680", authorUsername: "target",
              authorDisplayName: null, authorAvatarUrl: "https://cdn.example/avatar.png", authorBot: false,
              content: "evidence", createdAt: "2026-09-04T00:00:00.000Z",
              attachments: [{ name: "proof.txt", url: "https://cdn.example/proof.txt", contentType: "text/plain", size: 8, spoiler: false }],
              embeds: [{ title: "Evidence", description: "Details", url: "https://example.test/source" }]
            }
          }
        }
      },
      prepared_input: null,
      status: "queued",
      credit_state: "reserved",
      lifecycle_attempt: 1,
      created_at: new Date("2026-09-04T00:00:00.000Z"),
      updated_at: new Date("2026-09-04T00:00:00.000Z")
    };
    const server = await buildV2Server(config, {
      healthcheck: vi.fn(),
      accounts: { authenticate: vi.fn(async () => principal), accountView: vi.fn(), createAccount: vi.fn() },
      reports: { create: vi.fn(), findOwned: vi.fn(async () => report), timeline: vi.fn(async () => []) }
    } as never);

    const response = await server.inject({
      method: "GET",
      url: `/v1/discord/dsa/reports/${report.id}`,
      headers: { authorization: "Bearer personal-key" }
    });
    expect(response.body).toContain("proof.txt");
    expect(response.body).not.toContain("authorAvatarUrl");
    expect(response.body).not.toContain("cdn.example");
    expect(response.body).not.toContain("example.test/source");
    await server.close();
  });

  it("uses the common error envelope for missing auth and exhausted credits", async () => {
    const server = await buildV2Server(config, {
      healthcheck: vi.fn(),
      accounts: {
        authenticate: vi.fn(async (key: string) => key === "personal-key" ? principal : null),
        accountView: vi.fn(),
        createAccount: vi.fn()
      },
      reports: {
        create: vi.fn(async () => {
          const error = new Error("No report credits are available.") as Error & { code: string };
          error.code = "credits_exhausted";
          throw error;
        })
      }
    } as never);
    const unauthorized = await server.inject({ method: "GET", url: "/v1/discord/dsa/account" });
    const exhausted = await server.inject({
      method: "POST",
      url: "/v1/discord/dsa/reports",
      headers: { authorization: "Bearer personal-key", "idempotency-key": "create:1" },
      payload: {
        flow: "message",
        useAi: true,
        target: { messageUrl: "https://discord.com/channels/@me/123456789012345678/123456789012345679" }
      }
    });

    expect(unauthorized.statusCode).toBe(401);
    expect(unauthorized.json().error.requestId).toBeTruthy();
    expect(exhausted.statusCode).toBe(402);
    expect(exhausted.json().error).toMatchObject({ code: "credits_exhausted" });
    await server.close();
  });

  it("serves only account-owned reports and the replayable account event feed", async () => {
    const report = {
      id: "22222222-2222-4222-8222-222222222222",
      account_id: principal.accountId,
      flow: "message",
      use_ai: false,
      request_input: {
        flow: "message",
        useAi: false,
        country: "DE",
        category: "illegal_content",
        finalText: "A manual report",
        target: { messageUrl: "https://discord.com/channels/@me/123456789012345678/123456789012345679" }
      },
      prepared_input: { country: "DE", category: "illegal_content", description: "A manual report", finalText: "A manual report" },
      status: "submitted",
      credit_state: "consumed",
      lifecycle_attempt: 1,
      created_at: new Date("2026-09-04T00:00:00.000Z"),
      updated_at: new Date("2026-09-04T00:01:00.000Z")
    };
    const findOwned = vi.fn(async (_accountId: string, reportId: string) => reportId === report.id ? report : null);
    const timeline = vi.fn(async () => [{
      eventId: "1", type: "report_submitted", occurredAt: "2026-09-04T00:01:00.000Z",
      lifecycleAttempt: 1, discordStatus: null, errorCode: null
    }]);
    const listEvents = vi.fn(async () => ({ items: [{
      eventId: "1", accountId: principal.accountId, reportId: report.id,
      type: "report_submitted", occurredAt: "2026-09-04T00:01:00.000Z", lifecycleAttempt: 1
    }], next: null }));
    const server = await buildV2Server(config, {
      healthcheck: vi.fn(),
      accounts: { authenticate: vi.fn(async () => principal), accountView: vi.fn(), createAccount: vi.fn() },
      reports: { create: vi.fn(), findOwned, timeline, listEvents }
    } as never);

    const found = await server.inject({ method: "GET", url: `/v1/discord/dsa/reports/${report.id}`, headers: { authorization: "Bearer personal-key" } });
    const hidden = await server.inject({ method: "GET", url: "/v1/discord/dsa/reports/33333333-3333-4333-8333-333333333333", headers: { authorization: "Bearer personal-key" } });
    const events = await server.inject({ method: "GET", url: "/v1/discord/dsa/events?after=0&limit=25", headers: { authorization: "Bearer personal-key" } });

    expect(found.statusCode).toBe(200);
    expect(found.json().timeline).toHaveLength(1);
    expect(hidden.statusCode).toBe(404);
    expect(hidden.json().error.code).toBe("report_not_found");
    expect(events.json().items[0]).not.toHaveProperty("metadata");
    expect(findOwned).toHaveBeenCalledWith(principal.accountId, report.id);
    expect(listEvents).toHaveBeenCalledWith(principal.accountId, "0", 25);
    await server.close();
  });

  it("creates account-owned retries with required idempotency and mode validation", async () => {
    const retry = vi.fn(async () => ({ created: true, report: {
      id: "44444444-4444-4444-8444-444444444444", account_id: principal.accountId,
      flow: "message", use_ai: true, request_input: { flow: "message", useAi: true, target: { messageUrl: "https://discord.com/channels/@me/123456789012345678/123456789012345679" } },
      prepared_input: null, status: "queued", credit_state: "consumed", lifecycle_attempt: 2,
      created_at: new Date(), updated_at: new Date()
    } }));
    const server = await buildV2Server(config, {
      healthcheck: vi.fn(),
      accounts: { authenticate: vi.fn(async () => principal), accountView: vi.fn(), createAccount: vi.fn() },
      reports: { create: vi.fn(), retry }
    } as never);

    const response = await server.inject({
      method: "POST",
      url: "/v1/discord/dsa/reports/22222222-2222-4222-8222-222222222222/retries",
      headers: { authorization: "Bearer personal-key", "idempotency-key": "retry:interaction-1" },
      payload: { mode: "reuse" }
    });

    expect(response.statusCode).toBe(202);
    expect(retry).toHaveBeenCalledWith(principal.accountId, "22222222-2222-4222-8222-222222222222", "retry:interaction-1", "reuse");
    await server.close();
  });
});
