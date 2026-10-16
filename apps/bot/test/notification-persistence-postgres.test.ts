import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Pool } from "pg";

import { AccountBotDatabase, type ApiConnection } from "../src/account-database.js";
import { encryptJson } from "../src/crypto.js";
import { DigestWorker } from "../src/digest-worker.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const suite = databaseUrl === undefined ? describe.skip : describe;
const schema = `bot_notification_persistence_${randomUUID().replaceAll("-", "")}`;
const adminPool = databaseUrl === undefined ? undefined : new Pool({ connectionString: databaseUrl });
let pool: Pool | undefined;

function databaseWithLostAcknowledgement(sqlFragment: string, shouldLose: (values: unknown[] | undefined) => boolean): AccountBotDatabase {
  let loseAcknowledgement = true;
  const wrappedPool = {
    query: async (sql: string, values?: unknown[]) => {
      const result = await pool!.query(sql, values);
      if (loseAcknowledgement && sql.includes(sqlFragment) && shouldLose(values)) {
        loseAcknowledgement = false;
        throw new Error("Database committed the update but its acknowledgment was lost.");
      }
      return result;
    },
    connect: () => pool!.connect(),
    end: () => pool!.end()
  };
  return new AccountBotDatabase(wrappedPool as never);
}

async function connectAccount(database: AccountBotDatabase, discordUserId: string, accountId: string): Promise<void> {
  await database.connectAccount(discordUserId, {
    accountId,
    username: "notification-test",
    status: "active",
    availableCredits: 1,
    reservedCredits: 0,
    keyPrefix: "dsa_live_fixture",
    usage: { aiRequests: 0, inputTokens: 0, outputTokens: 0, searchRequests: 0 }
  }, "fixture-encrypted-api-key");
}

function lifecycleEvent(eventId: string, accountId: string, reportId: string) {
  return {
    eventId,
    accountId,
    reportId,
    traceId: randomUUID(),
    type: "report_failed" as const,
    occurredAt: new Date().toISOString(),
    lifecycleAttempt: 1
  };
}

afterEach(() => vi.unstubAllGlobals());

suite("bot notification persistence PostgreSQL recovery", () => {
  beforeAll(async () => {
    await adminPool!.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
    await new AccountBotDatabase(pool).migrate();
  });

  afterAll(async () => {
    await pool?.end();
    if (adminPool !== undefined) {
      await adminPool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await adminPool.end();
    }
  });

  it("does not downgrade a digest that PostgreSQL committed as sent", async () => {
    const database = databaseWithLostAcknowledgement(
      "UPDATE digest_deliveries SET state = $5",
      (values) => values?.[4] === "sent"
    );
    const encryptionKey = Buffer.alloc(32, 7);
    const userId = "123456789012345678";
    const startAt = "2026-10-13T00:00:00.000Z";
    const activity = {
      interval: {
        period: "custom", startAt, endAt: "2026-10-14T00:00:00.000Z",
        asOf: "2026-10-14T00:00:00.000Z", timezone: "UTC"
      },
      newReports: 1,
      outcomeChanges: { total: 0, actioned: 0, closedNoAction: 0, appealActioned: 0, appealDenied: 0 },
      eligible: true
    };
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response(JSON.stringify(activity), {
      status: 200,
      headers: { "content-type": "application/json" }
    }))));
    const sent = vi.fn(() => Promise.resolve({ id: "digest-message" }));
    const worker = new DigestWorker(
      database,
      { users: { fetch: vi.fn(() => Promise.resolve({ send: sent })) } } as never,
      { apiBaseUrl: "https://api.example.test", dataEncryptionKey: encryptionKey } as never
    );
    const connection = {
      discord_user_id: userId,
      account_id: randomUUID(),
      username: "digest-test",
      key_prefix: "dsa_live_fixture",
      encrypted_api_key: encryptJson("fixture-api-key", encryptionKey),
      event_cursor: "0",
      connected_at: new Date("2026-10-14T00:00:00.000Z")
    } satisfies ApiConnection;
    await database.updateNotificationPreferences(userId, { dailyDigest: true });

    await worker.processConnection(connection, new Date("2026-10-14T12:00:00.000Z"));

    const finalState = await pool!.query<{ state: string }>(
      "SELECT state FROM digest_deliveries WHERE discord_user_id = $1 AND kind = 'daily' AND period_start = $2",
      [userId, startAt]
    );
    expect(sent).toHaveBeenCalledOnce();
    expect(finalState.rows[0]?.state).toBe("sent");
  });

  it("does not let an expired digest claim overwrite a newer worker's claim", async () => {
    const database = new AccountBotDatabase(pool!);
    const discordUserId = "723456789012345678";
    const startAt = "2026-10-12T00:00:00.000Z";
    const endAt = "2026-10-13T00:00:00.000Z";

    const firstAttempt = await database.claimDigest(discordUserId, "daily", startAt, endAt);
    expect(firstAttempt).toBe(1);
    await pool!.query(
      `UPDATE digest_deliveries SET updated_at = now() - interval '2 hours'
       WHERE discord_user_id = $1 AND kind = 'daily' AND period_start = $2`,
      [discordUserId, startAt]
    );
    const replacementAttempt = await database.claimDigest(discordUserId, "daily", startAt, endAt);
    expect(replacementAttempt).toBe(2);

    await database.completeDigest(discordUserId, "daily", startAt, firstAttempt!, "failed");
    const afterStaleCompletion = await pool!.query<{ state: string; attempts: number }>(
      "SELECT state, attempts FROM digest_deliveries WHERE discord_user_id = $1 AND kind = 'daily' AND period_start = $2",
      [discordUserId, startAt]
    );

    expect(afterStaleCompletion.rows[0]).toMatchObject({ state: "sending", attempts: 2 });
    await database.completeDigest(discordUserId, "daily", startAt, replacementAttempt!, "sent");
    const afterReplacementCompletion = await pool!.query<{ state: string; attempts: number }>(
      "SELECT state, attempts FROM digest_deliveries WHERE discord_user_id = $1 AND kind = 'daily' AND period_start = $2",
      [discordUserId, startAt]
    );
    expect(afterReplacementCompletion.rows[0]).toMatchObject({ state: "sent", attempts: 2 });
  });

  it("does not requeue an inbox event whose sent state committed before its acknowledgment was lost", async () => {
    const database = databaseWithLostAcknowledgement(
      "UPDATE lifecycle_inbox SET state = 'sent'",
      () => true
    );
    const discordUserId = "223456789012345678";
    const accountId = randomUUID();
    const reportId = randomUUID();
    const eventId = "92001";
    await connectAccount(database, discordUserId, accountId);
    const linkId = await database.beginReportLink(discordUserId, accountId, "fixture-create-key", "fixture-request");
    await database.completeReportLink(linkId, reportId);
    await database.ingestEvent(lifecycleEvent(eventId, accountId, reportId));
    const claim = await database.claimNotification();
    expect(claim?.event_id).toBe(eventId);
    expect(claim?.attempts).toBe(1);
    if (claim === null) throw new Error("Expected the pending lifecycle notification to be claimed.");

    await expect(database.completeNotification(eventId, claim.attempts)).rejects.toThrow("acknowledgment was lost");
    await database.retryNotification(eventId, "completion acknowledgment was lost", claim.attempts);

    const finalState = await pool!.query<{ state: string }>(
      "SELECT state FROM lifecycle_inbox WHERE event_id = $1",
      [eventId]
    );
    expect(finalState.rows[0]?.state).toBe("sent");
  });

  it("fences completion, retry, and ignore writes from a superseded notification claim", async () => {
    const database = new AccountBotDatabase(pool!);
    const discordUserId = "323456789012345678";
    const accountId = randomUUID();
    const reportId = randomUUID();
    const eventId = "92002";
    await connectAccount(database, discordUserId, accountId);
    const linkId = await database.beginReportLink(discordUserId, accountId, "stale-claim-key", "fixture-request");
    await database.completeReportLink(linkId, reportId);
    await database.ingestEvent(lifecycleEvent(eventId, accountId, reportId));

    const expiredClaim = await database.claimNotification();
    expect(expiredClaim?.attempts).toBe(1);
    if (expiredClaim === null) throw new Error("Expected the pending lifecycle notification to be claimed.");
    await database.retryNotification(eventId, "first attempt failed", expiredClaim.attempts);
    await pool!.query("UPDATE lifecycle_inbox SET run_at = now() WHERE event_id = $1", [eventId]);

    const replacementClaim = await database.claimNotification();
    expect(replacementClaim?.attempts).toBe(2);
    if (replacementClaim === null) throw new Error("Expected the retried lifecycle notification to be claimed.");
    await database.completeNotification(eventId, expiredClaim.attempts);
    await database.retryNotification(eventId, "stale worker retry", expiredClaim.attempts);
    await database.ignoreNotification(eventId, "stale worker validation failure", expiredClaim.attempts);

    const currentState = await pool!.query<{ state: string; attempts: number; locked_at: Date | null }>(
      "SELECT state, attempts, locked_at FROM lifecycle_inbox WHERE event_id = $1",
      [eventId]
    );
    expect(currentState.rows[0]).toMatchObject({ state: "sending", attempts: 2 });
    expect(currentState.rows[0]?.locked_at).toBeInstanceOf(Date);
  });

  it("reclaims a DM-card claim after its worker lease expires", async () => {
    const database = new AccountBotDatabase(pool!);
    const discordUserId = "523456789012345678";
    const accountId = randomUUID();
    const reportId = randomUUID();
    await connectAccount(database, discordUserId, accountId);
    const linkId = await database.beginReportLink(discordUserId, accountId, "expired-card-claim-key", "fixture-request");
    await database.completeReportLink(linkId, reportId);

    await expect(database.claimDmCard(reportId)).resolves.toBe(true);
    await expect(database.claimDmCard(reportId)).resolves.toBe(false);
    await pool!.query(
      "UPDATE bot_report_links SET dm_claimed_at = now() - interval '3 minutes' WHERE report_id = $1",
      [reportId]
    );

    await expect(database.claimDmCard(reportId)).resolves.toBe(true);
  });

  it("transfers a predecessor card to its retry and prevents its pending events from being claimed", async () => {
    const database = new AccountBotDatabase(pool!);
    const discordUserId = "623456789012345678";
    const accountId = randomUUID();
    const predecessorReportId = randomUUID();
    const successorReportId = randomUUID();
    const eventId = "92005";
    await connectAccount(database, discordUserId, accountId);

    const predecessorLinkId = await database.beginReportLink(discordUserId, accountId, "predecessor-card-key", "fixture-request");
    await database.completeReportLink(predecessorLinkId, predecessorReportId);
    await database.setDmMapping(predecessorReportId, "discord-dm-channel", "predecessor-card-message");
    await database.completeCardUpdate(predecessorReportId, "payload-hash");
    await database.ingestEvent(lifecycleEvent(eventId, accountId, predecessorReportId));
    const successorLinkId = await database.beginReportLink(discordUserId, accountId, "successor-card-key", "fixture-retry-request");

    await database.completeReplacementLink(successorLinkId, successorReportId, predecessorReportId);

    const links = await pool!.query<{
      report_id: string; dm_channel_id: string | null; dm_message_id: string | null;
      visible_payload_hash: string | null; superseded_by_report_id: string | null;
    }>(
      `SELECT report_id, dm_channel_id, dm_message_id, visible_payload_hash, superseded_by_report_id
       FROM bot_report_links WHERE report_id = ANY($1::uuid[]) ORDER BY report_id`,
      [[predecessorReportId, successorReportId]]
    );
    const predecessor = links.rows.find((link) => link.report_id === predecessorReportId);
    const successor = links.rows.find((link) => link.report_id === successorReportId);
    expect(predecessor).toMatchObject({
      dm_channel_id: null,
      dm_message_id: null,
      superseded_by_report_id: successorReportId
    });
    expect(successor).toMatchObject({
      dm_channel_id: "discord-dm-channel",
      dm_message_id: "predecessor-card-message",
      visible_payload_hash: "payload-hash",
      superseded_by_report_id: null
    });
    await expect(database.claimDmCard(predecessorReportId)).resolves.toBe(false);
    await expect(database.claimNotification()).resolves.toBeNull();
  });

  it("does not restore a superseded predecessor mapping when its stale card send finishes", async () => {
    const database = new AccountBotDatabase(pool!);
    const discordUserId = "823456789012345678";
    const accountId = randomUUID();
    const predecessorReportId = randomUUID();
    const successorReportId = randomUUID();
    await connectAccount(database, discordUserId, accountId);

    const predecessorLinkId = await database.beginReportLink(discordUserId, accountId, "inflight-predecessor-key", "fixture-request");
    await database.completeReportLink(predecessorLinkId, predecessorReportId);
    await expect(database.claimDmCard(predecessorReportId)).resolves.toBe(true);
    const successorLinkId = await database.beginReportLink(discordUserId, accountId, "inflight-successor-key", "fixture-retry-request");
    await database.completeReplacementLink(successorLinkId, successorReportId, predecessorReportId);

    // Simulate an in-flight Discord send whose worker resumes after the replacement transaction.
    await database.setDmMapping(predecessorReportId, "discord-dm-channel", "late-predecessor-card");

    const predecessor = await pool!.query<{ dm_channel_id: string | null; dm_message_id: string | null; superseded_by_report_id: string | null }>(
      "SELECT dm_channel_id, dm_message_id, superseded_by_report_id FROM bot_report_links WHERE report_id = $1",
      [predecessorReportId]
    );
    expect(predecessor.rows[0]).toMatchObject({
      dm_channel_id: null,
      dm_message_id: null,
      superseded_by_report_id: successorReportId
    });
  });

  it("holds notifications while disconnected and resumes the account feed after reconnect", async () => {
    const database = new AccountBotDatabase(pool!);
    const discordUserId = "423456789012345678";
    const accountId = randomUUID();
    const existingReportId = randomUUID();
    const eventDuringDisconnect = lifecycleEvent("92004", accountId, randomUUID());
    await connectAccount(database, discordUserId, accountId);
    const linkId = await database.beginReportLink(discordUserId, accountId, "reconnect-create-key", "fixture-request");
    await database.completeReportLink(linkId, existingReportId);
    await database.ingestEvent(lifecycleEvent("92003", accountId, existingReportId));

    await database.disconnect(discordUserId);
    await expect(database.claimNotification()).resolves.toBeNull();
    await expect(database.ingestEvent(eventDuringDisconnect)).resolves.toBe("disconnected");

    await connectAccount(database, discordUserId, accountId);
    const existingClaim = await database.claimNotification();
    expect(existingClaim?.event_id).toBe("92003");
    if (existingClaim === null) throw new Error("Expected the existing event to resume after reconnect.");
    await database.completeNotification(existingClaim.event_id, existingClaim.attempts);
    await expect(database.ingestEvent(eventDuringDisconnect)).resolves.toBe("accepted");

    const replayedClaim = await database.claimNotification();
    expect(replayedClaim?.event_id).toBe(eventDuringDisconnect.eventId);
  });
});
