/* eslint-disable @typescript-eslint/require-await, @typescript-eslint/no-unused-vars */
import { describe, expect, it, vi } from "vitest";

import { AccountBotDatabase } from "../src/account-database.js";
import { AccountNotificationWorker } from "../src/account-notifier.js";
import { loadBotConfig } from "../src/config.js";
import { reportEventIngestionStatus } from "../src/health.js";
import * as healthModule from "../src/health.js";
import { DsaApiError } from "@nreport/contracts";
import { errorFields } from "../src/observability.js";

describe("thin account client configuration", () => {
  it("requires a UUID trace ID on webhook lifecycle events", () => {
    const validate = (healthModule as unknown as {
      isReportLifecycleEvent?: (value: unknown) => boolean
    }).isReportLifecycleEvent;
    const base = { eventId: "9", accountId: "11111111-1111-4111-8111-111111111111",
      reportId: "22222222-2222-4222-8222-222222222222", type: "report_writing",
      occurredAt: "2026-09-04T00:00:00.000Z", lifecycleAttempt: 1 };
    expect(validate?.({ ...base, traceId: "33333333-3333-4333-8333-333333333333" })).toBe(true);
    expect(validate?.(base)).toBe(false);
    expect(validate?.({ ...base, traceId: "not-a-uuid" })).toBe(false);
  });
  it("serializes only allowlisted bounded error diagnostics", () => {
    const secret = "canary-api-key-do-not-log";
    const error = Object.assign(new Error(`request failed with ${secret}`), {
      name: "DiscordAPIError",
      code: "50007",
      status: 403,
      rawError: { message: secret, errors: { body: secret } }
    });

    const fields = errorFields(error);

    expect(fields).toEqual({ errorName: "DiscordAPIError", errorCode: "50007", httpStatus: 403 });
    expect(JSON.stringify(fields)).not.toContain(secret);
  });

  it("bounds error codes and normalizes arbitrary error names", () => {
    const error = Object.assign(new Error("not serialized"), {
      name: "secret-custom-name",
      code: "x".repeat(100)
    });

    expect(errorFields(error)).toEqual({ errorName: "Error", errorCode: "x".repeat(64) });
  });

  it("requires only API administration, Discord, database, encryption, and webhook secrets", () => {
    const config = loadBotConfig({
      NREPORT_API_URL: "https://api.example.test",
      NREPORT_ADMIN_KEY: "a".repeat(32),
      DISCORD_APPLICATION_ID: "123456789012345678",
      DISCORD_ADMIN_USER_IDS: "123456789012345678",
      BOT_DATABASE_URL: "postgres://localhost/bot",
      BOT_DATA_ENCRYPTION_KEY: Buffer.alloc(32).toString("base64"),
      DISCORD_BOT_TOKEN: "discord-token"
    });

    expect(config).not.toHaveProperty("aiApiKey");
    expect(config).not.toHaveProperty("braveSearchApiKey");
    expect(config).not.toHaveProperty("apiKey");
  });

  it("returns 409 only for the narrow report-linking race", () => {
    expect(reportEventIngestionStatus("not_tracked_yet")).toBe(409);
    expect(reportEventIngestionStatus("accepted")).toBe(202);
    expect(reportEventIngestionStatus("disconnected")).toBe(202);
  });
});

describe("local account mapping", () => {
  it("updates a rotated key only when Discord user and API account still match", async () => {
    const client = {
      query: vi.fn(async (sql: string, _values?: unknown[]) => {
        if (sql.includes("FROM api_connections") && sql.includes("FOR UPDATE")) {
          return { rows: [{ discord_user_id: "discord-1", account_id: "account-1" }], rowCount: 1 };
        }
        return { rows: [], rowCount: 1 };
      }),
      release: vi.fn()
    };
    const database = new AccountBotDatabase({ connect: async () => client } as never);

    await database.connectAccount("discord-1", {
      accountId: "account-1", username: "Alice", status: "active", availableCredits: 1,
      reservedCredits: 0, keyPrefix: "dsa_live_new", usage: { aiRequests: 0, inputTokens: 0, outputTokens: 0, searchRequests: 0 }
    }, "encrypted-new-key");

    const upsert = client.query.mock.calls.find(([sql]) => String(sql).includes("INSERT INTO api_connections"));
    expect(upsert?.[1]).toContain("encrypted-new-key");
    expect(String(upsert?.[0])).toContain("WHERE api_connections.account_id = EXCLUDED.account_id");
    expect(client.query).toHaveBeenCalledWith("COMMIT");
  });

  it("removes encrypted request evidence as soon as the API report is linked", async () => {
    const query = vi.fn(async () => ({ rows: [], rowCount: 1 }));
    const database = new AccountBotDatabase({ query } as never);

    await database.completeReportLink("link-1", "report-1");

    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("encrypted_request = NULL"),
      ["link-1", "report-1"]
    );
  });

  it("stores target display context encrypted beside the report link", async () => {
    const query = vi.fn(async (_sql: string, _values?: unknown[]) => ({ rows: [{ id: "link-1" }], rowCount: 1 }));
    const database = new AccountBotDatabase({ query } as never);

    await database.beginReportLink("discord-1", "account-1", "create:key", "encrypted-request", "encrypted-context");

    const call = query.mock.calls.find(([sql]) => String(sql).includes("INSERT INTO bot_report_links"));
    expect(call?.[0]).toContain("encrypted_target_context");
    expect(call?.[1]).toContain("encrypted-context");
  });

  it("maps the database card-claim result to acquired or unavailable", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ id: "link-1" }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const database = new AccountBotDatabase({ query } as never);

    await expect(database.claimDmCard("report-1")).resolves.toBe(true);
    await expect(database.claimDmCard("report-1")).resolves.toBe(false);
  });

  it("purges expired pending forms", async () => {
    const query = vi.fn(async () => ({ rows: [], rowCount: 2 }));
    const database = new AccountBotDatabase({ query } as never);

    await database.cleanupExpiredForms();

    expect(query).toHaveBeenCalledWith(expect.stringContaining("expires_at <= now()"));
  });

  it("issues report-scoped coalescing SQL after inserting a new event", async () => {
    const client = {
      query: vi.fn(async (sql: string, _values?: unknown[]) => {
        if (sql.includes("FROM api_connections")) return { rows: [{ discord_user_id: "discord-1" }], rowCount: 1 };
        if (sql.includes("FROM bot_report_links")) return { rows: [{ id: "link-1" }], rowCount: 1 };
        if (sql.includes("INSERT INTO lifecycle_inbox")) return { rows: [{ event_id: "9" }], rowCount: 1 };
        return { rows: [], rowCount: 1 };
      }),
      release: vi.fn()
    };
    const database = new AccountBotDatabase({ connect: async () => client } as never);

    await database.ingestEvent({ eventId: "9", accountId: "account-1", reportId: "report-1", traceId: "33333333-3333-4333-8333-333333333333", type: "report_writing", occurredAt: "2026-09-04T00:00:00.000Z", lifecycleAttempt: 1 });

    expect(client.query.mock.calls.some(([sql, values]) =>
      String(sql).includes("SET state = 'ignored'") && values?.includes("report-1") && values?.includes("9")
    )).toBe(true);
    expect(client.query.mock.calls.some(([sql]) => String(sql).includes("now() + interval '2 seconds'"))).toBe(true);
    const insert = client.query.mock.calls.find(([sql]) => String(sql).includes("INSERT INTO lifecycle_inbox"));
    expect(insert?.[0]).toContain("trace_id");
    expect(insert?.[1]).toContain("33333333-3333-4333-8333-333333333333");
  });

  it("includes edit-spacing and terminal-event exemptions in the claim query", async () => {
    const query = vi.fn(async (_sql: string, _values?: unknown[]) => ({ rows: [], rowCount: 0 }));
    const database = new AccountBotDatabase({ query } as never);

    await database.claimNotification();

    const sql = String(query.mock.calls[0]?.[0]);
    expect(sql).toContain("last_card_edit_at <= now() - interval '5 seconds'");
    expect(sql).toContain("'discord:actioned'");
    expect(sql).toContain("'discord:review_not_approved'");
  });

  it("returns a failed notification claim to pending with bounded retry metadata", async () => {
    const query = vi.fn(async (_sql: string, _values?: unknown[]) => ({ rows: [], rowCount: 1 }));
    const database = new AccountBotDatabase({ query } as never);

    await database.retryNotification("event-1", "network");
    await database.retryNotification("event-2", "x".repeat(400));

    const [sql, values] = query.mock.calls[0]!;
    expect(sql).toContain("state = 'pending'");
    expect(sql).toContain("locked_at = NULL");
    expect(sql).toContain("last_error = $2");
    expect(sql).toContain("run_at = now() + interval '30 seconds'");
    expect(values).toEqual(["event-1", "network"]);
    expect(query.mock.calls[1]?.[1]).toEqual(["event-2", "x".repeat(300)]);
  });

  it("defaults report-denied DMs off while keeping other decisions and problems on", async () => {
    const query = vi.fn(async () => ({ rows: [], rowCount: 0 }));
    const database = new AccountBotDatabase({ query } as never);

    await expect(database.notificationPreferences("discord-1")).resolves.toEqual({
      decisionEnabled: true,
      reportDeniedEnabled: false,
      problemEnabled: true,
      dailyDigest: false,
      weeklyDigest: false
    });
  });
});

describe("account reconciliation", () => {
  it("logs an ingest failure with the event trace and leaves its cursor for retry", async () => {
    const event = {
      eventId: "sensitive-event-id", accountId: "sensitive-account-id",
      reportId: "sensitive-report-id", traceId: "33333333-3333-4333-8333-333333333333",
      type: "report_queued" as const, occurredAt: "2026-09-04T00:00:00.000Z", lifecycleAttempt: 1
    };
    const database = {
      connections: vi.fn(async () => [
        { discord_user_id: "sensitive-user-id", account_id: "sensitive-account-id", encrypted_api_key: "first-key", event_cursor: "0" },
        { discord_user_id: "other-user-id", account_id: "other-account-id", encrypted_api_key: "second-key", event_cursor: "0" }
      ]),
      pendingReportLinks: vi.fn(async () => []), cleanupExpiredForms: vi.fn(),
      ingestEvent: vi.fn().mockRejectedValue(new Error("sensitive database URL")),
      advanceCursor: vi.fn()
    };
    const firstApi = { events: vi.fn(async () => ({ items: [event], next: null })) };
    const secondApi = { events: vi.fn(async () => ({ items: [], next: null })) };
    const logger = vi.fn<(event: string, fields?: Record<string, unknown>, level?: "info" | "warn" | "error") => void>();
    const worker = new AccountNotificationWorker(
      database as never, {} as never,
      { dataEncryptionKey: Buffer.alloc(32), apiBaseUrl: "https://api.example.test" } as never,
      (connection) => (connection.encrypted_api_key === "first-key" ? firstApi : secondApi) as never,
      undefined, logger
    );

    await worker.reconcileOnce();

    expect(logger).toHaveBeenCalledWith("account_reconciliation_event", {
      traceId: event.traceId, eventType: event.type, stage: "event_ingestion", outcome: "failed",
      durationMs: expect.any(Number) as number, failureCategory: "unexpected"
    }, "error");
    expect(database.advanceCursor).not.toHaveBeenCalled();
    expect(secondApi.events).toHaveBeenCalledOnce();
    expect(logger).not.toHaveBeenCalledWith("account_reconciliation_failed", expect.anything(), "error");
    expect(JSON.stringify(logger.mock.calls)).not.toMatch(/sensitive|database URL/);
  });

  it("logs a safe failure and continues reconciling the next connection", async () => {
    const connections = [
      { discord_user_id: "secret-user-1", account_id: "secret-account-1", encrypted_api_key: "first-key", event_cursor: "0" },
      { discord_user_id: "secret-user-2", account_id: "secret-account-2", encrypted_api_key: "second-key", event_cursor: "0" }
    ];
    const database = {
      connections: vi.fn(async () => connections), pendingReportLinks: vi.fn(async () => []),
      cleanupExpiredForms: vi.fn(), ingestEvent: vi.fn(), advanceCursor: vi.fn()
    };
    const firstApi = { events: vi.fn().mockRejectedValue(Object.assign(new Error("network failure secret"), { code: "ECONNRESET" })) };
    const secondApi = { events: vi.fn(async () => ({ items: [], next: null })) };
    const logger = vi.fn<(event: string, fields?: Record<string, unknown>, level?: "info" | "warn" | "error") => void>();
    const worker = new AccountNotificationWorker(
      database as never, {} as never,
      { dataEncryptionKey: Buffer.alloc(32), apiBaseUrl: "https://secret.example.test" } as never,
      (connection) => (connection.encrypted_api_key === "first-key" ? firstApi : secondApi) as never,
      undefined,
      logger
    );

    await worker.reconcileOnce();

    expect(secondApi.events).toHaveBeenCalledOnce();
    expect(logger).toHaveBeenCalledWith(
      "account_reconciliation_failed",
      expect.objectContaining({ stage: "reconciliation", outcome: "failed",
        durationMs: expect.any(Number) as number, failureCategory: "network" }),
      "error"
    );
    expect(logger).toHaveBeenCalledWith(
      "account_reconciliation_completed",
      expect.objectContaining({ stage: "reconciliation", outcome: "completed",
        durationMs: expect.any(Number) as number })
    );
    const serializedLogs = JSON.stringify(logger.mock.calls);
    expect(serializedLogs).not.toContain("secret-user");
    expect(serializedLogs).not.toContain("secret-account");
    expect(serializedLogs).not.toContain("first-key");
    expect(serializedLogs).not.toContain("secret.example.test");
    expect(serializedLogs).not.toContain("network failure secret");
  });

  it("drops a permanently rejected pending request and continues with later links and events", async () => {
    const database = {
      pendingReportLinks: vi.fn(async () => [
        { id: "link-1", idempotency_key: "bad", encrypted_request: "bad-request" },
        { id: "link-2", idempotency_key: "good", encrypted_request: "good-request" }
      ]),
      abandonReportLink: vi.fn(),
      completeReportLink: vi.fn(),
      completeReplacementLink: vi.fn(),
      ingestEvent: vi.fn(async () => "accepted"),
      advanceCursor: vi.fn(),
      cleanupExpiredForms: vi.fn()
    };
    const api = {
      createReport: vi.fn(async (key: string) => {
        if (key === "bad") throw new DsaApiError(409, "idempotency_conflict", "Conflict");
        return { reportId: "report-2" };
      }),
      retryReport: vi.fn(),
      events: vi.fn(async () => ({ items: [{ eventId: "7", accountId: "account-1", reportId: "report-2", traceId: "33333333-3333-4333-8333-333333333333", type: "report_queued", occurredAt: "2026-09-04T00:00:00.000Z", lifecycleAttempt: 1 }], next: null }))
    };
    const decrypt = <T>(value: string): T => (value === "bad-request"
      ? { flow: "message", useAi: true, target: { messageUrl: "https://discord.com/channels/@me/1/2" } }
      : { flow: "message", useAi: true, target: { messageUrl: "https://discord.com/channels/@me/3/4" } }) as T;
    const worker = new AccountNotificationWorker(
      database as never, {} as never,
      { dataEncryptionKey: Buffer.alloc(32), apiBaseUrl: "https://api.example.test" } as never,
      () => api as never,
      decrypt
    );

    await worker.reconcileConnection({ discord_user_id: "discord-1", account_id: "account-1", encrypted_api_key: "key", event_cursor: "0" } as never);

    expect(database.abandonReportLink).toHaveBeenCalledWith("link-1");
    expect(database.completeReportLink).toHaveBeenCalledWith("link-2", "report-2");
    expect(api.events).toHaveBeenCalled();
    expect(database.advanceCursor).toHaveBeenCalledWith("discord-1", "7");
  });

  it("restores the predecessor DM mapping when a replacement response is reconciled", async () => {
    const database = {
      pendingReportLinks: vi.fn(async () => [{ id: "link-3", idempotency_key: "retry-key", encrypted_request: "retry-request" }]),
      abandonReportLink: vi.fn(), completeReportLink: vi.fn(), completeReplacementLink: vi.fn(),
      ingestEvent: vi.fn(), advanceCursor: vi.fn(), cleanupExpiredForms: vi.fn()
    };
    const api = {
      createReport: vi.fn(), retryReport: vi.fn(async () => ({ reportId: "report-new" })),
      events: vi.fn(async () => ({ items: [], next: null }))
    };
    const worker = new AccountNotificationWorker(
      database as never, {} as never,
      { dataEncryptionKey: Buffer.alloc(32), apiBaseUrl: "https://api.example.test" } as never,
      () => api as never,
      <T>() => ({ reportId: "report-old", input: { mode: "rewrite_ai" } }) as T
    );

    await worker.reconcileConnection({ discord_user_id: "discord-1", account_id: "account-1", encrypted_api_key: "key", event_cursor: "0" } as never);

    expect(database.completeReplacementLink).toHaveBeenCalledWith("link-3", "report-new", "report-old");
    expect(database.completeReportLink).not.toHaveBeenCalled();
  });
});
