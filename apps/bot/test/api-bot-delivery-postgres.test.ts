import { randomUUID } from "node:crypto";
import type { Server } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Pool } from "pg";

import { DsaApi, type ApiAccountView } from "@nreport/contracts";
import type { AppConfig } from "../../api/src/config.js";
import { ACCOUNT_SCHEMA_SQL, AccountRepository, createApiKey, hashApiKey } from "../../api/src/accounts.js";
import { AccountEventDeliveryWorker } from "../../api/src/event-delivery-v2.js";
import { REPORT_SCHEMA_SQL, ReportRepository } from "../../api/src/report-repository.js";
import { buildV2Server } from "../../api/src/server-v2.js";
import { AccountBotDatabase } from "../src/account-database.js";
import { AccountNotificationWorker } from "../src/account-notifier.js";
import { HealthServer } from "../src/health.js";
import type { BotConfig } from "../src/config.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const suite = databaseUrl === undefined ? describe.skip : describe;
const apiSchema = `api_bot_delivery_${randomUUID().replaceAll("-", "")}`;
const botSchema = `bot_delivery_${randomUUID().replaceAll("-", "")}`;
const adminPool = databaseUrl === undefined ? undefined : new Pool({ connectionString: databaseUrl });
let apiPool: Pool | undefined;
let botPool: Pool | undefined;
let botDatabase: AccountBotDatabase | undefined;

async function healthServerPort(server: HealthServer): Promise<number> {
  await server.listen(0);
  const address = (server as unknown as { server: Server }).server.address();
  if (address === null || typeof address === "string") throw new Error("Bot test server did not bind a TCP port.");
  return address.port;
}

suite("API to bot lifecycle delivery PostgreSQL integration", () => {
  beforeAll(async () => {
    await adminPool!.query(`CREATE SCHEMA ${apiSchema}`);
    await adminPool!.query(`CREATE SCHEMA ${botSchema}`);
    apiPool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${apiSchema}` });
    botPool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${botSchema}` });
    await apiPool.query(ACCOUNT_SCHEMA_SQL);
    await apiPool.query(REPORT_SCHEMA_SQL);
    botDatabase = new AccountBotDatabase(botPool);
    await botDatabase.migrate();
  });

  afterAll(async () => {
    await botPool?.end();
    await apiPool?.end();
    if (adminPool !== undefined) {
      await adminPool.query(`DROP SCHEMA IF EXISTS ${botSchema} CASCADE`);
      await adminPool.query(`DROP SCHEMA IF EXISTS ${apiSchema} CASCADE`);
      await adminPool.end();
    }
  });

  it("delivers a durable API event through signed bot ingress into a private status card", async () => {
    const eventSecret = "e".repeat(32);
    const apiKeyPepper = "p".repeat(32);
    const userId = "123456789012345678";
    const accountId = randomUUID();
    const username = `delivery-${accountId.slice(0, 8)}`;
    const issuedKey = createApiKey();
    const apiKey = new AccountRepository(apiPool!, apiKeyPepper);
    const reports = new ReportRepository(apiPool!);
    const bot = botDatabase!;
    const botServer = new HealthServer(bot, () => true, eventSecret);
    let apiServer: Awaited<ReturnType<typeof buildV2Server>> | undefined;

    try {
      const botPort = await healthServerPort(botServer);
      const destinationId = randomUUID();
      await apiPool!.query(
        `INSERT INTO webhook_destinations (id, name, url, encrypted_signing_secret)
         VALUES ($1, $2, $3, 'fixture-encrypted-secret')`,
        [destinationId, `bot-test-${accountId.slice(0, 8)}`, `http://127.0.0.1:${botPort}/internal/report-events`]
      );
      await apiPool!.query(
        `INSERT INTO api_accounts (id, username, username_normalized, available_credits, webhook_destination_id)
         VALUES ($1, $2, $2, 1, $3)`,
        [accountId, username, destinationId]
      );
      await apiPool!.query(
        "INSERT INTO api_keys (id, account_id, prefix, key_hash) VALUES ($1, $2, $3, $4)",
        [issuedKey.keyId, accountId, issuedKey.prefix, hashApiKey(issuedKey.plaintext, apiKeyPepper)]
      );
      await bot.connectAccount(userId, {
        accountId, username, status: "active", availableCredits: 1, reservedCredits: 0,
        keyPrefix: issuedKey.prefix,
        usage: { aiRequests: 0, inputTokens: 0, outputTokens: 0, searchRequests: 0 }
      } satisfies ApiAccountView, "fixture-encrypted-api-key");

      const apiConfig = {
        adminApiKey: "a".repeat(32), apiKeyPepper, aiApiKey: "fixture-ai-key", aiModel: "fixture-model",
        braveSearchApiKey: "fixture-search-key", lifecycleConcurrency: 2, preparationConcurrency: 2,
        databaseUrl: "postgres://integration-test", emailDomain: "reports.example.test",
        environment: "test", port: 0, sessionEncryptionKey: Buffer.alloc(32),
        webhookSecret: "w".repeat(32), workerEnabled: false
      } satisfies AppConfig;
      apiServer = await buildV2Server(apiConfig, {
        healthcheck: () => Promise.resolve(),
        accounts: apiKey,
        reports
      });
      await apiServer.listen({ port: 0, host: "127.0.0.1" });
      const apiAddress = apiServer.server.address();
      if (apiAddress === null || typeof apiAddress === "string") throw new Error("API test server did not bind a TCP port.");
      const apiBaseUrl = `http://127.0.0.1:${apiAddress.port}`;

      const created = await reports.create(accountId, "integration-create-1", {
        flow: "message", useAi: true,
        target: { messageUrl: "https://discord.com/channels/@me/123456789012345678/123456789012345679" },
        description: "Controlled API-to-bot lifecycle fixture."
      });
      const eventDelivery = new AccountEventDeliveryWorker(reports, {
        decrypt: () => eventSecret,
        concurrency: 1
      });
      expect(await eventDelivery.processOne()).toBe(true);

      const inboxBeforeDelivery = await botPool!.query<{ event_id: string; state: string }>(
        "SELECT event_id, state FROM lifecycle_inbox WHERE report_id = $1",
        [created.report.id]
      );
      expect(inboxBeforeDelivery.rows).toHaveLength(1);
      expect(inboxBeforeDelivery.rows[0]?.state).toBe("pending");
      await botPool!.query("UPDATE lifecycle_inbox SET run_at = now() WHERE event_id = $1", [inboxBeforeDelivery.rows[0]!.event_id]);

      const cardMessage = {
        channelId: "fixture-dm-channel",
        id: "fixture-status-card",
        edit: vi.fn(() => Promise.resolve()),
        reply: vi.fn(() => Promise.resolve())
      };
      const sentCardPayloads: Array<Record<string, unknown>> = [];
      const dm = {
        messages: { fetch: vi.fn(() => Promise.resolve(cardMessage)) },
        send: vi.fn((payload: Record<string, unknown>) => {
          sentCardPayloads.push(payload);
          return Promise.resolve(cardMessage);
        })
      };
      const discord = {
        users: { fetch: vi.fn(() => Promise.resolve({ createDM: vi.fn(() => Promise.resolve(dm)) })) }
      };
      const botConfig = {
        apiBaseUrl, adminApiKey: "a".repeat(32), applicationId: userId,
        adminUserIds: new Set([userId]), databaseUrl: "postgres://integration-test",
        dataEncryptionKey: Buffer.alloc(32), environment: "test", port: 0, token: "fixture-token"
      } satisfies BotConfig;
      const notifier = new AccountNotificationWorker(
        bot, discord as never, botConfig,
        () => new DsaApi({ baseUrl: apiBaseUrl, apiKey: issuedKey.plaintext })
      );

      expect(await notifier.processOne()).toBe(true);
      expect(discord.users.fetch).toHaveBeenCalledWith(userId);
      expect(dm.send).toHaveBeenCalledOnce();
      expect(sentCardPayloads[0]?.nonce).toMatch(/^card-[a-f0-9]{16}$/u);
      expect(sentCardPayloads[0]?.enforceNonce).toBe(true);

      const finalState = await Promise.all([
        botPool!.query<{ state: string }>("SELECT state FROM lifecycle_inbox WHERE event_id = $1", [inboxBeforeDelivery.rows[0]!.event_id]),
        botPool!.query<{ dm_channel_id: string | null; dm_message_id: string | null; visible_payload_hash: string | null }>(
          "SELECT dm_channel_id, dm_message_id, visible_payload_hash FROM bot_report_links WHERE report_id = $1",
          [created.report.id]
        ),
        apiPool!.query<{ state: string }>("SELECT state FROM event_destination_deliveries WHERE event_id = $1", [inboxBeforeDelivery.rows[0]!.event_id])
      ]);
      expect(finalState[0].rows[0]).toMatchObject({ state: "sent" });
      expect(finalState[1].rows[0]).toMatchObject({
        dm_channel_id: "fixture-dm-channel", dm_message_id: "fixture-status-card"
      });
      expect(typeof finalState[1].rows[0]?.visible_payload_hash).toBe("string");
      expect(finalState[1].rows[0]?.visible_payload_hash?.length).toBeGreaterThan(0);
      expect(finalState[2].rows[0]).toMatchObject({ state: "sent" });
    } finally {
      await apiServer?.close();
      await botServer.close();
    }
  });
});
