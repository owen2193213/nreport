import { setTimeout as delay } from "node:timers/promises";

import { DsaApi, DsaApiError, type CreateReportInput, type RetryReportInput } from "@nreport/contracts";
import type { Client, Message } from "discord.js";

import type { AccountBotDatabase, ApiConnection, ClaimedNotification } from "./account-database.js";
import type { BotConfig } from "./config.js";
import { decryptJson } from "./crypto.js";
import { classifyReportView, decisionMessageOptions, shouldSendDecisionDm, statusMessageOptions, targetContextFromReport, visibleStatusHash, type TargetDisplayContext } from "./report-ui.js";

type AccountApi = Pick<DsaApi, "createReport" | "retryReport" | "events" | "report">;

export class AccountNotificationWorker {
  private stopping = false;
  private notificationLoop: Promise<void> | undefined;
  private reconciliationLoop: Promise<void> | undefined;

  public constructor(
    private readonly database: AccountBotDatabase,
    private readonly client: Client,
    private readonly config: BotConfig,
    private readonly apiFactory?: (connection: Pick<ApiConnection, "encrypted_api_key"> | Pick<ClaimedNotification, "encrypted_api_key">) => AccountApi,
    private readonly decrypt: <T>(value: string, key: Buffer) => T = decryptJson
  ) {}

  public start(): void {
    if (this.notificationLoop !== undefined) return;
    this.stopping = false;
    this.notificationLoop = this.notifications();
    this.reconciliationLoop = this.reconcile();
  }

  public async stop(): Promise<void> {
    this.stopping = true;
    await Promise.all([this.notificationLoop, this.reconciliationLoop]);
    this.notificationLoop = undefined;
    this.reconciliationLoop = undefined;
  }

  public async processOne(): Promise<boolean> {
    const item = await this.database.claimNotification();
    if (item === null) return false;
    try {
      const preferences = await this.database.notificationPreferences(item.discord_user_id);
      const api = this.api(item);
      const report = await api.report(item.report_id);
      const context = item.encrypted_target_context === null
        ? targetContextFromReport(report)
        : this.decrypt<TargetDisplayContext>(item.encrypted_target_context, this.config.dataEncryptionKey);
      const options = statusMessageOptions(report, context);
      const visibleHash = visibleStatusHash(report, context);
      const user = await this.client.users.fetch(item.discord_user_id);
      const dm = await user.createDM();
      let message: Message | null = null;
      if (item.dm_message_id !== null) message = await dm.messages.fetch(item.dm_message_id).catch(() => null);
      if (message === null) {
        if (!(await this.database.claimDmCard(report.reportId))) {
          await this.database.retryNotification(item.event_id, "status_card_creation_in_progress");
          return true;
        }
        try {
          message = await dm.send(options);
          await this.database.setDmMapping(report.reportId, message.channelId, message.id);
          await this.database.completeCardUpdate(report.reportId, visibleHash);
        } catch (error) {
          await this.database.releaseDmCard(report.reportId);
          throw error;
        }
      } else if (item.visible_payload_hash !== visibleHash) {
        await message.edit(options);
        await this.database.completeCardUpdate(report.reportId, visibleHash);
      }
      const view = classifyReportView(report);
      if (shouldSendDecisionDm(item.event_type, view.key, preferences)) await message.reply(decisionMessageOptions(report, context));
      await this.database.completeNotification(item.event_id);
    } catch (error) {
      if (error instanceof DsaApiError && error.status === 401) {
        const user = await this.client.users.fetch(item.discord_user_id).catch(() => null);
        await user?.send("Your reporting API key was revoked or expired. Use `/access connect` to reconnect; detailed status refreshes are paused.").catch(() => undefined);
        await this.database.completeNotification(item.event_id);
      } else {
        await this.database.retryNotification(item.event_id, error instanceof Error ? error.name : "notification_failed");
      }
    }
    return true;
  }

  public async reconcileConnection(connection: ApiConnection): Promise<void> {
    const api = this.api(connection);
    await this.database.cleanupExpiredForms();
    const pendingLinks = await this.database.pendingReportLinks(connection.discord_user_id);
    for (const link of pendingLinks) {
      let pending: CreateReportInput | { reportId: string; input?: RetryReportInput; mode?: "reuse" | "regenerate" };
      try {
        pending = this.decrypt(link.encrypted_request, this.config.dataEncryptionKey);
      } catch {
        await this.database.abandonReportLink(link.id);
        continue;
      }
      try {
        if ("flow" in pending) {
          const report = await api.createReport(link.idempotency_key, pending);
          await this.database.completeReportLink(link.id, report.reportId);
        } else {
          const report = await api.retryReport(pending.reportId, link.idempotency_key, pending.input ?? { mode: pending.mode! });
          await this.database.completeReplacementLink(link.id, report.reportId, pending.reportId);
        }
      } catch (error) {
        if (error instanceof DsaApiError && error.status === 401) throw error;
        if (error instanceof DsaApiError && error.status < 500 && error.status !== 429) {
          await this.database.abandonReportLink(link.id);
        }
      }
    }
    let after = String(connection.event_cursor ?? "0");
    for (let pageCount = 0; pageCount < 20; pageCount += 1) {
      const page = await api.events({ after, limit: 100 });
      for (const event of page.items) {
        const result = await this.database.ingestEvent(event);
        if (result === "not_tracked_yet") return;
        await this.database.advanceCursor(connection.discord_user_id, event.eventId);
      }
      if (page.next === null) break;
      after = page.next;
    }
  }

  private api(connection: Pick<ApiConnection, "encrypted_api_key"> | Pick<ClaimedNotification, "encrypted_api_key">): AccountApi {
    return this.apiFactory?.(connection) ?? new DsaApi({
      baseUrl: this.config.apiBaseUrl,
      apiKey: this.decrypt<string>(connection.encrypted_api_key, this.config.dataEncryptionKey)
    });
  }

  private async notifications(): Promise<void> {
    while (!this.stopping) {
      try {
        if (!(await this.processOne())) await delay(1_000);
      } catch {
        await delay(2_000);
      }
    }
  }

  private async reconcile(): Promise<void> {
    while (!this.stopping) {
      const connections = await this.database.connections().catch(() => []);
      for (const connection of connections) {
        if (this.stopping) break;
        try {
          await this.reconcileConnection(connection);
        } catch (error) {
          if (error instanceof DsaApiError && error.status === 401) {
            const user = await this.client.users.fetch(connection.discord_user_id).catch(() => null);
            await user?.send("Your reporting API key was revoked or expired. Use `/access connect` to reconnect; background refreshes are paused.").catch(() => undefined);
            await this.database.disconnect(connection.discord_user_id).catch(() => undefined);
          }
        }
      }
      for (let second = 0; second < 15 * 60 && !this.stopping; second += 1) await delay(1_000);
    }
  }
}
