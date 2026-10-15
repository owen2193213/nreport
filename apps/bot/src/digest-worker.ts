import { setTimeout as delay } from "node:timers/promises";

import { DsaApi, DsaApiError } from "@nreport/contracts";
import type { LifecycleFailureContext } from "@nreport/observability";
import type { Client } from "discord.js";

import type { AccountBotDatabase, ApiConnection } from "./account-database.js";
import type { BotConfig } from "./config.js";
import { decryptJson } from "./crypto.js";
import { botLog, captureLifecycleFailure, errorFields, safeErrorCategory } from "./observability.js";

type BotFailureContext = Omit<LifecycleFailureContext, "service">;

function captureWorthy(error: unknown): boolean {
  if (error instanceof DsaApiError && error.status !== 408 && error.status < 500) return false;
  const code = (error as { code?: unknown } | null)?.code;
  return code !== 50007 && code !== 10008;
}

export class DigestWorker {
  private stopping = false;
  private running: Promise<void> | undefined;
  private readonly reportedSentryFailures = new Set<string>();

  public constructor(
    private readonly database: AccountBotDatabase,
    private readonly client: Client,
    private readonly config: BotConfig
  ) {}

  public start(): void {
    if (this.running !== undefined) return;
    this.stopping = false;
    this.running = this.loop();
  }

  public async stop(): Promise<void> {
    this.stopping = true;
    await this.running;
    this.running = undefined;
  }

  public async processConnection(connection: ApiConnection, now = new Date()): Promise<void> {
    const preferences = await this.database.notificationPreferences(connection.discord_user_id);
    const periods: Array<{ kind: "daily" | "weekly"; start: Date; end: Date }> = [];
    const dayEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    if (preferences.dailyDigest) periods.push({ kind: "daily", start: new Date(dayEnd.getTime() - 86_400_000), end: dayEnd });
    if (preferences.weeklyDigest && now.getUTCDay() === 1) periods.push({ kind: "weekly", start: new Date(dayEnd.getTime() - 7 * 86_400_000), end: dayEnd });
    const api = new DsaApi({
      baseUrl: this.config.apiBaseUrl,
      apiKey: decryptJson<string>(connection.encrypted_api_key, this.config.dataEncryptionKey)
    });
    for (const period of periods) {
      const startAt = period.start.toISOString();
      const endAt = period.end.toISOString();
      if (!(await this.database.claimDigest(connection.discord_user_id, period.kind, startAt, endAt))) continue;
      const sentryFailureKey = `digest:${connection.account_id}:${period.kind}:${startAt}`;
      let stage = "fetch_activity";
      try {
        const activity = await api.digestActivity(startAt, endAt);
        if (!activity.eligible) {
          await this.database.completeDigest(connection.discord_user_id, period.kind, startAt, "skipped");
          this.reportedSentryFailures.delete(sentryFailureKey);
          continue;
        }
        stage = "fetch_user";
        const user = await this.client.users.fetch(connection.discord_user_id);
        stage = "send_dm";
        await user.send(
          `${period.kind === "daily" ? "Daily" : "Weekly"} DSA activity: ${activity.newReports} new reports and ${activity.outcomeChanges.total} outcome changes.`
        );
        stage = "record_delivery";
        await this.database.completeDigest(connection.discord_user_id, period.kind, startAt, "sent");
        this.reportedSentryFailures.delete(sentryFailureKey);
      } catch (error) {
        try {
          await this.database.completeDigest(connection.discord_user_id, period.kind, startAt, "failed");
        } catch (stateError) {
          this.recordFailure(`digest_state:${connection.account_id}:${period.kind}:${startAt}`, stateError, {
            operation: "activity_digest_delivery", stage: "record_failure", outcome: "failed",
            severity: "error"
          }, {
            accountId: connection.account_id, digestKind: period.kind, periodStart: startAt,
            stage: "record_failure", outcome: "failed"
          });
        }
        this.recordFailure(sentryFailureKey, error, {
          operation: "activity_digest_delivery", stage, outcome: "retrying", attempt: 1
        }, {
          accountId: connection.account_id, digestKind: period.kind, periodStart: startAt,
          stage, outcome: "failed"
        });
      }
    }
  }

  private async loop(): Promise<void> {
    while (!this.stopping) {
      let connections: ApiConnection[];
      try {
        connections = await this.database.connections();
        this.reportedSentryFailures.delete("digest:connections");
      } catch (error) {
        this.recordFailure("digest:connections", error, {
          operation: "activity_digest_worker", stage: "load_connections", outcome: "retrying", severity: "error"
        }, { stage: "load_connections", outcome: "failed" });
        connections = [];
      }
      for (const connection of connections) {
        try {
          await this.processConnection(connection);
          this.reportedSentryFailures.delete(`digest:connection:${connection.account_id}`);
        } catch (error) {
          this.recordFailure(`digest:connection:${connection.account_id}`, error, {
            operation: "activity_digest_worker", stage: "process_connection", outcome: "retrying"
          }, { accountId: connection.account_id, stage: "process_connection", outcome: "failed" });
        }
      }
      for (let second = 0; second < 3_600 && !this.stopping; second += 1) await delay(1_000);
    }
  }

  private recordFailure(key: string, error: unknown, context: BotFailureContext, fields: Record<string, unknown>): void {
    botLog("digest_delivery_failed", {
      ...fields, ...errorFields(error), failureCategory: safeErrorCategory(error)
    }, "warn");
    if (!captureWorthy(error) || this.reportedSentryFailures.has(key)) return;
    if (this.reportedSentryFailures.size >= 2_048) {
      const oldest = this.reportedSentryFailures.values().next().value;
      if (oldest !== undefined) this.reportedSentryFailures.delete(oldest);
    }
    this.reportedSentryFailures.add(key);
    captureLifecycleFailure(error, { service: "bot", ...context });
  }
}
