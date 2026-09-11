import { setTimeout as delay } from "node:timers/promises";
import { createHash } from "node:crypto";

import { DsaApi, DsaApiError, type CreateReportInput, type RetryReportInput } from "@nreport/contracts";
import type { Client, Message } from "discord.js";

import type { AccountBotDatabase, ApiConnection, ClaimedNotification } from "./account-database.js";
import type { BotConfig } from "./config.js";
import { decryptJson } from "./crypto.js";
import { botLog, safeErrorCategory } from "./observability.js";
import { classifyReportView, decisionMessageOptions, shouldSendDecisionDm, statusMessageOptions, targetContextFromReport, visibleStatusHash, type TargetDisplayContext } from "./report-ui.js";
import type { ReportDetail } from "@nreport/contracts";

type AccountApi = Pick<DsaApi, "createReport" | "retryReport" | "events" | "report">;
type AccountNotifierLog = (event: string, fields?: Record<string, unknown>, level?: "info" | "warn" | "error") => void;

class ReconciliationEventIngestError extends Error {}

const RECOVERY_DELAYS_SECONDS = [5, 15, 30, 60, 120, 300] as const;

export function reportRecoveryDelaySeconds(attempt: number, rateLimited: boolean): number {
  if (rateLimited) return 120;
  return RECOVERY_DELAYS_SECONDS[Math.min(Math.max(attempt, 1), RECOVERY_DELAYS_SECONDS.length) - 1]!;
}

function notificationNonce(eventId: string): string {
  return `nreport-${createHash("sha256").update(eventId).digest("hex").slice(0, 16)}`;
}

export class AccountNotificationWorker {
  private stopping = false;
  private notificationLoop: Promise<void> | undefined;
  private reconciliationLoop: Promise<void> | undefined;
  private recoveryLoop: Promise<void> | undefined;

  public constructor(
    private readonly database: AccountBotDatabase,
    private readonly client: Client,
    private readonly config: BotConfig,
    private readonly apiFactory?: (connection: Pick<ApiConnection, "encrypted_api_key"> | Pick<ClaimedNotification, "encrypted_api_key">) => AccountApi,
    private readonly decrypt: <T>(value: string, key: Buffer) => T = decryptJson,
    private readonly log: AccountNotifierLog = botLog
  ) {}

  public start(): void {
    if (this.notificationLoop !== undefined) return;
    this.stopping = false;
    this.notificationLoop = this.notifications();
    this.reconciliationLoop = this.reconcile();
    this.recoveryLoop = this.recover();
  }

  public async stop(): Promise<void> {
    this.stopping = true;
    await Promise.all([this.notificationLoop, this.reconciliationLoop, this.recoveryLoop]);
    this.notificationLoop = undefined;
    this.reconciliationLoop = undefined;
    this.recoveryLoop = undefined;
  }

  public async processOne(): Promise<boolean> {
    const item = await this.database.claimNotification();
    if (item === null) return false;
    const startedAt = Date.now();
    const attempts = item.attempts;
    const traceFields = item.trace_id === null ? {} : { traceId: item.trace_id };
    this.safeLog("account_notification_claimed", {
      ...traceFields, eventType: item.event_type, attempts,
      stage: "notification", outcome: "claimed", durationMs: 0
    });
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
          this.safeLog("account_notification_retry", {
            ...traceFields, eventType: item.event_type, attempts, durationMs: Date.now() - startedAt,
            failureCategory: "card_claim_busy", stage: "notification", outcome: "retry"
          }, "warn");
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
      if (shouldSendDecisionDm(item.event_type, view.key, preferences)) {
        await message.reply({
          ...decisionMessageOptions(report, context),
          nonce: notificationNonce(item.event_id),
          enforceNonce: true
        });
      }
      await this.database.completeNotification(item.event_id);
      this.safeLog("account_notification_completed", {
        ...traceFields, eventType: item.event_type, attempts, durationMs: Date.now() - startedAt,
        stage: "notification", outcome: "completed"
      });
    } catch (error) {
      if (error instanceof DsaApiError && error.status === 401) {
        const user = await this.client.users.fetch(item.discord_user_id).catch(() => null);
        await user?.send("Your reporting API key was revoked or expired. Use `/access connect` to reconnect; detailed status refreshes are paused.").catch(() => undefined);
        await this.database.completeNotification(item.event_id);
        this.safeLog("account_notification_completed", {
          ...traceFields, eventType: item.event_type, attempts, durationMs: Date.now() - startedAt,
          stage: "notification", outcome: "completed"
        });
      } else {
        const failureCategory = safeErrorCategory(error);
        await this.database.retryNotification(item.event_id, failureCategory);
        this.safeLog("account_notification_retry", {
          ...traceFields, eventType: item.event_type, attempts, durationMs: Date.now() - startedAt,
          failureCategory, stage: "notification", outcome: "retry"
        }, "warn");
      }
    }
    return true;
  }

  public async reconcileConnection(connection: ApiConnection): Promise<void> {
    const api = this.api(connection);
    await this.recoverConnection(connection, api);
    let after = String(connection.event_cursor ?? "0");
    for (let pageCount = 0; pageCount < 20; pageCount += 1) {
      const page = await api.events({ after, limit: 100 });
      for (const event of page.items) {
        const startedAt = Date.now();
        let result: Awaited<ReturnType<AccountBotDatabase["ingestEvent"]>>;
        try {
          result = await this.database.ingestEvent(event);
        } catch (error) {
          this.safeLog("account_reconciliation_event", {
            traceId: event.traceId,
            eventType: event.type,
            stage: "event_ingestion",
            outcome: "failed",
            durationMs: Date.now() - startedAt,
            failureCategory: safeErrorCategory(error)
          }, "error");
          throw new ReconciliationEventIngestError();
        }
        this.safeLog("account_reconciliation_event", {
          traceId: event.traceId,
          eventType: event.type,
          stage: "event_ingestion",
          outcome: result,
          durationMs: Date.now() - startedAt
        });
        if (result === "not_tracked_yet") return;
        await this.database.advanceCursor(connection.discord_user_id, event.eventId);
      }
      if (page.next === null) break;
      after = page.next;
    }
  }

  public async recoverOnce(): Promise<void> {
    const connections = await this.database.connections();
    for (const connection of connections) {
      if (this.stopping) break;
      await this.recoverConnection(connection, this.api(connection));
    }
  }

  private async recoverConnection(connection: ApiConnection, api: AccountApi): Promise<void> {
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
        const startedAt = Date.now();
        this.safeLog("report_create_recovery_started", {
          stage: "creation_recovery", outcome: "started", durationMs: 0
        });
        if ("flow" in pending) {
          const report = await api.createReport(link.idempotency_key, pending);
          await this.database.completeReportLink(link.id, report.reportId);
          const context = link.encrypted_target_context === null
            ? targetContextFromReport(report)
            : this.decrypt<TargetDisplayContext>(link.encrypted_target_context, this.config.dataEncryptionKey);
          await this.ensureInitialCard(report, connection.discord_user_id, context);
          this.safeLog("report_create_recovered", {
            stage: "creation_recovery", outcome: "completed", durationMs: Date.now() - startedAt
          });
        } else {
          const report = await api.retryReport(pending.reportId, link.idempotency_key, pending.input ?? { mode: pending.mode! });
          await this.database.completeReplacementLink(link.id, report.reportId, pending.reportId);
        }
      } catch (error) {
        if (error instanceof DsaApiError && error.status === 401) throw error;
        if (error instanceof DsaApiError && error.status < 500 && error.status !== 429) {
          await this.database.abandonReportLink(link.id);
        } else {
          const rateLimited = error instanceof DsaApiError && error.status === 429;
          await this.database.rescheduleReportLink(
            link.id,
            reportRecoveryDelaySeconds(link.recovery_attempts, rateLimited),
            safeErrorCategory(error)
          );
        }
      }
    }
    const cardRepairs = await this.database.dueCardRepairs?.(connection.discord_user_id) ?? [];
    for (const repair of cardRepairs) {
      try {
        const report = await api.report(repair.report_id);
        const context = repair.encrypted_target_context === null
          ? targetContextFromReport(report)
          : this.decrypt<TargetDisplayContext>(repair.encrypted_target_context, this.config.dataEncryptionKey);
        const result = await this.ensureInitialCard(report, repair.discord_user_id, context);
        if (result === "failed") {
          await this.database.rescheduleCardRepair(
            repair.report_id,
            reportRecoveryDelaySeconds(repair.card_repair_attempts, false)
          );
        }
      } catch (error) {
        await this.database.rescheduleCardRepair(
          repair.report_id,
          reportRecoveryDelaySeconds(repair.card_repair_attempts, false)
        );
        this.safeLog("initial_card_retry", {
          stage: "initial_card", outcome: "retry", durationMs: 0, failureCategory: safeErrorCategory(error)
        }, "warn");
      }
    }
  }

  private async ensureInitialCard(
    report: ReportDetail,
    discordUserId: string,
    context = targetContextFromReport(report)
  ): Promise<"created" | "busy" | "failed"> {
    const startedAt = Date.now();
    try {
      if (!(await this.database.claimDmCard(report.reportId))) return "busy";
      const user = await this.client.users.fetch(discordUserId);
      const message = await user.send(statusMessageOptions(report, context));
      await this.database.setDmMapping(report.reportId, message.channelId, message.id);
      await this.database.completeCardUpdate(report.reportId, visibleStatusHash(report, context));
      this.safeLog("initial_card_created", {
        stage: "initial_card", outcome: "completed", durationMs: Date.now() - startedAt
      });
      return "created";
    } catch (error) {
      try {
        await this.database.releaseDmCard(report.reportId);
      } catch {
        // A card-delivery cleanup failure must not cause the already-created report to be recovered again.
      }
      this.safeLog("initial_card_failed", {
        stage: "initial_card", outcome: "retry", durationMs: Date.now() - startedAt,
        failureCategory: safeErrorCategory(error)
      }, "warn");
      return "failed";
    }
  }

  public async reconcileOnce(): Promise<void> {
    const batchStartedAt = Date.now();
    let connections: ApiConnection[];
    try {
      connections = await this.database.connections();
    } catch (error) {
      this.safeLog("account_reconciliation_failed", {
        durationMs: Date.now() - batchStartedAt,
        failureCategory: safeErrorCategory(error),
        stage: "reconciliation",
        outcome: "failed"
      }, "error");
      return;
    }
    for (const connection of connections) {
      if (this.stopping) break;
      const startedAt = Date.now();
      try {
        await this.reconcileConnection(connection);
        this.safeLog("account_reconciliation_completed", {
          durationMs: Date.now() - startedAt, stage: "reconciliation", outcome: "completed"
        });
      } catch (error) {
        if (!(error instanceof ReconciliationEventIngestError)) {
          this.safeLog("account_reconciliation_failed", {
            durationMs: Date.now() - startedAt,
            failureCategory: safeErrorCategory(error),
            stage: "reconciliation",
            outcome: "failed"
          }, "error");
        }
        if (error instanceof DsaApiError && error.status === 401) {
          const user = await this.client.users.fetch(connection.discord_user_id).catch(() => null);
          await user?.send("Your reporting API key was revoked or expired. Use `/access connect` to reconnect; background refreshes are paused.").catch(() => undefined);
          await this.database.disconnect(connection.discord_user_id).catch(() => undefined);
        }
      }
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
      } catch (error) {
        this.safeLog("account_notification_retry", {
          eventType: "unknown", attempts: 0, durationMs: 0, failureCategory: safeErrorCategory(error),
          stage: "notification", outcome: "retry"
        }, "error");
        await delay(2_000);
      }
    }
  }

  private async reconcile(): Promise<void> {
    while (!this.stopping) {
      await this.reconcileOnce();
      for (let second = 0; second < 15 * 60 && !this.stopping; second += 1) await delay(1_000);
    }
  }

  private async recover(): Promise<void> {
    while (!this.stopping) {
      try {
        await this.recoverOnce();
      } catch (error) {
        this.safeLog("report_create_recovery_failed", {
          stage: "creation_recovery", outcome: "retry", durationMs: 0,
          failureCategory: safeErrorCategory(error)
        }, "warn");
      }
      await delay(5_000);
    }
  }

  private safeLog(event: string, fields?: Record<string, unknown>, level?: "info" | "warn" | "error"): void {
    try {
      if (level === undefined) this.log(event, fields);
      else this.log(event, fields, level);
    } catch {
      // Logging failures must not interrupt notification or reconciliation work.
    }
  }
}
