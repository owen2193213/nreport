import type { DsaApi } from "@discord-dsa/contracts";
import { DiscordAPIError, type Client } from "discord.js";

import type { BotDatabase, DigestJob } from "./database.js";
import { closedDigestPeriod } from "./digest-periods.js";
import { digestMessage } from "./digest-ui.js";
import { botLog, errorFields } from "./observability.js";

function permanentDmFailure(error: unknown): boolean {
  return error instanceof DiscordAPIError && (error.code === 50_007 || error.code === 10_013);
}

function safeDigestError(error: unknown): string {
  if (permanentDmFailure(error)) return "Discord user cannot receive this digest.";
  return "Digest delivery failed temporarily.";
}

export class DigestWorker {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  public constructor(
    private readonly database: BotDatabase,
    private readonly api: DsaApi,
    private readonly client: Client
  ) {}

  public start(): void {
    if (this.timer !== null) return;
    void this.runOnce();
    this.timer = setInterval(() => void this.runOnce(), 5 * 60_000);
    this.timer.unref();
  }

  public stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  public async runOnce(now = new Date()): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (const user of await this.database.listDigestUsers()) {
        await this.database.ensureDigestJob(
          user.discordUserId,
          user.frequency,
          closedDigestPeriod(user.frequency, now)
        );
      }
      for (const job of await this.database.claimDigestJobs()) await this.deliver(job);
    } catch (error) {
      botLog("digest_worker_run_failed", errorFields(error), "error");
    } finally {
      this.running = false;
    }
  }

  private async deliver(job: DigestJob): Promise<void> {
    try {
      const preferences = await this.database.getNotificationPreferences(job.discordUserId);
      if (preferences.digestFrequency !== job.frequency) {
        await this.database.completeDigestJob(job.id, "skipped");
        return;
      }
      const startAt = job.periodStart.toISOString();
      const endAt = job.periodEnd.toISOString();
      const activity = await this.api.digestActivity(job.discordUserId, startAt, endAt);
      if (!activity.eligible) {
        await this.database.completeDigestJob(job.id, "skipped");
        botLog("digest_delivery_skipped", { digestJobId: job.id, reason: "below_threshold" });
        return;
      }
      const [personal, community] = await Promise.all([
        this.api.analyticsForRange(job.discordUserId, startAt, endAt),
        this.api.communityAnalyticsForRange(startAt, endAt)
      ]);
      const payload = await digestMessage({ frequency: job.frequency, activity, personal, community });
      const user = await this.client.users.fetch(job.discordUserId);
      const message = await user.send(payload);
      await this.database.completeDigestJob(job.id, "sent", message.id);
      botLog("digest_delivery_completed", { digestJobId: job.id, frequency: job.frequency });
    } catch (error) {
      const permanent = permanentDmFailure(error);
      await this.database.failDigestJob(job, safeDigestError(error), permanent);
      botLog(
        "digest_delivery_failed",
        { digestJobId: job.id, frequency: job.frequency, permanent, ...errorFields(error) },
        permanent ? "warn" : "error"
      );
    }
  }
}
