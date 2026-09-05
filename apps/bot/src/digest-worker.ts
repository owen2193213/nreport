import { setTimeout as delay } from "node:timers/promises";

import { DsaApi } from "@discord-dsa/contracts";
import type { Client } from "discord.js";

import type { AccountBotDatabase, ApiConnection } from "./account-database.js";
import type { BotConfig } from "./config.js";
import { decryptJson } from "./crypto.js";

export class DigestWorker {
  private stopping = false;
  private running: Promise<void> | undefined;

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
      try {
        const activity = await api.digestActivity(startAt, endAt);
        if (!activity.eligible) {
          await this.database.completeDigest(connection.discord_user_id, period.kind, startAt, "skipped");
          continue;
        }
        const user = await this.client.users.fetch(connection.discord_user_id);
        await user.send(
          `${period.kind === "daily" ? "Daily" : "Weekly"} DSA activity: ${activity.newReports} new reports and ${activity.outcomeChanges.total} outcome changes.`
        );
        await this.database.completeDigest(connection.discord_user_id, period.kind, startAt, "sent");
      } catch {
        await this.database.completeDigest(connection.discord_user_id, period.kind, startAt, "failed");
      }
    }
  }

  private async loop(): Promise<void> {
    while (!this.stopping) {
      const connections = await this.database.connections().catch(() => []);
      for (const connection of connections) await this.processConnection(connection).catch(() => undefined);
      for (let second = 0; second < 3_600 && !this.stopping; second += 1) await delay(1_000);
    }
  }
}
