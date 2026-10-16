import { setTimeout as delay } from "node:timers/promises";
import { createHash } from "node:crypto";

import { DsaApi, DsaApiError, type CreateReportInput, type RetryReportInput } from "@nreport/contracts";
import type { LifecycleFailureContext } from "@nreport/observability";
import type { Client, DMChannel, Message } from "discord.js";

import { type AccountBotDatabase, type ApiConnection, type ClaimedNotification, type DmCardIdentity } from "./account-database.js";
import type { ReportCardState } from "./account-database.js";
import type { BotConfig } from "./config.js";
import { cardPayloadDiagnostics } from "./card-diagnostics.js";
import { decryptJson } from "./crypto.js";
import { shouldAbandonReportLink } from "./report-link-recovery.js";
import { botLog, captureLifecycleFailure, errorFields, isDiscordValidationFailure, safeErrorCategory } from "./observability.js";
import { classifyReportView, decisionMessageOptions, shouldSendDecisionDm, statusMessageOptions, targetContextFromReport, visibleStatusHash, type TargetDisplayContext } from "./report-ui.js";
import type { ReportDetail } from "@nreport/contracts";

type AccountApi = Pick<DsaApi, "createReport" | "retryReport" | "events" | "report">;
type AccountNotifierLog = (event: string, fields?: Record<string, unknown>, level?: "info" | "warn" | "error") => void;
type NotificationDeliveryStage =
  | "load_preferences" | "fetch_report" | "adopt_automatic_retry" | "reload_card_state" | "resolve_context" | "render_card"
  | "fetch_user" | "open_dm" | "fetch_card" | "claim_card" | "reconcile_card_history" | "send_card"
  | "save_card_mapping" | "save_card_hash" | "edit_card" | "reply" | "complete_notification";
type CardCreationResult =
  | { outcome: "created" | "busy" | "terminal" | "uncertain"; reason?: string }
  | { outcome: "failed"; diagnostics: Record<string, unknown> };

class ReconciliationEventIngestError extends Error {}

export class UncertainCardDeliveryError extends Error {
  public constructor(public readonly reason: "history_fetch_failed" | "history_incomplete" | "bot_identity_unavailable") {
    super(`Could not establish whether the original status card exists: ${reason}`);
    this.name = "UncertainCardDeliveryError";
  }
}

const RECOVERY_DELAYS_SECONDS = [5, 15, 30, 60, 120, 300] as const;
const DM_HISTORY_PAGE_SIZE = 100;
const DM_HISTORY_MAX_PAGES = 3;
const CARD_HISTORY_RECONCILE_AFTER_MS = 5_000;

/** Number of concurrent notification-delivery loops; per-report ordering is enforced in claimNotification. */
export const NOTIFICATION_LOOP_COUNT = 3;
const NOTIFICATION_HEALTH_SAMPLE_SECONDS = 60;
const NOTIFICATION_HEALTH_THRESHOLD_MS = 5 * 60_000;
const NOTIFICATION_HEALTH_BAD_SAMPLES = 2;
const NOTIFICATION_HEALTH_RECOVERY_SAMPLES = 2;

type NotificationHealthSignalKey = "notification_backlog" | "stuck_card_updates";
interface NotificationHealthSignalState {
  unhealthySamples: number;
  healthySamples: number;
  reported: boolean;
}

type BotFailureContext = Omit<LifecycleFailureContext, "service">;

function isActionableFailure(error: unknown): boolean {
  if (error instanceof DsaApiError && error.status !== 408 && error.status < 500) return false;
  const code = (error as { code?: unknown } | null)?.code;
  return code !== 50007 && code !== 10008;
}

function failureContext(error: unknown): Pick<LifecycleFailureContext, "statusCode" | "requestId" | "discordErrorCode" | "discordHttpStatus"> {
  if (error instanceof DsaApiError) {
    return { statusCode: error.status, ...(error.requestId === undefined ? {} : { requestId: error.requestId }) };
  }
  const candidate = error as { code?: unknown; status?: unknown } | null;
  const discordError = error instanceof Error && error.name === "DiscordAPIError";
  const discordCode = typeof candidate?.code === "number" ||
    (typeof candidate?.code === "string" && /^\d{4,6}$/u.test(candidate.code));
  return {
    ...(discordError && discordCode ? { discordErrorCode: candidate.code as string | number } : {}),
    ...(discordError && typeof candidate?.status === "number" ? { discordHttpStatus: candidate.status } : {})
  };
}

export function reportRecoveryDelaySeconds(attempt: number, rateLimited: boolean): number {
  if (rateLimited) return 120;
  return RECOVERY_DELAYS_SECONDS[Math.min(Math.max(attempt, 1), RECOVERY_DELAYS_SECONDS.length) - 1]!;
}

function notificationNonce(eventId: string): string {
  return `nreport-${createHash("sha256").update(eventId).digest("hex").slice(0, 16)}`;
}

export { cardNonce } from "./account-database.js";

export function isDiscordUnknownMessage(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error &&
    (error as { code?: unknown }).code === 10008;
}

function messageContainsReportId(message: Message, reportIds: ReadonlySet<string>): boolean {
  const markers = new Set([...reportIds].map((reportId) => `Report ID: \`${reportId}\``));
  const isReportFooterLine = (value: unknown): boolean => typeof value === "string" &&
    markers.has(value.split(/\r?\n/u, 1)[0] ?? "");
  const containsComponentFooter = (value: unknown, depth = 0): boolean => {
    if (depth >= 8 || typeof value !== "object" || value === null) return false;
    if (Array.isArray(value)) return value.some((item) => containsComponentFooter(item, depth + 1));
    const component = value as { content?: unknown; components?: unknown };
    return isReportFooterLine(component.content) || containsComponentFooter(component.components, depth + 1);
  };
  // The card's Components V2 text display begins with its report-ID line; older cards used an
  // embed footer. Do not search excerpts or arbitrary component text, which may quote another ID.
  return isReportFooterLine(message.content) || containsComponentFooter(message.components) ||
    (message.embeds ?? []).some((embed) => isReportFooterLine(embed.footer?.text));
}

/** Searches a bounded DM history before retrying a card send whose acceptance is uncertain. */
export async function reconcileUncertainCardMessage(
  dm: Pick<DMChannel, "messages">,
  botUserId: string | null,
  reportId: string,
  identity: DmCardIdentity
): Promise<Message | null> {
  const ageMs = Date.now() - identity.originClaimedAt.getTime();
  if (identity.originReportId === reportId && ageMs < CARD_HISTORY_RECONCILE_AFTER_MS) return null;
  if (botUserId === null) throw new UncertainCardDeliveryError("bot_identity_unavailable");

  let before: string | undefined;
  let historyCoversClaim = false;
  for (let pageNumber = 0; pageNumber < DM_HISTORY_MAX_PAGES; pageNumber += 1) {
    let page;
    try {
      page = await dm.messages.fetch({
        limit: DM_HISTORY_PAGE_SIZE,
        ...(before === undefined ? {} : { before })
      });
    } catch {
      throw new UncertainCardDeliveryError("history_fetch_failed");
    }
    const messages = Array.from(page.values());
    if (messages.length === 0) {
      historyCoversClaim = true;
      break;
    }
    const match = messages.find((message) =>
      message.author.id === botUserId &&
      (String(message.nonce ?? "") === identity.nonce ||
        messageContainsReportId(message, new Set([
          reportId, identity.originReportId, ...identity.relatedReportIds
        ])))
    );
    if (match !== undefined) return match;

    const oldest = messages.reduce((current, message) =>
      message.createdTimestamp < current.createdTimestamp ? message : current
    );
    if (oldest.createdTimestamp <= identity.originClaimedAt.getTime() ||
      messages.length < DM_HISTORY_PAGE_SIZE) {
      historyCoversClaim = true;
      break;
    }
    before = oldest.id;
  }

  if (!historyCoversClaim || !identity.relatedReportIdsComplete) {
    throw new UncertainCardDeliveryError("history_incomplete");
  }
  return null;
}

export class AccountNotificationWorker {
  private stopping = false;
  private readonly reportedSentryFailures = new Set<string>();
  private notificationLoops: Promise<void>[] = [];
  private reconciliationLoop: Promise<void> | undefined;
  private recoveryLoop: Promise<void> | undefined;
  private healthLoop: Promise<void> | undefined;
  private readonly notificationHealthSignals = new Map<NotificationHealthSignalKey, NotificationHealthSignalState>();

  public constructor(
    private readonly database: AccountBotDatabase,
    private readonly client: Client,
    private readonly config: BotConfig,
    private readonly apiFactory?: (connection: Pick<ApiConnection, "encrypted_api_key"> | Pick<ClaimedNotification, "encrypted_api_key">) => AccountApi,
    private readonly decrypt: <T>(value: string, key: Buffer) => T = decryptJson,
    private readonly log: AccountNotifierLog = botLog
  ) {}

  public start(): void {
    if (this.notificationLoops.length > 0) return;
    this.stopping = false;
    this.notificationLoops = Array.from({ length: NOTIFICATION_LOOP_COUNT }, () => this.notifications());
    this.reconciliationLoop = this.reconcile();
    this.recoveryLoop = this.recover();
    this.healthLoop = this.monitorNotificationHealth();
  }

  public async stop(): Promise<void> {
    this.stopping = true;
    await Promise.all([...this.notificationLoops, this.reconciliationLoop, this.recoveryLoop, this.healthLoop]);
    this.notificationLoops = [];
    this.reconciliationLoop = undefined;
    this.recoveryLoop = undefined;
    this.healthLoop = undefined;
  }

  public async processOne(): Promise<boolean> {
    const item = await this.database.claimNotification();
    if (item === null) return false;
    const startedAt = Date.now();
    const attempts = item.attempts;
    let deliveryStage: NotificationDeliveryStage = "load_preferences";
    let payload: Record<string, unknown> | undefined;
    let attemptedCardSend = false;
    let activeCardReportId = item.report_id;
    const traceFields = {
      reportId: item.report_id,
      ...(item.trace_id === null ? {} : { traceId: item.trace_id })
    };
    const sentryFailureKey = `notification:${item.event_id}`;
    this.safeLog("account_notification_claimed", {
      ...traceFields, eventType: item.event_type, attempts,
      stage: "notification", outcome: "claimed", durationMs: 0
    });
    try {
      const preferences = await this.database.notificationPreferences(item.discord_user_id);
      const api = this.api(item);
      deliveryStage = "fetch_report";
      const sourceReport = await api.report(item.report_id);
      if (sourceReport.accountId !== item.account_id) {
        await this.database.ignoreNotification(item.event_id, "report_account_mismatch", attempts);
        this.safeLog("account_notification_ignored", {
          ...traceFields, eventType: item.event_type, attempts, durationMs: Date.now() - startedAt,
          stage: "fetch_report", outcome: "ignored", failureCategory: "report_account_mismatch"
        }, "warn");
        return true;
      }
      let report = sourceReport;
      activeCardReportId = report.reportId;
      let cardItem = item;
      deliveryStage = "adopt_automatic_retry";
      const adoption = await this.adoptLifecycleNetworkRetry(sourceReport, item.account_id, api);
      if (adoption.outcome === "busy") {
        await this.database.retryNotification(item.event_id, "automatic_retry_card_claim_in_progress", attempts);
        this.safeLog("account_notification_retry", {
          ...traceFields, eventType: item.event_type, attempts, durationMs: Date.now() - startedAt,
          failureCategory: "automatic_retry_card_claim_busy", stage: "notification", outcome: "retry"
        }, "warn");
        return true;
      }
      if (adoption.outcome === "conflict") {
        await this.database.completeNotification(item.event_id, attempts);
        this.safeLog("account_notification_completed", {
          ...traceFields, eventType: item.event_type, attempts, durationMs: Date.now() - startedAt,
          stage: "notification", outcome: "stale_automatic_retry"
        });
        this.clearCapturedFailure(sentryFailureKey);
        return true;
      }
      if (adoption.outcome === "adopted") {
        report = adoption.report;
        activeCardReportId = report.reportId;
        deliveryStage = "reload_card_state";
        const cardState = adoption.cardState ?? await this.database.reportCardState(item.account_id, report.reportId);
        if (cardState === null || cardState.superseded_by_report_id !== null) {
          await this.database.completeNotification(item.event_id, attempts);
          this.safeLog("account_notification_completed", {
            ...traceFields, eventType: item.event_type, attempts, durationMs: Date.now() - startedAt,
            stage: "notification", outcome: "stale_automatic_retry"
          });
          this.clearCapturedFailure(sentryFailureKey);
          return true;
        }
        cardItem = {
          ...item,
          report_id: report.reportId,
          dm_channel_id: cardState.dm_channel_id,
          dm_message_id: cardState.dm_message_id,
          encrypted_target_context: cardState.encrypted_target_context,
          visible_payload_hash: cardState.visible_payload_hash
        };
      }
      deliveryStage = "resolve_context";
      const context = cardItem.encrypted_target_context === null
        ? targetContextFromReport(report)
        : this.decrypt<TargetDisplayContext>(cardItem.encrypted_target_context, this.config.dataEncryptionKey);
      deliveryStage = "render_card";
      const options = statusMessageOptions(report, context);
      const visibleHash = visibleStatusHash(report, context);
      deliveryStage = "fetch_user";
      const user = await this.client.users.fetch(item.discord_user_id);
      deliveryStage = "open_dm";
      const dm = await user.createDM();
      let message: Message | null = null;
      if (cardItem.dm_message_id !== null) {
        deliveryStage = "fetch_card";
        try {
          message = await dm.messages.fetch(cardItem.dm_message_id);
        } catch (error) {
          if (!isDiscordUnknownMessage(error)) throw error;
          await this.database.clearStaleDmMapping(report.reportId, cardItem.dm_message_id);
        }
      }
      if (message === null) {
        deliveryStage = "claim_card";
        const identity = await this.database.claimDmCard(report.reportId);
        if (identity === null) {
          await this.database.retryNotification(item.event_id, "status_card_creation_in_progress", attempts);
          this.safeLog("account_notification_retry", {
            ...traceFields, eventType: item.event_type, attempts, durationMs: Date.now() - startedAt,
            failureCategory: "card_claim_busy", stage: "notification", outcome: "retry"
          }, "warn");
          return true;
        }
        try {
          deliveryStage = "reconcile_card_history";
          message = await reconcileUncertainCardMessage(dm, this.client.user?.id ?? null, report.reportId, identity);
          if (message !== null) {
            deliveryStage = "save_card_mapping";
            await this.database.setDmMapping(report.reportId, message.channelId, message.id);
            deliveryStage = "edit_card";
            await message.edit({ ...options, content: null, embeds: [] });
          } else {
            deliveryStage = "send_card";
            payload = cardPayloadDiagnostics(options, identity.nonce);
            attemptedCardSend = true;
            message = await dm.send({ ...options, nonce: identity.nonce, enforceNonce: true });
            deliveryStage = "save_card_mapping";
            await this.database.setDmMapping(report.reportId, message.channelId, message.id);
          }
          deliveryStage = "save_card_hash";
          await this.database.completeCardUpdate(report.reportId, visibleHash);
        } catch (error) {
          if (!attemptedCardSend || isDiscordValidationFailure(error)) {
            await this.database.releaseDmCard(report.reportId);
          }
          throw error;
        }
      } else if (cardItem.visible_payload_hash !== visibleHash) {
        deliveryStage = "edit_card";
        await message.edit({ ...options, content: null, embeds: [] });
        deliveryStage = "save_card_hash";
        await this.database.completeCardUpdate(report.reportId, visibleHash);
      }
      const view = classifyReportView(report);
      const predecessorFailureRedirectedToChild = report.reportId !== sourceReport.reportId &&
        item.event_type === "report_failed";
      if (!predecessorFailureRedirectedToChild && shouldSendDecisionDm(item.event_type, view.key, preferences)) {
        deliveryStage = "reply";
        await message.reply({
          ...decisionMessageOptions(report, context),
          nonce: notificationNonce(item.event_id),
          enforceNonce: true
        });
      }
      deliveryStage = "complete_notification";
      await this.database.completeNotification(item.event_id, attempts);
      this.safeLog("account_notification_completed", {
        ...traceFields, eventType: item.event_type, attempts, durationMs: Date.now() - startedAt,
        stage: "notification", outcome: "completed"
      });
      this.clearCapturedFailure(sentryFailureKey);
    } catch (error) {
      if (error instanceof UncertainCardDeliveryError) {
        await this.database.releaseDmCard(activeCardReportId);
        await this.database.retryNotification(item.event_id, `uncertain_card_delivery_${error.reason}`, attempts);
        this.safeLog("account_card_delivery_uncertain", {
          ...traceFields, eventType: item.event_type, attempts, durationMs: Date.now() - startedAt,
          stage: deliveryStage, outcome: "rescheduled", failureCategory: error.reason
        }, "warn");
      } else if (error instanceof DsaApiError && error.status === 401) {
        const user = await this.client.users.fetch(item.discord_user_id).catch(() => null);
        await user?.send("Your reporting API key was revoked or expired. Use `/access connect` to reconnect; detailed status refreshes are paused.").catch(() => undefined);
        await this.database.completeNotification(item.event_id, attempts);
        this.safeLog("account_notification_completed", {
          ...traceFields, eventType: item.event_type, attempts, durationMs: Date.now() - startedAt,
          stage: "notification", outcome: "completed"
        });
        this.clearCapturedFailure(sentryFailureKey);
      } else {
        const failureCategory = safeErrorCategory(error);
        const validationFailure = isDiscordValidationFailure(error);
        const errorCode = validationFailure ? "discord_validation_50035" : failureCategory;
        if (validationFailure) {
          await this.database.ignoreNotification(item.event_id, errorCode, attempts);
          if (attemptedCardSend) await this.database.terminalCardRepair(item.report_id, errorCode);
        } else {
          await this.database.retryNotification(item.event_id, errorCode, attempts);
        }
        this.safeLog(validationFailure ? "account_notification_ignored" : "account_notification_retry", {
          ...traceFields, eventType: item.event_type, attempts, durationMs: Date.now() - startedAt,
          deliveryStage, ...errorFields(error), ...(payload === undefined ? {} : { payload }), failureCategory,
          stage: "notification", outcome: validationFailure ? "ignored" : "retry"
        }, "warn");
        this.captureFailureOnce(sentryFailureKey, error, {
          operation: "lifecycle_notification_delivery",
          reportId: item.report_id,
          ...(item.trace_id === null ? {} : { traceId: item.trace_id }),
          eventType: item.event_type,
          lifecycleAttempt: item.lifecycle_attempt,
          deliveryStage,
          outcome: validationFailure ? "ignored" : "retrying",
          attempt: attempts
        });
      }
    }
    return true;
  }

  private async adoptLifecycleNetworkRetry(
    report: ReportDetail,
    accountId: string,
    api: AccountApi
  ): Promise<
    | { outcome: "none" }
    | { outcome: "adopted"; report: ReportDetail; cardState: ReportCardState | null }
    | { outcome: "busy" | "conflict" }
  > {
    let child: ReportDetail;
    let predecessorReportId: string;
    if (report.automaticNetworkRetry === true) {
      child = report;
      predecessorReportId = report.predecessorReportId ?? "";
    } else if (report.connectionRecovery?.state === "restarting" &&
      report.connectionRecovery.successorReportId !== null) {
      child = await api.report(report.connectionRecovery.successorReportId);
      predecessorReportId = report.reportId;
    } else {
      return { outcome: "none" };
    }

    if (child.accountId !== accountId) return { outcome: "conflict" };
    if (child.automaticNetworkRetry !== true) {
      // A progress event is safe to render, but it cannot authorize adopting an unrelated report.
      return report.automaticNetworkRetry === true ? { outcome: "conflict" } : { outcome: "none" };
    }
    if (predecessorReportId === "" || child.predecessorReportId !== predecessorReportId ||
      child.reportId === predecessorReportId || child.successorReportId !== null) {
      // An API-side successor can be a manual replacement whose bot event has not arrived yet.
      // Never adopt it or walk onward to it from this delayed automatic-retry event.
      return { outcome: "conflict" };
    }
    const outcome = await this.database.adoptAutomaticNetworkRetry(
      accountId, predecessorReportId, child.reportId
    );
    if (outcome === "busy" || outcome === "conflict") return { outcome };
    if (outcome === "unavailable") return { outcome: "none" };
    return {
      outcome: "adopted",
      report: child,
      cardState: await this.database.reportCardState(accountId, child.reportId)
    };
  }

  public async reconcileConnection(connection: ApiConnection): Promise<void> {
    const api = this.api(connection);
    await this.recoverConnection(connection, api);
    let after = String(connection.event_cursor ?? "0");
    for (let pageCount = 0; pageCount < 20; pageCount += 1) {
      const page = await api.events({ after, limit: 100 });
      if (page.items.length > 0) {
        // One query per page identifies already-known events so a 15-minute reconcile (or restart)
        // does not re-run the full ingestEvent BEGIN/lock path for hundreds of duplicates.
        const known = await this.database.existingEventIds(page.items.map((event) => event.eventId));
        let lastProcessedEventId: string | undefined;
        let stopped = false;
        for (const event of page.items) {
          const startedAt = Date.now();
          let result: Awaited<ReturnType<AccountBotDatabase["ingestEvent"]>>;
          if (known.has(event.eventId)) {
            this.clearCapturedFailure(`event_ingestion:${event.eventId}`);
            lastProcessedEventId = event.eventId;
            continue;
          } else {
            try {
              result = await this.database.ingestEvent(event);
            } catch (error) {
              this.safeLog("account_reconciliation_event", {
                reportId: event.reportId, traceId: event.traceId,
                eventType: event.type,
                stage: "event_ingestion",
                outcome: "failed",
                durationMs: Date.now() - startedAt,
                ...errorFields(error),
                failureCategory: safeErrorCategory(error)
              }, "error");
              this.captureFailureOnce(`event_ingestion:${event.eventId}`, error, {
                operation: "lifecycle_event_ingestion", reportId: event.reportId, traceId: event.traceId,
                eventType: event.type, lifecycleAttempt: event.lifecycleAttempt,
                stage: "event_ingestion", outcome: "retrying", attempt: 1, severity: "error"
              });
              throw new ReconciliationEventIngestError();
            }
          }
          this.clearCapturedFailure(`event_ingestion:${event.eventId}`);
          this.safeLog("account_reconciliation_event", {
            reportId: event.reportId, traceId: event.traceId,
            eventType: event.type,
            stage: "event_ingestion",
            outcome: result,
            durationMs: Date.now() - startedAt
          });
          if (result === "not_tracked_yet") { stopped = true; break; }
          lastProcessedEventId = event.eventId;
        }
        // Advance the cursor once per page, past the last contiguous processed event only. Webhook
        // ingestion never advances the cursor, since webhooks can arrive out of order.
        if (lastProcessedEventId !== undefined) {
          await this.database.advanceCursor(connection.discord_user_id, lastProcessedEventId);
        }
        if (stopped) return;
      }
      if (page.next === null) break;
      after = page.next;
    }
  }

  public async recoverOnce(): Promise<void> {
    try {
      await this.database.cleanupExpiredForms();
      this.clearCapturedFailure("report_recovery:expired_forms");
    } catch (error) {
      this.safeLog("expired_report_forms_cleanup_failed", {
        stage: "form_cleanup", outcome: "retrying", ...errorFields(error), failureCategory: safeErrorCategory(error)
      }, "warn");
      this.captureFailureOnce("report_recovery:expired_forms", error, {
        operation: "report_form_cleanup", stage: "form_cleanup", outcome: "retrying", severity: "warning"
      });
    }
    const connections = await this.database.connections();
    for (const connection of connections) {
      if (this.stopping) break;
      const startedAt = Date.now();
      try {
        await this.recoverConnection(connection, this.api(connection));
        this.clearCapturedFailure(`account_recovery:${connection.account_id}`);
      } catch (error) {
        this.safeLog("account_recovery_failed", {
          accountId: connection.account_id, stage: "creation_recovery", outcome: "failed", durationMs: Date.now() - startedAt,
          ...errorFields(error), failureCategory: safeErrorCategory(error)
        }, "warn");
        this.captureFailureOnce(`account_recovery:${connection.account_id}`, error, {
          operation: "report_recovery", stage: "creation_recovery", outcome: "retrying", attempt: 1
        });
      }
    }
  }

  private async recoverConnection(connection: ApiConnection, api: AccountApi): Promise<void> {
    const pendingLinks = await this.database.pendingReportLinks(connection.discord_user_id);
    for (const link of pendingLinks) {
      let pending: CreateReportInput | { reportId: string; input?: RetryReportInput; mode?: "reuse" | "regenerate" };
      try {
        pending = this.decrypt(link.encrypted_request, this.config.dataEncryptionKey);
      } catch (error) {
        await this.database.abandonReportLink(link.id);
        this.safeLog("report_recovery_request_invalid", {
          accountId: connection.account_id, stage: "request_decryption", outcome: "abandoned",
          ...errorFields(error), failureCategory: safeErrorCategory(error)
        }, "error");
        this.captureFailureOnce(`report_recovery_link:${link.id}`, error, {
          operation: "report_recovery", stage: "request_decryption", outcome: "abandoned",
          attempt: link.recovery_attempts, severity: "error"
        });
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
          await this.ensureInitialCard(report, connection.discord_user_id, context, connection.account_id, api);
          this.safeLog("report_create_recovered", {
            reportId: report.reportId, traceId: report.traceId,
            stage: "creation_recovery", outcome: "completed", durationMs: Date.now() - startedAt
          });
        } else {
          const report = await api.retryReport(pending.reportId, link.idempotency_key, pending.input ?? { mode: pending.mode! });
          await this.database.completeReplacementLink(link.id, report.reportId, pending.reportId);
          this.safeLog("report_retry_recovered", {
            reportId: report.reportId, traceId: report.traceId,
            stage: "creation_recovery", outcome: "completed", durationMs: Date.now() - startedAt
          });
        }
        this.clearCapturedFailure(`report_recovery_link:${link.id}`);
      } catch (error) {
        if (error instanceof DsaApiError && error.status === 401) throw error;
        const abandoned = shouldAbandonReportLink(error);
        if (abandoned) {
          await this.database.abandonReportLink(link.id);
        } else {
          const rateLimited = error instanceof DsaApiError && error.status === 429;
          await this.database.rescheduleReportLink(
            link.id,
            reportRecoveryDelaySeconds(link.recovery_attempts, rateLimited),
            safeErrorCategory(error)
          );
        }
        const retryReportId = "reportId" in pending ? pending.reportId : undefined;
        const operation = "flow" in pending ? "report_create_recovery" : "report_retry_recovery";
        this.safeLog("report_mutation_recovery_failed", {
          accountId: connection.account_id,
          ...(retryReportId === undefined ? {} : { reportId: retryReportId }),
          operation, recoveryAttempt: link.recovery_attempts,
          stage: "api_replay", outcome: abandoned ? "abandoned" : "retrying",
          ...errorFields(error), failureCategory: safeErrorCategory(error)
        }, abandoned ? "info" : "warn");
        this.captureFailureOnce(`report_recovery_link:${link.id}`, error, {
          operation,
          ...(retryReportId === undefined ? {} : { reportId: retryReportId }),
          stage: "api_replay", outcome: abandoned ? "abandoned" : "retrying",
          attempt: link.recovery_attempts
        });
      }
    }
    const cardRepairs = await this.database.dueCardRepairs?.(connection.discord_user_id) ?? [];
    for (const repair of cardRepairs) {
      try {
        const report = await api.report(repair.report_id);
        const context = repair.encrypted_target_context === null
          ? targetContextFromReport(report)
          : this.decrypt<TargetDisplayContext>(repair.encrypted_target_context, this.config.dataEncryptionKey);
        const result = await this.ensureInitialCard(
          report, repair.discord_user_id, context, connection.account_id, api
        );
        if (result.outcome === "uncertain") {
          await this.database.rescheduleCardRepair(
            repair.report_id, 300, `uncertain_card_delivery_${result.reason ?? "unknown"}`
          );
          this.safeLog("account_card_delivery_uncertain", {
            reportId: report.reportId, traceId: report.traceId,
            stage: "initial_card", outcome: "rescheduled",
            failureCategory: result.reason ?? "unknown"
          }, "warn");
        } else if (result.outcome === "failed") {
          await this.database.rescheduleCardRepair(
            repair.report_id,
            reportRecoveryDelaySeconds(repair.card_repair_attempts, false)
          );
          this.safeLog("initial_card_retry", {
            reportId: report.reportId, traceId: report.traceId,
            stage: "initial_card", outcome: "retry", durationMs: 0, ...result.diagnostics
          }, "warn");
        } else if (result.outcome === "busy") {
          await this.database.rescheduleCardRepair(repair.report_id, 5);
        } else if (result.outcome === "terminal") {
          await this.database.terminalCardRepair(repair.report_id, "automatic_retry_superseded");
        }
      } catch (error) {
        await this.database.rescheduleCardRepair(
          repair.report_id,
          reportRecoveryDelaySeconds(repair.card_repair_attempts, false)
        );
        this.safeLog("initial_card_retry", {
          reportId: repair.report_id,
          ...(repair.trace_id === null ? {} : { traceId: repair.trace_id }),
          stage: "initial_card", outcome: "retry", durationMs: 0,
          ...errorFields(error), failureCategory: safeErrorCategory(error)
        }, "warn");
        this.captureFailureOnce(`card_repair:${repair.report_id}`, error, {
          operation: "status_card_delivery", reportId: repair.report_id,
          ...(repair.trace_id === null ? {} : { traceId: repair.trace_id }),
          stage: "initial_card", outcome: "retrying", attempt: repair.card_repair_attempts
        });
      }
    }
  }

  private async ensureInitialCard(
    report: ReportDetail,
    discordUserId: string,
    context = targetContextFromReport(report),
    accountId = report.accountId,
    api?: AccountApi
  ): Promise<CardCreationResult> {
    const startedAt = Date.now();
    let payload: Record<string, unknown> | undefined;
    let attemptedCardSend = false;
    let activeReport = report;
    try {
      let activeContext = context;
      if (report.automaticNetworkRetry === true || report.connectionRecovery?.state === "restarting") {
        if (api === undefined || report.accountId !== accountId) return { outcome: "terminal" };
        const adoption = await this.adoptLifecycleNetworkRetry(report, accountId, api);
        if (adoption.outcome === "busy") return { outcome: "busy" };
        if (adoption.outcome === "conflict") return { outcome: "terminal" };
        if (adoption.outcome === "adopted") {
          activeReport = adoption.report;
          const cardState = adoption.cardState ?? await this.database.reportCardState(accountId, activeReport.reportId);
          if (cardState === null || cardState.superseded_by_report_id !== null) return { outcome: "terminal" };
          if (cardState.encrypted_target_context !== null) {
            activeContext = this.decrypt<TargetDisplayContext>(
              cardState.encrypted_target_context, this.config.dataEncryptionKey
            );
          }
          if (cardState.dm_message_id !== null) {
            const user = await this.client.users.fetch(discordUserId);
            const dm = await user.createDM();
            let existing: Message | null = null;
            try {
              existing = await dm.messages.fetch(cardState.dm_message_id);
            } catch (error) {
              if (!isDiscordUnknownMessage(error)) throw error;
              await this.database.clearStaleDmMapping(activeReport.reportId, cardState.dm_message_id);
            }
            if (existing !== null) {
              const options = statusMessageOptions(activeReport, activeContext);
              await existing.edit({ ...options, content: null, embeds: [] });
              await this.database.completeCardUpdate(activeReport.reportId, visibleStatusHash(activeReport, activeContext));
              this.clearCapturedFailure(`card_repair:${activeReport.reportId}`);
              return { outcome: "created" };
            }
          }
        }
      }
      const identity = await this.database.claimDmCard(activeReport.reportId);
      if (identity === null) return { outcome: "busy" };
      const user = await this.client.users.fetch(discordUserId);
      const dm = await user.createDM();
      const options = statusMessageOptions(activeReport, activeContext);
      let message = await reconcileUncertainCardMessage(
        dm, this.client.user?.id ?? null, activeReport.reportId, identity
      );
      if (message !== null) {
        await this.database.setDmMapping(activeReport.reportId, message.channelId, message.id);
        await message.edit({ ...options, content: null, embeds: [] });
      } else {
        payload = cardPayloadDiagnostics(options, identity.nonce);
        attemptedCardSend = true;
        message = await dm.send({ ...options, nonce: identity.nonce, enforceNonce: true });
        await this.database.setDmMapping(activeReport.reportId, message.channelId, message.id);
      }
      await this.database.completeCardUpdate(activeReport.reportId, visibleStatusHash(activeReport, activeContext));
      this.safeLog("initial_card_created", {
        reportId: activeReport.reportId, traceId: activeReport.traceId,
        stage: "initial_card", outcome: "completed", durationMs: Date.now() - startedAt
      });
      this.clearCapturedFailure(`card_repair:${activeReport.reportId}`);
      this.clearCapturedFailure(`card_repair_cleanup:${activeReport.reportId}`);
      return { outcome: "created" };
    } catch (error) {
      if (error instanceof UncertainCardDeliveryError) {
        await this.database.releaseDmCard(activeReport.reportId);
        this.safeLog("account_card_delivery_uncertain", {
          reportId: activeReport.reportId, traceId: activeReport.traceId,
          stage: "initial_card", outcome: "rescheduled", failureCategory: error.reason
        }, "warn");
        return { outcome: "uncertain", reason: error.reason };
      }
      const validationFailure = isDiscordValidationFailure(error);
      try {
        if (validationFailure) await this.database.terminalCardRepair(activeReport.reportId, "discord_validation_50035");
        else if (!attemptedCardSend) await this.database.releaseDmCard(activeReport.reportId);
      } catch (cleanupError) {
        this.safeLog("initial_card_cleanup_failed", {
          reportId: activeReport.reportId, traceId: activeReport.traceId,
          stage: "card_claim_cleanup", outcome: "failed",
          ...errorFields(cleanupError), failureCategory: safeErrorCategory(cleanupError)
        }, "error");
        this.captureFailureOnce(`card_repair_cleanup:${activeReport.reportId}`, cleanupError, {
          operation: "status_card_claim_cleanup", reportId: activeReport.reportId, traceId: activeReport.traceId,
          stage: "card_claim_cleanup", outcome: "failed", severity: "error"
        });
      }
      const diagnostics = {
        ...errorFields(error), ...(payload === undefined ? {} : { payload }), failureCategory: safeErrorCategory(error)
      };
      this.safeLog(validationFailure ? "initial_card_ignored" : "initial_card_failed", {
        reportId: activeReport.reportId, traceId: activeReport.traceId,
        stage: "initial_card", outcome: validationFailure ? "ignored" : "retry", durationMs: Date.now() - startedAt,
        ...diagnostics
      }, "warn");
      this.captureFailureOnce(`card_repair:${activeReport.reportId}`, error, {
        operation: "status_card_delivery", reportId: activeReport.reportId, traceId: activeReport.traceId,
        stage: "initial_card", outcome: validationFailure ? "ignored" : "retrying", attempt: 1
      });
      return validationFailure ? { outcome: "terminal" } : { outcome: "failed", diagnostics };
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
        ...errorFields(error),
        failureCategory: safeErrorCategory(error),
        stage: "reconciliation",
        outcome: "failed"
      }, "error");
      this.captureFailureOnce("reconciliation:connections", error, {
        operation: "account_event_reconciliation", stage: "reconciliation", outcome: "retrying", severity: "error"
      });
      return;
    }
    this.clearCapturedFailure("reconciliation:connections");
    for (const connection of connections) {
      if (this.stopping) break;
      const startedAt = Date.now();
      try {
        await this.reconcileConnection(connection);
        this.clearCapturedFailure(`reconciliation:${connection.account_id}`);
        this.safeLog("account_reconciliation_completed", {
          durationMs: Date.now() - startedAt, stage: "reconciliation", outcome: "completed"
        });
      } catch (error) {
        if (!(error instanceof ReconciliationEventIngestError)) {
          this.safeLog("account_reconciliation_failed", {
            durationMs: Date.now() - startedAt,
            ...errorFields(error),
            failureCategory: safeErrorCategory(error),
            stage: "reconciliation",
            outcome: "failed"
          }, "error");
          this.captureFailureOnce(`reconciliation:${connection.account_id}`, error, {
            operation: "account_event_reconciliation", stage: "reconciliation", outcome: "retrying", severity: "error"
          });
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
        const processed = await this.processOne();
        this.clearCapturedFailure("notification:claim_loop");
        if (!processed) await delay(1_000);
      } catch (error) {
        this.safeLog("account_notification_retry", {
          eventType: "unknown", attempts: 0, durationMs: 0, ...errorFields(error), failureCategory: safeErrorCategory(error),
          stage: "notification", outcome: "retry"
        }, "error");
        this.captureFailureOnce("notification:claim_loop", error, {
          operation: "lifecycle_notification_worker", stage: "notification", outcome: "retrying", severity: "error"
        });
        await delay(2_000);
      }
    }
  }

  public async sampleNotificationHealthOnce(): Promise<void> {
    const snapshot = await this.database.notificationHealthSnapshot();
    this.clearCapturedFailure("notification_health:sample");
    this.observeNotificationHealthSignal(
      "notification_backlog",
      snapshot.pendingNotificationCount,
      snapshot.oldestPendingNotificationAgeMs,
      "Bot lifecycle notifications remain pending beyond the delivery threshold."
    );
    this.observeNotificationHealthSignal(
      "stuck_card_updates",
      snapshot.pendingCardUpdateCount,
      snapshot.oldestPendingCardUpdateAgeMs,
      "Bot report status card delivery work remains pending beyond the threshold."
    );
  }

  private async monitorNotificationHealth(): Promise<void> {
    while (!this.stopping) {
      try {
        await this.sampleNotificationHealthOnce();
      } catch (error) {
        this.captureFailureOnce("notification_health:sample", error, {
          operation: "notification_health_sampling", stage: "notification_health", outcome: "retrying", severity: "warning"
        });
      }
      for (let second = 0; second < NOTIFICATION_HEALTH_SAMPLE_SECONDS && !this.stopping; second += 1) {
        await delay(1_000);
      }
    }
  }

  private observeNotificationHealthSignal(
    key: NotificationHealthSignalKey,
    queueCount: number,
    oldestAgeMs: number | null,
    message: string
  ): void {
    const current = this.notificationHealthSignals.get(key) ?? {
      unhealthySamples: 0, healthySamples: 0, reported: false
    };
    const unhealthy = queueCount > 0 && oldestAgeMs !== null && oldestAgeMs >= NOTIFICATION_HEALTH_THRESHOLD_MS;
    if (unhealthy) {
      current.unhealthySamples += 1;
      current.healthySamples = 0;
      if (!current.reported && current.unhealthySamples >= NOTIFICATION_HEALTH_BAD_SAMPLES) {
        current.reported = true;
        captureLifecycleFailure(new Error(message), {
          service: "bot",
          operation: key,
          stage: "notification_health",
          outcome: "stuck",
          severity: "warning",
          queueCount,
          ...(oldestAgeMs === null ? {} : { oldestAgeMs })
        });
      }
    } else {
      current.unhealthySamples = 0;
      if (current.reported) {
        current.healthySamples += 1;
        if (current.healthySamples >= NOTIFICATION_HEALTH_RECOVERY_SAMPLES) {
          current.reported = false;
          current.healthySamples = 0;
        }
      }
    }
    this.notificationHealthSignals.set(key, current);
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
        this.clearCapturedFailure("report_recovery:cycle");
      } catch (error) {
        this.safeLog("report_create_recovery_failed", {
          stage: "creation_recovery", outcome: "retry", durationMs: 0,
          ...errorFields(error), failureCategory: safeErrorCategory(error)
        }, "warn");
        this.captureFailureOnce("report_recovery:cycle", error, {
          operation: "report_recovery", stage: "creation_recovery", outcome: "retrying", severity: "error"
        });
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

  private captureFailureOnce(key: string, error: unknown, context: BotFailureContext): void {
    if (!isActionableFailure(error) || this.reportedSentryFailures.has(key)) return;
    if (this.reportedSentryFailures.size >= 2_048) {
      const oldest = this.reportedSentryFailures.values().next().value;
      if (oldest !== undefined) this.reportedSentryFailures.delete(oldest);
    }
    this.reportedSentryFailures.add(key);
    captureLifecycleFailure(error, { service: "bot", ...failureContext(error), ...context });
  }

  private clearCapturedFailure(key: string): void {
    this.reportedSentryFailures.delete(key);
  }
}
