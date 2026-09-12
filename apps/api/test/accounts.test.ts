/* eslint-disable @typescript-eslint/require-await, @typescript-eslint/no-unsafe-member-access */
import { describe, expect, it, vi } from "vitest";

import {
  ApiKeyError,
  AccountRepository,
  CreditError,
  createApiKey,
  hashApiKey,
  normalizeUsername,
  parseApiKey,
  verifyApiKeyHash
} from "../src/accounts.js";
import { loadConfig } from "../src/config.js";
import type { AppConfig } from "../src/config.js";
import { buildV2Server } from "../src/server-v2.js";

function configEnv(): NodeJS.ProcessEnv {
  return {
    DATABASE_URL: "postgres://localhost/test",
    REPORT_EMAIL_DOMAIN: "reports.example.test",
    SESSION_ENCRYPTION_KEY: Buffer.alloc(32).toString("base64"),
    CLOUDFLARE_EMAIL_WEBHOOK_SECRET: "c".repeat(32),
    NREPORT_ADMIN_KEY: "a".repeat(32),
    API_KEY_PEPPER: "p".repeat(32),
    AI_API_KEY: "ai-secret",
    BRAVE_SEARCH_API_KEY: "brave-secret"
  };
}

describe("API account security primitives", () => {
  it("issues parseable keys without retaining a recoverable secret in the digest", () => {
    const issued = createApiKey();
    const parsed = parseApiKey(issued.plaintext);
    const digest = hashApiKey(issued.plaintext, "p".repeat(32));

    expect(issued.plaintext).toMatch(/^dsa_live_[0-9a-f-]{36}_[A-Za-z0-9_-]{43}$/);
    expect(parsed).toEqual({ keyId: issued.keyId, prefix: issued.prefix });
    expect(digest).toHaveLength(64);
    expect(digest).not.toContain(issued.secret);
  });

  it("verifies a peppered digest and rejects wrong or malformed keys", () => {
    const issued = createApiKey();
    const digest = hashApiKey(issued.plaintext, "p".repeat(32));

    expect(verifyApiKeyHash(issued.plaintext, digest, "p".repeat(32))).toBe(true);
    expect(verifyApiKeyHash(`${issued.plaintext}x`, digest, "p".repeat(32))).toBe(false);
    expect(() => parseApiKey("not-a-key")).toThrow(ApiKeyError);
  });

  it("normalizes case only for uniqueness while retaining the immutable display name", () => {
    expect(normalizeUsername("  Alice.Example  ")).toEqual({
      username: "Alice.Example",
      normalized: "alice.example"
    });
    expect(() => normalizeUsername("not valid spaces")).toThrow(ApiKeyError);
  });

  it("assigns the managed webhook destination to a newly created account by default", async () => {
    const query = vi.fn(async (sql: string, _values?: unknown[]) => {
      void _values;
      return {
      rows: sql.includes("INSERT INTO api_accounts")
        ? [{ created_at: new Date("2026-09-12T00:00:00.000Z") }]
        : [],
      rowCount: 1
      };
    });
    const client = { query, release: vi.fn() };
    const DefaultedAccountRepository = AccountRepository as unknown as new (
      pool: { connect: () => Promise<typeof client> },
      apiKeyPepper: string,
      managedDefaultDestinationId?: string
    ) => AccountRepository;
    const repository = new DefaultedAccountRepository(
      { connect: async () => client },
      "p".repeat(32),
      "default-destination"
    );

    await expect(repository.createAccount({ username: "Alice" })).resolves.toMatchObject({
      webhookDestinationId: "default-destination"
    });

    const insert = query.mock.calls.find(([sql]) => String(sql).includes("INSERT INTO api_accounts"));
    expect(insert?.[1]).toContain("default-destination");
  });

  it("returns plaintext once while inserting only its prefix and HMAC", async () => {
    const query = vi.fn(async (sql: string, _values?: unknown[]) => {
      void _values;
      if (sql.includes("SELECT 1 FROM api_accounts")) return { rows: [{ exists: 1 }], rowCount: 1 };
      if (sql.includes("SELECT 1 FROM api_keys")) return { rows: [], rowCount: 0 };
      return { rows: [], rowCount: 1 };
    });
    const client = { query, release: vi.fn() };
    const repository = new AccountRepository({ connect: async () => client } as never, "p".repeat(32));

    const issued = await repository.issueKey("account-1");

    const insert = query.mock.calls.find(([sql]) => String(sql).includes("INSERT INTO api_keys"));
    expect(insert).toBeDefined();
    expect(insert?.[1]).toContain(issued.prefix);
    expect(insert?.[1]).not.toContain(issued.plaintext);
    expect(insert?.[1]).not.toContain(issued.secret);
    expect(query).toHaveBeenCalledWith("COMMIT");
  });

  it("requires rotation when an account already has an active key", async () => {
    const client = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("SELECT 1 FROM api_accounts")) return { rows: [{ exists: 1 }], rowCount: 1 };
        if (sql.includes("SELECT 1 FROM api_keys")) return { rows: [{ exists: 1 }], rowCount: 1 };
        return { rows: [], rowCount: 1 };
      }),
      release: vi.fn()
    };
    const repository = new AccountRepository({ connect: async () => client } as never, "p".repeat(32));

    await expect(repository.issueKey("account-1")).rejects.toMatchObject({
      code: "invalid_api_key_operation",
      statusCode: 409
    });
    expect(client.query.mock.calls.some(([sql]) => String(sql).includes("INSERT INTO api_keys"))).toBe(false);
    expect(client.query).toHaveBeenCalledWith("ROLLBACK");
  });

  it("enforces read limits by account instead of by rotating key", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ request_count: 120 }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const repository = new AccountRepository({ query } as never, "p".repeat(32));

    await repository.consumeReadRateLimit("account-1");
    await expect(repository.consumeReadRateLimit("account-1")).rejects.toMatchObject({
      code: "rate_limited",
      statusCode: 429
    });
    expect(query).toHaveBeenNthCalledWith(1, expect.stringContaining("account_read"), ["account-1"]);
  });

  it("locks an account balance and refuses an adjustment below zero", async () => {
    const client = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("SELECT available_credits")) {
          return { rows: [{ available_credits: 1 }], rowCount: 1 };
        }
        return { rows: [], rowCount: 1 };
      }),
      release: vi.fn()
    };
    const repository = new AccountRepository(
      { connect: async () => client } as never,
      "p".repeat(32)
    );

    await expect(repository.adjustCredits("account-1", -2, "correction")).rejects.toBeInstanceOf(
      CreditError
    );
    expect(client.query).toHaveBeenCalledWith("ROLLBACK");
    expect(client.query.mock.calls.some(([sql]) => String(sql).includes("FOR UPDATE"))).toBe(true);
    expect(client.release).toHaveBeenCalledOnce();
  });

  it("suspends a pre-boundary retry on a consumed chain without refunding it", async () => {
    const account = {
      id: "account-1", username: "Alice", status: "suspended" as const,
      available_credits: 0, reserved_credits: 0, webhook_destination_id: null,
      created_at: new Date("2026-09-04T00:00:00.000Z")
    };
    const client = {
      query: vi.fn(async (sql: string, _values?: unknown[]) => {
        void _values;
        if (sql.includes("UPDATE api_accounts SET status")) return { rows: [account], rowCount: 1 };
        if (sql.includes("FROM account_reports AS report")) {
          return { rows: [{ id: "retry-1", credit_chain_id: "chain-1", credit_state: "consumed", lifecycle_attempt: 2 }], rowCount: 1 };
        }
        if (sql.includes("INSERT INTO account_report_events")) return { rows: [{ id: "1" }], rowCount: 1 };
        return { rows: [], rowCount: 1 };
      }),
      release: vi.fn()
    };
    const pool = {
      connect: async () => client,
      query: vi.fn(async () => ({ rows: [account], rowCount: 1 }))
    };
    const repository = new AccountRepository(pool as never, "p".repeat(32));

    await repository.setAccountStatus("account-1", "suspended", "policy violation");

    expect(client.query.mock.calls.some(([sql]) => String(sql).includes("chain.state IN ('reserved', 'consumed')"))).toBe(true);
    expect(client.query.mock.calls.some(([sql]) => String(sql).includes("available_credits = available_credits + 1"))).toBe(false);
    expect(client.query.mock.calls.some(([sql, values]) => String(sql).includes("account_suspended") && values?.includes("retry-1"))).toBe(true);
  });

  it("requires a provider-neutral AI key and defaults to the Cerebras Qwen model", () => {
    const base = configEnv();

    expect(loadConfig(base)).toMatchObject({
      adminApiKey: "a".repeat(32),
      apiKeyPepper: "p".repeat(32),
      aiApiKey: "ai-secret",
      aiModel: "qwen-3.8-27b"
    });
    expect(() => loadConfig({ ...base, API_KEY_PEPPER: "short" })).toThrow(
      /API_KEY_PEPPER/
    );
    expect(() => loadConfig({ ...base, AI_API_KEY: "" })).toThrow(/AI_API_KEY/);
  });

  it("requires an operations alert webhook in production", () => {
    expect(() => loadConfig({ ...configEnv(), NODE_ENV: "production" })).toThrow(/OPERATIONS_ALERT_WEBHOOK_URL/);
    expect(loadConfig({
      ...configEnv(), NODE_ENV: "production",
      OPERATIONS_ALERT_WEBHOOK_URL: "https://discord.com/api/webhooks/123/token"
    }).operationsAlertWebhookUrl).toBe("https://discord.com/api/webhooks/123/token");
  });

  it("loads a complete managed bot webhook configuration", () => {
    const webhook = loadConfig({
      ...configEnv(),
      BOT_EVENT_WEBHOOK_URL: "http://nreportdiscord-dsa-bot.railway.internal:3000/internal/report-events",
      BOT_EVENT_WEBHOOK_SECRET: "b".repeat(32),
      ALLOW_RAILWAY_PRIVATE_HTTP_WEBHOOKS: "true"
    });

    expect(webhook).toMatchObject({
      botEventWebhook: {
        url: "http://nreportdiscord-dsa-bot.railway.internal:3000/internal/report-events",
        signingSecret: "b".repeat(32)
      }
    });
  });

  it("defaults lifecycle concurrency to two", () => {
    expect(loadConfig(configEnv()).lifecycleConcurrency).toBe(2);
  });

  it.each(["1", "8", "16"])("accepts lifecycle concurrency %s", (value) => {
    expect(loadConfig({ ...configEnv(), LIFECYCLE_CONCURRENCY: value }).lifecycleConcurrency).toBe(Number(value));
  });

  it("rejects lifecycle concurrency below one", () => {
    expect(() => loadConfig({ ...configEnv(), LIFECYCLE_CONCURRENCY: "0" })).toThrow(/LIFECYCLE_CONCURRENCY/);
  });

  it("rejects lifecycle concurrency above sixteen", () => {
    expect(() => loadConfig({ ...configEnv(), LIFECYCLE_CONCURRENCY: "17" })).toThrow(/LIFECYCLE_CONCURRENCY/);
  });

  it("authenticates account and administrator routes independently", async () => {
    const principal = {
      accountId: "11111111-1111-4111-8111-111111111111",
      username: "Alice",
      status: "active" as const,
      availableCredits: 3,
      reservedCredits: 1,
      keyPrefix: "dsa_live_key"
    };
    const accounts = {
      authenticate: vi.fn(async (key: string) => key === "personal-key" ? principal : null),
      accountView: vi.fn(async () => ({
        ...principal,
        usage: { aiRequests: 2, inputTokens: 10, outputTokens: 5, searchRequests: 1 }
      })),
      createAccount: vi.fn(async () => ({
        accountId: principal.accountId,
        username: "Alice",
        status: "active" as const,
        availableCredits: 0,
        reservedCredits: 0,
        webhookDestinationId: null,
        createdAt: "2026-09-04T00:00:00.000Z"
      }))
    };
    const config = {
      adminApiKey: "admin-key",
      apiKeyPepper: "p".repeat(32),
      aiApiKey: "ai-key",
      aiModel: "model",
      braveSearchApiKey: "brave-key",
      lifecycleConcurrency: 2,
      preparationConcurrency: 2,
      databaseUrl: "postgres://unused",
      emailDomain: "reports.example.test",
      environment: "test",
      port: 3000,
      sessionEncryptionKey: Buffer.alloc(32),
      webhookSecret: "w".repeat(32),
      workerEnabled: false
    } satisfies AppConfig;
    const server = await buildV2Server(config, {
      healthcheck: vi.fn(),
      accounts,
      reports: {} as never
    } as never);

    const accountResponse = await server.inject({
      method: "GET",
      url: "/v1/discord/dsa/account",
      headers: { authorization: "Bearer personal-key" }
    });
    const rejectedAdmin = await server.inject({
      method: "POST",
      url: "/v1/admin/discord/dsa/accounts",
      headers: { authorization: "Bearer personal-key" },
      payload: { username: "Alice" }
    });
    const acceptedAdmin = await server.inject({
      method: "POST",
      url: "/v1/admin/discord/dsa/accounts",
      headers: { authorization: "Bearer admin-key" },
      payload: { username: "Alice" }
    });

    expect(accountResponse.statusCode).toBe(200);
    expect(accountResponse.json()).toMatchObject({ accountId: principal.accountId });
    expect(rejectedAdmin.statusCode).toBe(401);
    expect(rejectedAdmin.json().error.requestId).toBeTruthy();
    expect(accounts.createAccount).toHaveBeenCalledOnce();
    expect(acceptedAdmin.statusCode).toBe(201);
    await server.close();
  });
});
