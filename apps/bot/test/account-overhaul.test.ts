/* eslint-disable @typescript-eslint/require-await, @typescript-eslint/no-unused-vars */
import { createHash, createHmac } from "node:crypto";
import { PassThrough } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";
import type * as ObservabilityPackage from "@nreport/observability";

import { AccountBotDatabase, cardNonce } from "../src/account-database.js";
import { AccountNotificationWorker, isDiscordUnknownMessage, NOTIFICATION_LOOP_COUNT } from "../src/account-notifier.js";
import { loadBotConfig } from "../src/config.js";
import { HealthServer, reportEventIngestionStatus } from "../src/health.js";
import * as healthModule from "../src/health.js";
import { DsaApiError } from "@nreport/contracts";
import { AccountInteractionHandler, shouldAbandonReportLink } from "../src/account-interactions.js";
import { errorFields, setBotDiagnosticSink } from "../src/observability.js";

function cardIdentity(reportId: string) {
  return {
    nonce: cardNonce(reportId), originReportId: reportId, originClaimedAt: new Date(),
    relatedReportIds: [reportId], relatedReportIdsComplete: true
  };
}

const captureLifecycleFailureMock = vi.hoisted(() => vi.fn());
vi.mock("@nreport/observability", async (importOriginal) => {
  const actual = await importOriginal<typeof ObservabilityPackage>();
  return { ...actual, captureLifecycleFailure: captureLifecycleFailureMock };
});

describe("thin account client configuration", () => {
  it("keeps pending links for ambiguous create and retry outcomes", () => {
    expect(shouldAbandonReportLink(new DsaApiError(400, "invalid_request", "invalid"))).toBe(true);
    expect(shouldAbandonReportLink(new DsaApiError(429, "rate_limited", "wait"))).toBe(false);
    expect(shouldAbandonReportLink(new DsaApiError(202, "invalid_response", "malformed success"))).toBe(false);
    expect(shouldAbandonReportLink(new Error("network interrupted"))).toBe(false);
  });

  it("only clears a card mapping for Discord's confirmed unknown-message response", () => {
    expect(isDiscordUnknownMessage({ code: 10008 })).toBe(true);
    expect(isDiscordUnknownMessage({ code: 50001 })).toBe(false);
    expect(isDiscordUnknownMessage(new Error("network"))).toBe(false);
  });

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
  it("retains useful error diagnostics while redacting secrets", () => {
    const secret = "canary-api-key-do-not-log";
    const secretName = "NREPORT_TEST_API_KEY";
    const previousSecret = process.env[secretName];
    process.env[secretName] = secret;
    const error = Object.assign(new Error(`request failed with ${secret}`), {
      name: "DiscordAPIError",
      code: "50007",
      status: 403,
      rawError: { message: secret, errors: { body: secret } }
    });

    try {
      const fields = errorFields(error);

      expect(fields).toMatchObject({ errorName: "DiscordAPIError", errorCode: "50007", httpStatus: 403 });
      expect(fields.errorMessage).toBe(`request failed with [REDACTED_CONFIGURED_SECRET]`);
      expect(typeof fields.errorStack).toBe("string");
      expect(JSON.stringify(fields)).not.toContain(secret);
    } finally {
      if (previousSecret === undefined) delete process.env[secretName];
      else process.env[secretName] = previousSecret;
    }
  });

  it("bounds error codes and normalizes arbitrary error names", () => {
    const error = Object.assign(new Error("not serialized"), {
      name: "secret-custom-name",
      code: "x".repeat(100)
    });

    expect(errorFields(error)).toMatchObject({
      errorName: "Error", errorCode: "x".repeat(64), errorMessage: "not serialized"
    });
  });

  it("retains bounded Error messages, stacks, and causes for diagnosis", () => {
    const cause = Object.assign(new Error("socket closed"), { code: "ECONNRESET" });
    const error = Object.assign(new Error("API request failed"), { cause, status: 503 });

    const fields = errorFields(error);
    expect(fields).toMatchObject({
      errorName: "Error",
      errorMessage: "API request failed",
      errorCauses: [expect.objectContaining({ name: "Error", message: "socket closed" })]
    });
    expect(fields.errorStack).toContain("Error: API request failed");
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

  it("accepts lifecycle events while create-link recovery is in progress", () => {
    expect(reportEventIngestionStatus("not_tracked_yet")).toBe(202);
    expect(reportEventIngestionStatus("accepted")).toBe(202);
    expect(reportEventIngestionStatus("disconnected")).toBe(202);
  });
});

describe("signed lifecycle webhook diagnostics", () => {
  it("logs and captures database ingestion failures, then returns a retryable response", async () => {
    captureLifecycleFailureMock.mockClear();
    const secret = "webhook-secret-for-test";
    const error = Object.assign(new Error("database failed at postgres://bot:secret@db.example.test/nreport"), {
      code: "ECONNRESET"
    });
    const database = { ingestEvent: vi.fn().mockRejectedValue(error) };
    const server = new HealthServer(database as never, () => true, secret);
    const events: Array<{ event: string; fields: Record<string, unknown> }> = [];
    setBotDiagnosticSink((event, fields) => events.push({ event, fields }));
    try {
      const event = {
        eventId: "9", accountId: "11111111-1111-4111-8111-111111111111",
        reportId: "22222222-2222-4222-8222-222222222222", traceId: "33333333-3333-4333-8333-333333333333",
        type: "report_failed", occurredAt: "2026-10-14T00:00:00.000Z", lifecycleAttempt: 2
      };
      const body = JSON.stringify(event);
      const timestamp = String(Math.floor(Date.now() / 1_000));
      const bodyHash = createHash("sha256").update(body).digest("hex");
      const signature = createHmac("sha256", secret).update(`${timestamp}\n${event.eventId}\n${bodyHash}`).digest("hex");
      const privateServer = server as unknown as {
        event(request: IncomingMessage, response: ServerResponse): Promise<void>;
      };
      const invokeEvent = async (): Promise<void> => {
        const request = new PassThrough() as unknown as IncomingMessage;
        request.headers = {
          "x-report-event-id": event.eventId,
          "x-report-event-timestamp": timestamp,
          "x-report-event-signature": signature
        };
        const writeHead = vi.fn();
        const end = vi.fn();
        const response = { writeHead, end } as unknown as ServerResponse;
        const handling = privateServer.event(request, response);
        (request as unknown as PassThrough).end(body);
        await handling;
        expect(writeHead).toHaveBeenCalledWith(503, { "content-type": "application/json" });
        expect(end).toHaveBeenCalledWith(JSON.stringify({ error: "temporarily_unavailable" }));
      };
      await invokeEvent();
      await invokeEvent();

      expect(events).toHaveLength(2);
      expect(events[0]).toMatchObject({
        event: "report_event_ingestion_failed",
        fields: { reportId: event.reportId, traceId: event.traceId, eventType: event.type,
          stage: "webhook_ingestion", outcome: "retrying" }
      });
      expect(events[0]?.fields.errorMessage).toContain("[REDACTED_URL]");
      expect(JSON.stringify(events)).not.toContain("postgres://bot:secret@db.example.test/nreport");
      expect(captureLifecycleFailureMock).toHaveBeenCalledOnce();
      expect(captureLifecycleFailureMock).toHaveBeenCalledWith(error, expect.objectContaining({
        service: "bot", operation: "lifecycle_webhook_ingestion", reportId: event.reportId,
        traceId: event.traceId, eventType: event.type, lifecycleAttempt: 2,
        stage: "webhook_ingestion", outcome: "retrying", severity: "error"
      }));
    } finally {
      setBotDiagnosticSink(undefined);
    }
  });
});

describe("initial card interaction diagnostics", () => {
  it("records safe payload metadata when an interaction card fails Discord validation", async () => {
    const report = {
      reportId: "11111111-1111-4111-8111-111111111111", traceId: "22222222-2222-4222-8222-222222222222", accountId: "account-1",
      flow: "message", useAi: true, status: "queued", creditState: "reserved", lifecycleAttempt: 1,
      country: "DE", category: null, description: null, discordReportId: null, discordStatus: null, reviewStatus: null,
      predecessorReportId: null, successorReportId: null, retryableModes: [], createdAt: "2026-09-09T00:00:00Z", updatedAt: "2026-09-09T00:00:00Z",
      target: { messageUrl: "https://discord.com/channels/@me/123456789012345678/123456789012345679" }, finalText: null,
      legalReference: null, researchSummary: null, sources: [], timeline: [], failure: null
    } as const;
    const validationError = Object.assign(new Error("Invalid Form Body"), {
      code: 50035, status: 400,
      rawError: { message: "Invalid Form Body", errors: { components: { _errors: [{ code: "BASE_TYPE_REQUIRED" }] } } }
    });
    const database = {
      connection: vi.fn(async () => ({ account_id: "account-1", encrypted_api_key: "key" })),
      beginReportLink: vi.fn(async () => "link-1"), completeReportLink: vi.fn(), claimDmCard: vi.fn(async () => cardIdentity(report.reportId)),
      terminalCardRepair: vi.fn()
    };
    const handler = new AccountInteractionHandler({
      client: { user: { id: "bot-user" } } as never,
      config: { apiBaseUrl: "https://api.example.test", adminApiKey: "admin", dataEncryptionKey: Buffer.alloc(32) } as never,
      database: database as never, messageResolver: {} as never, profileResolver: {} as never, serverResolver: {} as never
    });
    const privateHandler = handler as unknown as {
      api: () => { createReport: () => Promise<typeof report> };
      submit: (interaction: unknown, input: unknown, idempotencyKey: string) => Promise<void>;
    };
    vi.spyOn(privateHandler, "api").mockReturnValue({ createReport: vi.fn(async () => report) });
    const diagnostics: Array<{ event: string; fields: Record<string, unknown> }> = [];
    setBotDiagnosticSink((event, fields) => diagnostics.push({ event, fields }));
    try {
      await privateHandler.submit({
        user: { id: "discord-1", createDM: vi.fn(async () => ({ messages: { fetch: vi.fn() }, send: vi.fn(async () => { throw validationError; }) })) },
        editReply: vi.fn()
      }, { flow: "message" }, "create-1");
    } finally {
      setBotDiagnosticSink(undefined);
    }

    const diagnostic = diagnostics.find(({ event }) => event === "initial_card_ignored");
    expect(diagnostic?.fields).toMatchObject({
      discordValidation: { message: "Invalid Form Body", paths: ["components:BASE_TYPE_REQUIRED"] },
      payload: { flags: 32768, nonceLength: 21 }
    });
  });

  it("sends the interaction-path status card with the same deterministic nonce as the notifier", async () => {
    const report = {
      reportId: "11111111-1111-4111-8111-111111111111", traceId: "22222222-2222-4222-8222-222222222222", accountId: "account-1",
      flow: "message", useAi: true, status: "queued", creditState: "reserved", lifecycleAttempt: 1,
      country: "DE", category: null, description: null, discordReportId: null, discordStatus: null, reviewStatus: null,
      predecessorReportId: null, successorReportId: null, retryableModes: [], createdAt: "2026-09-09T00:00:00Z", updatedAt: "2026-09-09T00:00:00Z",
      target: { messageUrl: "https://discord.com/channels/@me/123456789012345678/123456789012345679" }, finalText: null,
      legalReference: null, researchSummary: null, sources: [], timeline: [], failure: null
    } as const;
    const database = {
      connection: vi.fn(async () => ({ account_id: "account-1", encrypted_api_key: "key" })),
      beginReportLink: vi.fn(async () => "link-1"), completeReportLink: vi.fn(), claimDmCard: vi.fn(async () => cardIdentity(report.reportId)),
      setDmMapping: vi.fn(), completeCardUpdate: vi.fn()
    };
    const handler = new AccountInteractionHandler({
      client: { user: { id: "bot-user" } } as never,
      config: { apiBaseUrl: "https://api.example.test", adminApiKey: "admin", dataEncryptionKey: Buffer.alloc(32) } as never,
      database: database as never, messageResolver: {} as never, profileResolver: {} as never, serverResolver: {} as never
    });
    const privateHandler = handler as unknown as {
      api: () => { createReport: () => Promise<typeof report> };
      submit: (interaction: unknown, input: unknown, idempotencyKey: string) => Promise<void>;
    };
    vi.spyOn(privateHandler, "api").mockReturnValue({ createReport: vi.fn(async () => report) });
    const send = vi.fn(async (_options: unknown) => ({ channelId: "dm", id: "card" }));

    await privateHandler.submit({
      user: { id: "discord-1", createDM: vi.fn(async () => ({ messages: { fetch: vi.fn() }, send })) },
      editReply: vi.fn()
    }, { flow: "message" }, "create-1");

    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0]?.[0]).toMatchObject({ nonce: "card-bd7662a5eeb41614", enforceNonce: true });
  });
});

describe("manual retry after an automatic network successor", () => {
  const automaticChild = {
    reportId: "44444444-4444-4444-8444-444444444444",
    traceId: "55555555-5555-4555-8555-555555555555",
    accountId: "account-1",
    predecessorReportId: "11111111-1111-4111-8111-111111111111",
    successorReportId: null,
    automaticNetworkRetry: true,
    retryableModes: ["reuse"]
  };
  const predecessor = {
    reportId: automaticChild.predecessorReportId,
    traceId: "33333333-3333-4333-8333-333333333333",
    accountId: "account-1",
    successorReportId: automaticChild.reportId,
    connectionRecovery: {
      state: "restarting", attempt: 3, maxAttempts: 3, retryAt: null,
      successorReportId: automaticChild.reportId
    }
  };

  function setup() {
    const order: string[] = [];
    const retryReport = vi.fn(async () => {
      order.push("retry");
      return { reportId: "66666666-6666-4666-8666-666666666666", traceId: "77777777-7777-4777-8777-777777777777" };
    });
    const api = {
      report: vi.fn(async (reportId: string) => reportId === automaticChild.reportId ? automaticChild : predecessor),
      retryReport
    };
    const database = {
      connection: vi.fn(async () => ({ account_id: "account-1", encrypted_api_key: "key" })),
      adoptAutomaticNetworkRetry: vi.fn(async () => { order.push("adopt"); return "adopted" as const; }),
      reportTargetContext: vi.fn(async () => null),
      beginReportLink: vi.fn(async () => "retry-link"),
      completeReplacementLink: vi.fn(async () => { order.push("complete"); }),
      claimDmCard: vi.fn(async () => null),
      abandonReportLink: vi.fn(),
      deletePendingForm: vi.fn()
    };
    const handler = new AccountInteractionHandler({
      client: {} as never,
      config: { apiBaseUrl: "https://api.example.test", adminApiKey: "admin", dataEncryptionKey: Buffer.alloc(32) } as never,
      database: database as never, messageResolver: {} as never, profileResolver: {} as never, serverResolver: {} as never
    });
    const privateHandler = handler as unknown as {
      api: () => unknown;
      submitRetry: (interaction: unknown, predecessorReportId: string, input: unknown) => Promise<void>;
      reports: (interaction: unknown) => Promise<void>;
    };
    vi.spyOn(privateHandler, "api").mockReturnValue(api);
    return { handler, privateHandler, api, database, order };
  }

  it("adopts A→B before the status-card retry path creates manual child C", async () => {
    const h = setup();
    const interaction = {
      isModalSubmit: () => false, isButton: () => true,
      isMessageContextMenuCommand: () => false, isChatInputCommand: () => false,
      customId: `report-retry-reuse:${automaticChild.reportId}`, id: "button-retry",
      user: { id: "discord-user" }, deferReply: vi.fn(), editReply: vi.fn(),
      isRepliable: () => true, deferred: true, replied: false
    };

    await h.handler.handle(interaction as never);

    expect(h.api.report.mock.calls.map(([id]) => id)).toEqual([automaticChild.reportId, predecessor.reportId]);
    expect(h.database.adoptAutomaticNetworkRetry).toHaveBeenCalledWith(
      "account-1", predecessor.reportId, automaticChild.reportId
    );
    expect(h.api.retryReport).toHaveBeenCalledWith(automaticChild.reportId, "retry:button-retry", { mode: "reuse" });
    expect(h.database.completeReplacementLink).toHaveBeenCalledWith(
      "retry-link", "66666666-6666-4666-8666-666666666666", automaticChild.reportId
    );
    expect(h.order).toEqual(["adopt", "retry", "complete"]);
  });

  it("adopts A→B before the direct `/reports retry` command creates manual child C", async () => {
    const h = setup();
    const interaction = {
      id: "command-retry",
      user: { id: "discord-user", send: vi.fn() },
      options: {
        getSubcommand: () => "retry",
        getString: (name: string) => name === "report-id" ? automaticChild.reportId : "reuse"
      },
      deferReply: vi.fn(), editReply: vi.fn()
    };

    await h.privateHandler.reports(interaction);

    expect(h.api.report.mock.calls.map(([id]) => id)).toEqual([automaticChild.reportId, predecessor.reportId]);
    expect(h.database.adoptAutomaticNetworkRetry).toHaveBeenCalledWith(
      "account-1", predecessor.reportId, automaticChild.reportId
    );
    expect(h.api.retryReport).toHaveBeenCalledWith(automaticChild.reportId, "retry:command-retry", { mode: "reuse" });
    expect(h.database.completeReplacementLink).toHaveBeenCalledWith(
      "retry-link", "66666666-6666-4666-8666-666666666666", automaticChild.reportId
    );
    expect(h.order).toEqual(["adopt", "retry", "complete"]);
    expect(h.database.claimDmCard).toHaveBeenCalledWith("66666666-6666-4666-8666-666666666666");
  });
});

describe("interaction Sentry diagnostics", () => {
  it("captures the original uncertain retry failure with report, trace, stage, and API status", async () => {
    captureLifecycleFailureMock.mockClear();
    const predecessor = {
      reportId: "11111111-1111-4111-8111-111111111111",
      traceId: "33333333-3333-4333-8333-333333333333",
      accountId: "account-1",
      retryableModes: ["reuse"], successorReportId: null
    };
    const error = new DsaApiError(503, "upstream_unavailable", "API temporarily unavailable", "request-42");
    const database = {
      connection: vi.fn(async () => ({ account_id: "account-1", encrypted_api_key: "key" })),
      reportTargetContext: vi.fn(async () => null), beginReportLink: vi.fn(async () => "link-1"),
      abandonReportLink: vi.fn(), rescheduleReportLink: vi.fn()
    };
    const handler = new AccountInteractionHandler({
      client: {} as never,
      config: { apiBaseUrl: "https://api.example.test", adminApiKey: "admin", dataEncryptionKey: Buffer.alloc(32) } as never,
      database: database as never, messageResolver: {} as never, profileResolver: {} as never, serverResolver: {} as never
    });
    const retryReport = vi.fn(async () => { throw error; });
    const privateHandler = handler as unknown as {
      api: () => { report: () => Promise<typeof predecessor>; retryReport: typeof retryReport };
    };
    vi.spyOn(privateHandler, "api").mockReturnValue({
      report: vi.fn(async () => predecessor), retryReport
    });
    let deferred = false;
    const interaction = {
      isModalSubmit: () => false, isButton: () => true,
      isMessageContextMenuCommand: () => false, isChatInputCommand: () => false,
      customId: `report-retry-reuse:${predecessor.reportId}`, id: "interaction-42",
      user: { id: "discord-user" },
      deferReply: vi.fn(async () => { deferred = true; }),
      editReply: vi.fn().mockResolvedValue(undefined), isRepliable: () => true,
      get deferred() { return deferred; }, replied: false
    };

    await handler.handle(interaction as never);

    expect(captureLifecycleFailureMock).toHaveBeenCalledOnce();
    expect(captureLifecycleFailureMock).toHaveBeenCalledWith(error, expect.objectContaining({
      service: "bot", operation: "report_retry", stage: "api_retry", outcome: "recovery_pending",
      reportId: predecessor.reportId, traceId: predecessor.traceId,
      statusCode: 503, requestId: "request-42"
    }));
    expect(interaction.deferReply).toHaveBeenCalledWith({ flags: 64 });
    expect(interaction.editReply).toHaveBeenCalledWith({
      content: "Your report is being checked. Do not submit it again; its status will update automatically.",
      embeds: []
    });
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
    const database = new AccountBotDatabase({ connect: async () => ({ query, release: vi.fn() }) } as never);

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
    const claimedAt = new Date();
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{
        nonce: cardNonce("report-1"), originReportId: "report-1", originClaimedAt: claimedAt,
        relatedReportIds: ["report-1"], relatedReportIdsComplete: true
      }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const database = new AccountBotDatabase({ query } as never);

    await expect(database.claimDmCard("report-1")).resolves.toEqual({
      nonce: cardNonce("report-1"), originReportId: "report-1", originClaimedAt: claimedAt,
      relatedReportIds: ["report-1"], relatedReportIdsComplete: true
    });
    await expect(database.claimDmCard("report-1")).resolves.toBeNull();
  });

  it("clears a stale card mapping only when it still names the missing message", async () => {
    const query = vi.fn(async () => ({ rows: [{ id: "link-1" }], rowCount: 1 }));
    const database = new AccountBotDatabase({ query } as never);

    await expect(database.clearStaleDmMapping("report-1", "message-1")).resolves.toBe(true);

    expect(query).toHaveBeenCalledWith(expect.stringContaining("dm_message_id = $2"), ["report-1", "message-1"]);
  });

  it("excludes a superseded predecessor from card repair claims", async () => {
    const query = vi.fn(async () => ({ rows: [], rowCount: 0 }));
    const database = new AccountBotDatabase({ query } as never);

    await database.dueCardRepairs("discord-1");

    expect(query).toHaveBeenCalledWith(expect.stringContaining("superseded_by_report_id IS NULL"), ["discord-1"]);
  });

  it("does not claim a card repair after a permanent validation failure", async () => {
    const query = vi.fn<(sql: string, values?: unknown[]) => Promise<{ rows: never[]; rowCount: number }>>(async () => ({ rows: [], rowCount: 1 }));
    const database = new AccountBotDatabase({ query } as never);

    await database.terminalCardRepair("report-1", "discord_validation_50035");
    await database.dueCardRepairs("discord-1");

    expect(String(query.mock.calls[0]?.[0])).toContain("card_repair_terminal_at = now()");
    expect(query.mock.calls[0]?.[1]).toEqual(["report-1", "discord_validation_50035"]);
    expect(String(query.mock.calls[1]?.[0])).toContain("card_repair_terminal_at IS NULL");
  });

  it("uses the lifecycle inbox creation time when correlating a card repair", async () => {
    const query = vi.fn<(sql: string, values?: unknown[]) => Promise<{ rows: never[]; rowCount: number }>>(async () => ({ rows: [], rowCount: 0 }));
    const database = new AccountBotDatabase({ query } as never);

    await database.dueCardRepairs("discord-1");

    const [sql] = query.mock.calls[0]!;
    expect(sql).toContain("ORDER BY created_at DESC");
    expect(sql).not.toContain("received_at");
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
    const poolQuery = vi.fn(async () => ({ rows: [], rowCount: 0 }));
    const database = new AccountBotDatabase({ query: poolQuery, connect: async () => client } as never);

    await database.ingestEvent({ eventId: "9", accountId: "account-1", reportId: "report-1", traceId: "33333333-3333-4333-8333-333333333333", type: "report_writing", occurredAt: "2026-09-04T00:00:00.000Z", lifecycleAttempt: 1 });

    expect(client.query.mock.calls.some(([sql, values]) =>
      String(sql).includes("SET state = 'ignored'") && values?.includes("report-1") && values?.includes("9")
    )).toBe(true);
    expect(client.query.mock.calls.some(([sql]) => String(sql).includes("now() + interval '2 seconds'"))).toBe(true);
    const insert = client.query.mock.calls.find(([sql]) => String(sql).includes("INSERT INTO lifecycle_inbox"));
    expect(insert?.[0]).toContain("trace_id");
    expect(insert?.[1]).toContain("33333333-3333-4333-8333-333333333333");
  });

  it("makes submission and Discord receipt events immediately eligible for status-card updates", async () => {
    const client = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("FROM api_connections")) return { rows: [{ discord_user_id: "discord-1" }], rowCount: 1 };
        if (sql.includes("FROM bot_report_links")) return { rows: [{ id: "link-1" }], rowCount: 1 };
        if (sql.includes("INSERT INTO lifecycle_inbox")) return { rows: [{ event_id: "11" }], rowCount: 1 };
        return { rows: [], rowCount: 1 };
      }),
      release: vi.fn()
    };
    const poolQuery = vi.fn(async (_sql: string) => ({ rows: [], rowCount: 0 }));
    const database = new AccountBotDatabase({ query: poolQuery, connect: async () => client } as never);

    for (const [eventId, type] of [
      ["11", "verification_received"], ["12", "report_submitted"], ["13", "discord:received"]
    ] as const) {
      await database.ingestEvent({
        eventId, accountId: "account-1", reportId: "report-1",
        traceId: "33333333-3333-4333-8333-333333333333",
        type, occurredAt: "2026-09-04T00:00:00.000Z", lifecycleAttempt: 1
      });
    }
    await database.claimNotification();

    const inserts = client.query.mock.calls.filter(([sql]) => String(sql).includes("INSERT INTO lifecycle_inbox"));
    const claim = String(poolQuery.mock.calls[3]?.[0]);
    expect(inserts).toHaveLength(3);
    for (const [sql] of inserts) {
      expect(String(sql)).toContain("'verification_received'");
      expect(String(sql)).toContain("'report_submitted'");
      expect(String(sql)).toContain("'discord:received'");
      expect(String(sql)).toContain("THEN now() ELSE now() + interval '2 seconds'");
    }
    expect(claim).toContain("'verification_received'");
    expect(claim).toContain("'report_submitted'");
    expect(claim).toContain("'discord:received'");
  });

  it("does not coalesce report-denied decisions behind later status events", async () => {
    const client = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("FROM api_connections")) return { rows: [{ discord_user_id: "discord-1" }], rowCount: 1 };
        if (sql.includes("FROM bot_report_links")) return { rows: [{ id: "link-1" }], rowCount: 1 };
        if (sql.includes("INSERT INTO lifecycle_inbox")) return { rows: [{ event_id: "10" }], rowCount: 1 };
        return { rows: [], rowCount: 1 };
      }),
      release: vi.fn()
    };
    const poolQuery = vi.fn(async () => ({ rows: [], rowCount: 0 }));
    const database = new AccountBotDatabase({ query: poolQuery, connect: async () => client } as never);

    await database.ingestEvent({ eventId: "10", accountId: "account-1", reportId: "report-1", traceId: "33333333-3333-4333-8333-333333333333", type: "report_writing", occurredAt: "2026-09-04T00:00:00.000Z", lifecycleAttempt: 1 });

    const coalescing = client.query.mock.calls.find(([sql]) => String(sql).includes("event_type NOT IN"));
    expect(String(coalescing?.[0])).toContain("'discord:closed_no_action'");
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

  it("does not claim notifications for superseded reports", async () => {
    const query = vi.fn(async (_sql: string, _values?: unknown[]) => ({ rows: [], rowCount: 0 }));
    const database = new AccountBotDatabase({ query } as never);

    await database.claimNotification();

    expect(String(query.mock.calls[0]?.[0])).toContain("card_link.superseded_by_report_id IS NULL");
  });

  it("keeps per-report ordering by skipping a candidate while another event for the same report is in flight", async () => {
    const query = vi.fn(async (_sql: string, _values?: unknown[]) => ({ rows: [], rowCount: 0 }));
    const database = new AccountBotDatabase({ query } as never);

    await database.claimNotification();

    const sql = String(query.mock.calls[0]?.[0]);
    expect(sql).toContain("other.report_id = inbox.report_id");
    expect(sql).toContain("other.event_id <> inbox.event_id");
    expect(sql).toContain("other.state = 'sending'");
    expect(sql).toContain("other.locked_at > now() - interval '2 minutes'");
  });

  it("returns a failed notification claim to pending with bounded retry metadata", async () => {
    const query = vi.fn(async (_sql: string, _values?: unknown[]) => ({ rows: [], rowCount: 1 }));
    const database = new AccountBotDatabase({ query } as never);

    await database.retryNotification("event-1", "network", 3);
    await database.retryNotification("event-2", "x".repeat(400), 4);

    const [sql, values] = query.mock.calls[0]!;
    expect(sql).toContain("state = 'pending'");
    expect(sql).toContain("locked_at = NULL");
    expect(sql).toContain("last_error = $2");
    expect(sql).toContain("run_at = now() + interval '30 seconds'");
    expect(sql).toContain("state = 'sending' AND attempts = $3");
    expect(values).toEqual(["event-1", "network", 3]);
    expect(query.mock.calls[1]?.[1]).toEqual(["event-2", "x".repeat(300), 4]);
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
      reportId: "11111111-1111-4111-8111-111111111111", traceId: "33333333-3333-4333-8333-333333333333",
      type: "report_queued" as const, occurredAt: "2026-09-04T00:00:00.000Z", lifecycleAttempt: 1
    };
    const database = {
      connections: vi.fn(async () => [
        { discord_user_id: "sensitive-user-id", account_id: "sensitive-account-id", encrypted_api_key: "first-key", event_cursor: "0" },
        { discord_user_id: "other-user-id", account_id: "other-account-id", encrypted_api_key: "second-key", event_cursor: "0" }
      ]),
      pendingReportLinks: vi.fn(async () => []), cleanupExpiredForms: vi.fn(),
      existingEventIds: vi.fn(async () => new Set<string>()),
      ingestEvent: vi.fn().mockRejectedValue(new Error("database failed at postgres://bot:secret@db.example.test/nreport")),
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

    const failureLog = logger.mock.calls.find(([name]) => name === "account_reconciliation_event");
    expect(failureLog?.[1]).toMatchObject({
      reportId: event.reportId, traceId: event.traceId, eventType: event.type,
      stage: "event_ingestion", outcome: "failed", failureCategory: "unexpected",
      errorMessage: "database failed at [REDACTED_URL]"
    });
    expect(typeof failureLog?.[1]?.durationMs).toBe("number");
    expect(failureLog?.[2]).toBe("error");
    expect(database.advanceCursor).not.toHaveBeenCalled();
    expect(secondApi.events).toHaveBeenCalledOnce();
    expect(logger).not.toHaveBeenCalledWith("account_reconciliation_failed", expect.anything(), "error");
    expect(JSON.stringify(logger.mock.calls)).not.toMatch(/database URL|sensitive-account|sensitive-user/);
  });

  it("logs a safe failure and continues reconciling the next connection", async () => {
    const connections = [
      { discord_user_id: "secret-user-1", account_id: "secret-account-1", encrypted_api_key: "first-key", event_cursor: "0" },
      { discord_user_id: "secret-user-2", account_id: "secret-account-2", encrypted_api_key: "second-key", event_cursor: "0" }
    ];
    const database = {
      connections: vi.fn(async () => connections), pendingReportLinks: vi.fn(async () => []),
      cleanupExpiredForms: vi.fn(), existingEventIds: vi.fn(async () => new Set<string>()),
      ingestEvent: vi.fn(), advanceCursor: vi.fn()
    };
    const firstApi = { events: vi.fn().mockRejectedValue(Object.assign(new Error("network failure details"), { code: "ECONNRESET" })) };
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
        failureCategory: "network" }),
      "error"
    );
    expect(logger).toHaveBeenCalledWith(
      "account_reconciliation_completed",
      expect.objectContaining({ stage: "reconciliation", outcome: "completed" })
    );
    const serializedLogs = JSON.stringify(logger.mock.calls);
    expect(serializedLogs).not.toContain("secret-user");
    expect(serializedLogs).not.toContain("secret-account");
    expect(serializedLogs).not.toContain("first-key");
    expect(serializedLogs).not.toContain("secret.example.test");
    expect(serializedLogs).toContain("network failure details");
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
      claimDmCard: vi.fn(async () => null),
      existingEventIds: vi.fn(async () => new Set<string>()),
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

  it("reschedules an uncertain create quickly instead of waiting for event reconciliation", async () => {
    const database = {
      pendingReportLinks: vi.fn(async () => [{
        id: "link-1", idempotency_key: "create-key", encrypted_request: "request", recovery_attempts: 1
      }]),
      rescheduleReportLink: vi.fn(), abandonReportLink: vi.fn(), completeReportLink: vi.fn(),
      completeReplacementLink: vi.fn(), ingestEvent: vi.fn(), advanceCursor: vi.fn(), cleanupExpiredForms: vi.fn()
    };
    const api = {
      createReport: vi.fn(async () => { throw new DsaApiError(500, "internal_error", "Unavailable"); }),
      retryReport: vi.fn(), events: vi.fn(async () => ({ items: [], next: null }))
    };
    const worker = new AccountNotificationWorker(
      database as never, {} as never,
      { dataEncryptionKey: Buffer.alloc(32), apiBaseUrl: "https://api.example.test" } as never,
      () => api as never,
      <T>() => ({ flow: "message", useAi: true, target: { messageUrl: "https://discord.com/channels/@me/1/2" } }) as T
    );

    await worker.reconcileConnection({ discord_user_id: "discord-1", account_id: "account-1", encrypted_api_key: "key", event_cursor: "0" } as never);

    expect(database.rescheduleReportLink).toHaveBeenCalledWith("link-1", 5, "upstream");
    expect(database.abandonReportLink).not.toHaveBeenCalled();
  });

  it("keeps an HTTP timeout recovery link for the same idempotency replay", async () => {
    const database = {
      pendingReportLinks: vi.fn(async () => [{
        id: "link-timeout", idempotency_key: "create-key", encrypted_request: "request", recovery_attempts: 1
      }]),
      rescheduleReportLink: vi.fn(), abandonReportLink: vi.fn(), completeReportLink: vi.fn(),
      completeReplacementLink: vi.fn(), ingestEvent: vi.fn(), advanceCursor: vi.fn(), cleanupExpiredForms: vi.fn()
    };
    const api = {
      createReport: vi.fn(async () => { throw new DsaApiError(408, "request_timeout", "Timed out"); }),
      retryReport: vi.fn(), events: vi.fn(async () => ({ items: [], next: null }))
    };
    const worker = new AccountNotificationWorker(
      database as never, {} as never,
      { dataEncryptionKey: Buffer.alloc(32), apiBaseUrl: "https://api.example.test" } as never,
      () => api as never,
      <T>() => ({ flow: "message", useAi: true, target: { messageUrl: "https://discord.com/channels/@me/1/2" } }) as T
    );

    await worker.reconcileConnection({ discord_user_id: "discord-1", account_id: "account-1", encrypted_api_key: "key", event_cursor: "0" } as never);

    expect(database.abandonReportLink).not.toHaveBeenCalled();
    expect(database.rescheduleReportLink).toHaveBeenCalledWith("link-timeout", 5, "unexpected");
  });

  it("runs due creation recovery without polling the lifecycle event feed", async () => {
    const connection = { discord_user_id: "discord-1", account_id: "account-1", encrypted_api_key: "key", event_cursor: "0" };
    const database = {
      connections: vi.fn(async () => [connection]), cleanupExpiredForms: vi.fn(),
      pendingReportLinks: vi.fn(async () => []), dueCardRepairs: vi.fn(async () => [])
    };
    const worker = new AccountNotificationWorker(
      database as never, {} as never,
      { dataEncryptionKey: Buffer.alloc(32), apiBaseUrl: "https://api.example.test" } as never,
      () => ({ events: vi.fn() }) as never
    );

    await worker.recoverOnce();

    expect(database.pendingReportLinks).toHaveBeenCalledWith("discord-1");
  });

  it("correlates a recovery failure with its account and measured duration", async () => {
    const connection = { discord_user_id: "discord-1", account_id: "account-1", encrypted_api_key: "key", event_cursor: "0" };
    const database = {
      connections: vi.fn(async () => [connection]),
      cleanupExpiredForms: vi.fn(),
      pendingReportLinks: vi.fn(async () => { throw Object.assign(new Error("Invalid Form Body"), {
        code: 50035,
        status: 400,
        rawError: { message: "Invalid Form Body", errors: { nonce: { _errors: [{ code: "BASE_TYPE_MAX_LENGTH" }] } } }
      }); })
    };
    const logger = vi.fn<(event: string, fields?: Record<string, unknown>, level?: "info" | "warn" | "error") => void>();
    const worker = new AccountNotificationWorker(
      database as never, {} as never,
      { dataEncryptionKey: Buffer.alloc(32), apiBaseUrl: "https://api.example.test" } as never,
      undefined, undefined, logger
    );

    await worker.recoverOnce();

    expect(logger).toHaveBeenCalledWith("account_recovery_failed", expect.objectContaining({
      accountId: "account-1",
      errorName: "Error"
    }), "warn");
    const failureLog = logger.mock.calls.find(([event]) => event === "account_recovery_failed");
    expect(typeof failureLog?.[1]?.durationMs).toBe("number");
  });

  it("retains safe Discord error and payload metadata when retrying a card repair", async () => {
    const connection = { discord_user_id: "discord-1", account_id: "account-1", encrypted_api_key: "key", event_cursor: "0" };
    const repairedReport = {
      reportId: "11111111-1111-4111-8111-111111111111", traceId: "22222222-2222-4222-8222-222222222222", accountId: "account-1",
      flow: "message", useAi: true, status: "queued", creditState: "reserved", lifecycleAttempt: 1,
      country: "DE", category: null, description: null, discordReportId: null, discordStatus: null, reviewStatus: null,
      predecessorReportId: null, successorReportId: null, retryableModes: [], createdAt: "2026-09-09T00:00:00Z", updatedAt: "2026-09-09T00:00:00Z",
      target: { messageUrl: "https://discord.com/channels/@me/123456789012345678/123456789012345679" }, finalText: null,
      legalReference: null, researchSummary: null, sources: [], timeline: [], failure: null
    } as const;
    const database = {
      connections: vi.fn(async () => [connection]), cleanupExpiredForms: vi.fn(), pendingReportLinks: vi.fn(async () => []),
      dueCardRepairs: vi.fn(async () => [{ report_id: repairedReport.reportId, discord_user_id: "discord-1", encrypted_target_context: null, card_repair_attempts: 1, trace_id: repairedReport.traceId }]),
      claimDmCard: vi.fn(async () => cardIdentity(repairedReport.reportId)), releaseDmCard: vi.fn(), rescheduleCardRepair: vi.fn()
    };
    const deliveryError = Object.assign(new Error("Discord gateway unavailable"), { code: "ECONNRESET", status: 502 });
    const logger = vi.fn();
    const worker = new AccountNotificationWorker(
      database as never,
      { user: { id: "bot-user" }, users: { fetch: vi.fn(async () => ({
        createDM: vi.fn(async () => ({ messages: { fetch: vi.fn() }, send: vi.fn(async () => { throw deliveryError; }) }))
      })) } } as never,
      { dataEncryptionKey: Buffer.alloc(32), apiBaseUrl: "https://api.example.test" } as never,
      () => ({ report: vi.fn(async () => repairedReport) }) as never,
      undefined,
      logger
    );

    await worker.recoverOnce();

    expect(logger).toHaveBeenCalledWith("initial_card_retry", expect.objectContaining({
      reportId: repairedReport.reportId,
      errorCode: "ECONNRESET",
      httpStatus: 502,
      payload: expect.objectContaining({ flags: 32768, nonceLength: 21 }) as Record<string, unknown>
    }), "warn");
  });

  it("restores the predecessor DM mapping and logs correlation when a replacement response is reconciled", async () => {
    const database = {
      pendingReportLinks: vi.fn(async () => [{ id: "link-3", idempotency_key: "retry-key", encrypted_request: "retry-request" }]),
      abandonReportLink: vi.fn(), completeReportLink: vi.fn(), completeReplacementLink: vi.fn(),
      ingestEvent: vi.fn(), advanceCursor: vi.fn(), cleanupExpiredForms: vi.fn()
    };
    const api = {
      createReport: vi.fn(), retryReport: vi.fn(async () => ({ reportId: "11111111-1111-4111-8111-111111111111", traceId: "22222222-2222-4222-8222-222222222222" })),
      events: vi.fn(async () => ({ items: [], next: null }))
    };
    const logger = vi.fn();
    const worker = new AccountNotificationWorker(
      database as never, {} as never,
      { dataEncryptionKey: Buffer.alloc(32), apiBaseUrl: "https://api.example.test" } as never,
      () => api as never,
      <T>() => ({ reportId: "33333333-3333-4333-8333-333333333333", input: { mode: "rewrite_ai" } }) as T,
      logger
    );

    await worker.reconcileConnection({ discord_user_id: "discord-1", account_id: "account-1", encrypted_api_key: "key", event_cursor: "0" } as never);

    expect(database.completeReplacementLink).toHaveBeenCalledWith("link-3", "11111111-1111-4111-8111-111111111111", "33333333-3333-4333-8333-333333333333");
    expect(database.completeReportLink).not.toHaveBeenCalled();
    expect(logger).toHaveBeenCalledWith("report_retry_recovered", expect.objectContaining({
      reportId: "11111111-1111-4111-8111-111111111111", traceId: "22222222-2222-4222-8222-222222222222"
    }));
  });

  it("marks a permanent notification failure ignored without scheduling another run", async () => {
    const query = vi.fn(async (_sql: string, _values?: unknown[]) => ({ rows: [], rowCount: 1 }));
    const database = new AccountBotDatabase({ query } as never);

    await database.ignoreNotification("event-1", "discord_validation_50035", 2);

    const [sql, values] = query.mock.calls[0]!;
    expect(sql).toContain("state = 'ignored'");
    expect(sql).toContain("locked_at = NULL");
    expect(sql).not.toContain("run_at =");
    expect(sql).toContain("state = 'sending' AND attempts = $3");
    expect(values).toEqual(["event-1", "discord_validation_50035", 2]);
  });

  it("returns duplicate from a single lookup without opening a transaction for an already-known event", async () => {
    const poolQuery = vi.fn(async () => ({ rows: [{ event_id: "9" }], rowCount: 1 }));
    const connect = vi.fn();
    const database = new AccountBotDatabase({ query: poolQuery, connect } as never);

    const result = await database.ingestEvent({
      eventId: "9", accountId: "account-1", reportId: "report-1", traceId: "33333333-3333-4333-8333-333333333333",
      type: "report_writing", occurredAt: "2026-09-04T00:00:00.000Z", lifecycleAttempt: 1
    });

    expect(result).toBe("duplicate");
    expect(connect).not.toHaveBeenCalled();
    expect(poolQuery).toHaveBeenCalledWith(expect.stringContaining("SELECT 1 FROM lifecycle_inbox WHERE event_id"), ["9"]);
  });

  it("batches a single membership check per reconciliation page and skips ingesting known events", async () => {
    const events = [
      { eventId: "1", accountId: "account-1", reportId: "report-1", traceId: "33333333-3333-4333-8333-333333333333", type: "report_queued" as const, occurredAt: "2026-09-04T00:00:00.000Z", lifecycleAttempt: 1 },
      { eventId: "2", accountId: "account-1", reportId: "report-1", traceId: "33333333-3333-4333-8333-333333333333", type: "report_writing" as const, occurredAt: "2026-09-04T00:00:01.000Z", lifecycleAttempt: 1 },
      { eventId: "3", accountId: "account-1", reportId: "report-1", traceId: "33333333-3333-4333-8333-333333333333", type: "report_sent" as const, occurredAt: "2026-09-04T00:00:02.000Z", lifecycleAttempt: 1 }
    ];
    const database = {
      pendingReportLinks: vi.fn(async () => []), cleanupExpiredForms: vi.fn(),
      existingEventIds: vi.fn(async () => new Set(["1", "2"])),
      ingestEvent: vi.fn(async () => "accepted"),
      advanceCursor: vi.fn()
    };
    const api = { events: vi.fn(async () => ({ items: events, next: null })) };
    const worker = new AccountNotificationWorker(
      database as never, {} as never,
      { dataEncryptionKey: Buffer.alloc(32), apiBaseUrl: "https://api.example.test" } as never,
      () => api as never
    );

    await worker.reconcileConnection({ discord_user_id: "discord-1", account_id: "account-1", encrypted_api_key: "key", event_cursor: "0" } as never);

    expect(database.existingEventIds).toHaveBeenCalledOnce();
    expect(database.existingEventIds).toHaveBeenCalledWith(["1", "2", "3"]);
    expect(database.ingestEvent).toHaveBeenCalledOnce();
    expect(database.ingestEvent).toHaveBeenCalledWith(events[2]);
    expect(database.advanceCursor).toHaveBeenCalledOnce();
    expect(database.advanceCursor).toHaveBeenCalledWith("discord-1", "3");
  });

  it("advances the cursor once to the last contiguous processed event when a later one is not tracked yet", async () => {
    const events = [
      { eventId: "1", accountId: "account-1", reportId: "report-1", traceId: "33333333-3333-4333-8333-333333333333", type: "report_queued" as const, occurredAt: "2026-09-04T00:00:00.000Z", lifecycleAttempt: 1 },
      { eventId: "2", accountId: "account-1", reportId: "report-2", traceId: "33333333-3333-4333-8333-333333333333", type: "report_queued" as const, occurredAt: "2026-09-04T00:00:01.000Z", lifecycleAttempt: 1 }
    ];
    const database = {
      pendingReportLinks: vi.fn(async () => []), cleanupExpiredForms: vi.fn(),
      existingEventIds: vi.fn(async () => new Set<string>()),
      ingestEvent: vi.fn(async (event: { eventId: string }) => (event.eventId === "2" ? "not_tracked_yet" : "accepted")),
      advanceCursor: vi.fn()
    };
    const api = { events: vi.fn(async () => ({ items: events, next: "3" })) };
    const worker = new AccountNotificationWorker(
      database as never, {} as never,
      { dataEncryptionKey: Buffer.alloc(32), apiBaseUrl: "https://api.example.test" } as never,
      () => api as never
    );

    await worker.reconcileConnection({ discord_user_id: "discord-1", account_id: "account-1", encrypted_api_key: "key", event_cursor: "0" } as never);

    expect(database.advanceCursor).toHaveBeenCalledOnce();
    expect(database.advanceCursor).toHaveBeenCalledWith("discord-1", "1");
    expect(api.events).toHaveBeenCalledOnce();
  });
});

describe("notification delivery concurrency", () => {
  it("runs a small fixed number of notification loops and awaits every one on stop", async () => {
    const worker = new AccountNotificationWorker(
      {} as never, {} as never,
      { dataEncryptionKey: Buffer.alloc(32), apiBaseUrl: "https://api.example.test" } as never,
      () => ({}) as never,
      undefined,
      vi.fn()
    );
    const privateWorker = worker as unknown as {
      notifications: () => Promise<void>; reconcile: () => Promise<void>; recover: () => Promise<void>;
    };
    const resolveNotifications: (() => void)[] = [];
    const notifications = vi.spyOn(privateWorker, "notifications")
      .mockImplementation(async () => new Promise((resolve) => { resolveNotifications.push(resolve); }));
    vi.spyOn(privateWorker, "reconcile").mockImplementation(async () => undefined);
    vi.spyOn(privateWorker, "recover").mockImplementation(async () => undefined);

    worker.start();
    expect(notifications).toHaveBeenCalledTimes(NOTIFICATION_LOOP_COUNT);

    resolveNotifications.forEach((resolve) => resolve());
    await worker.stop();
  });
});
