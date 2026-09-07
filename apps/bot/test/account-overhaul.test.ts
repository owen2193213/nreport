/* eslint-disable @typescript-eslint/require-await, @typescript-eslint/no-unused-vars */
import { describe, expect, it, vi } from "vitest";

import { AccountBotDatabase } from "../src/account-database.js";
import { AccountNotificationWorker } from "../src/account-notifier.js";
import { loadBotConfig } from "../src/config.js";
import { reportEventIngestionStatus } from "../src/health.js";
import { DsaApiError } from "@nreport/contracts";

describe("thin account client configuration", () => {
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

  it("allows only one worker to claim creation of a report status card", async () => {
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

  it("coalesces older pending notifications after a newer event arrives", async () => {
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

    await database.ingestEvent({ eventId: "9", accountId: "account-1", reportId: "report-1", type: "report_writing", occurredAt: "2026-09-04T00:00:00.000Z", lifecycleAttempt: 1 });

    expect(client.query.mock.calls.some(([sql, values]) =>
      String(sql).includes("SET state = 'ignored'") && values?.includes("report-1") && values?.includes("9")
    )).toBe(true);
    expect(client.query.mock.calls.some(([sql]) => String(sql).includes("now() + interval '2 seconds'"))).toBe(true);
  });

  it("spaces ordinary status-card edits while allowing terminal events through immediately", async () => {
    const query = vi.fn(async (_sql: string, _values?: unknown[]) => ({ rows: [], rowCount: 0 }));
    const database = new AccountBotDatabase({ query } as never);

    await database.claimNotification();

    const sql = String(query.mock.calls[0]?.[0]);
    expect(sql).toContain("last_card_edit_at <= now() - interval '5 seconds'");
    expect(sql).toContain("'discord:actioned'");
    expect(sql).toContain("'discord:review_not_approved'");
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
      events: vi.fn(async () => ({ items: [{ eventId: "7", accountId: "account-1", reportId: "report-2", type: "report_queued", occurredAt: "2026-09-04T00:00:00.000Z", lifecycleAttempt: 1 }], next: null }))
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
