import { setTimeout as delay } from "node:timers/promises";

import { DsaApiError, reportReasonLabel } from "@discord-dsa/contracts";
import type { CreateReportInput, DsaApi } from "@discord-dsa/contracts";
import { DiscordAPIError } from "discord.js";
import type { Client, Message, User } from "discord.js";

import type { BotConfig } from "./config.js";
import { decryptJson, encryptJson } from "./crypto.js";
import type { BotDatabase, ExperimentalBatchWorkItemRow } from "./database.js";
import {
  explanationFingerprint,
  experimentalItemIdentity
} from "./experimental-batches.js";
import {
  experimentalBatchEmbed,
  experimentalReportedMessage
} from "./experimental-batch-ui.js";
import { applyWriterResult } from "./interactions.js";
import { botLog, errorFields, pseudonymousActorKey } from "./observability.js";
import type { ReportWriter } from "./report-writer.js";
import type { ExperimentalBatchItemState, ReportDraft } from "./types.js";
import { draftToCreateInput } from "./ui.js";

const WORKER_CONCURRENCY = 2;

export async function runWithConcurrency<T>(
  items: readonly T[],
  concurrency: number,
  operation: (item: T) => Promise<void>
): Promise<void> {
  let index = 0;
  const workerCount = Math.min(Math.max(concurrency, 1), items.length);
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (index < items.length) {
        const item = items[index];
        index += 1;
        if (item !== undefined) await operation(item);
      }
    })
  );
}

function discordErrorCode(error: unknown): number | string | undefined {
  if (error instanceof DiscordAPIError) return error.code;
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "number" || typeof code === "string") return code;
  }
  return undefined;
}

function isUnknownMessage(error: unknown): boolean {
  return discordErrorCode(error) === 10_008;
}

function preparationErrorCode(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error) {
    if ((error as { code?: unknown }).code === "23505") return "duplicate_report_reason";
  }
  return "ai_preparation_failed";
}

function createErrorCode(error: unknown): string {
  if (error instanceof DsaApiError) {
    if (error.status === 429) return "api_create_rate_limited";
    if (error.status < 500) return `api_create_${error.code}`;
  }
  return "api_create_ambiguous";
}

function runnableState(state: ExperimentalBatchItemState): Extract<
  ExperimentalBatchItemState,
  "queued" | "creating" | "reconciling" | "observing" | "retrying"
> {
  if (state === "preparing" || state === "blocked") return "queued";
  if (state === "submitted" || state === "failed") return "observing";
  return state;
}

export class ExperimentalBatchWorker {
  private stopped = true;
  private ticking = false;
  private readonly refreshes = new Map<string, Promise<void>>();

  public constructor(
    private readonly database: BotDatabase,
    private readonly api: DsaApi,
    private readonly client: Client,
    private readonly config: BotConfig,
    private readonly reportWriter: ReportWriter
  ) {}

  public start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    void this.loop();
  }

  public stop(): void {
    this.stopped = true;
  }

  private async loop(): Promise<void> {
    while (!this.stopped) {
      await this.tick();
      if (!this.stopped) await delay(5_000);
    }
  }

  public async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const items = await this.database.claimExperimentalBatchItems(WORKER_CONCURRENCY);
      const batchIds = [...new Set(items.map((item) => item.batch_id))];
      await Promise.all(batchIds.map((batchId) => this.refreshBatch(batchId)));
      await runWithConcurrency(items, WORKER_CONCURRENCY, async (item) => {
        try {
          await this.processItem(item);
        } catch (error) {
          botLog(
            "experimental_batch_item_failed_unexpectedly",
            {
              actorKey: pseudonymousActorKey(
                item.discord_user_id,
                this.config.keyPepper
              ),
              mode: item.mode,
              ordinal: item.ordinal,
              ...errorFields(error)
            },
            "error"
          );
          await this.database.rescheduleExperimentalBatchItem(
            item.id,
            runnableState(item.state),
            60,
            "unexpected_worker_failure"
          );
        } finally {
          await this.refreshBatch(item.batch_id);
        }
      });
    } catch (error) {
      botLog("experimental_batch_worker_tick_failed", errorFields(error), "error");
    } finally {
      this.ticking = false;
    }
  }

  private async processItem(item: ExperimentalBatchWorkItemRow): Promise<void> {
    if (item.state === "queued" || item.state === "preparing") {
      await this.prepareItem(item);
      return;
    }
    if (item.state === "creating" || item.state === "reconciling") {
      await this.createItem(item);
      return;
    }
    if (item.state === "retrying") {
      await this.retryLifecycle(item);
      return;
    }
    if (item.state === "observing") {
      await this.observeItem(item);
    }
  }

  private async prepareItem(item: ExperimentalBatchWorkItemRow): Promise<void> {
    const attempt = await this.database.markExperimentalPreparationAttempt(item.id);
    let request: CreateReportInput;
    let tracking: { trackingId: string; interactionIdentity: string };
    try {
      const draft = decryptJson<ReportDraft>(
        item.encrypted_draft,
        this.config.dataEncryptionKey
      );
      const accepted = await this.database.acceptedExperimentalReasons(item.batch_id);
      const priorReportReasons = accepted.flatMap((encryptedRequest) => {
        try {
          return [
            decryptJson<CreateReportInput>(encryptedRequest, this.config.dataEncryptionKey)
              .reportReason
          ];
        } catch {
          return [];
        }
      });
      const fixedType = item.report_type ?? item.shared_report_type;
      if (fixedType) draft.reportType = fixedType;
      draft.experimentalVariation = {
        ordinal: item.ordinal,
        total: item.item_count,
        priorReportReasons
      };
      const result = await this.reportWriter.generate(draft, {
        actorKey: pseudonymousActorKey(item.discord_user_id, this.config.keyPepper),
        userId: item.discord_user_id
      });
      applyWriterResult(draft, result, "Generated");
      request = draftToCreateInput(draft, item.discord_user_id);
      tracking = await this.database.prepareExperimentalBatchItem({
        itemId: item.id,
        userId: item.discord_user_id,
        country: request.country,
        reportType: request.reportType,
        explanationFingerprint: explanationFingerprint(request.reportReason),
        encryptedRequest: encryptJson(request, this.config.dataEncryptionKey),
        ...(draft.aiDecisions ? { aiDecisions: draft.aiDecisions } : {})
      });
    } catch (error) {
      const safeCode = preparationErrorCode(error);
      if (attempt < 2) {
        await this.database.rescheduleExperimentalBatchItem(
          item.id,
          "queued",
          15 * 2 ** Math.max(attempt - 1, 0),
          safeCode
        );
      } else {
        await this.database.failExperimentalBatchItem(item.id, safeCode);
      }
      return;
    }
    await this.createItem(item, request, tracking);
  }

  private async createItem(
    item: ExperimentalBatchWorkItemRow,
    preparedRequest?: CreateReportInput,
    preparedTracking?: { trackingId: string; interactionIdentity: string }
  ): Promise<void> {
    const trackingId = preparedTracking?.trackingId ?? item.tracking_id;
    if (!trackingId) throw new Error("Experimental item has no create tracking identity.");
    const interactionIdentity =
      preparedTracking?.interactionIdentity ?? experimentalItemIdentity(item.batch_id, item.ordinal);
    const request =
      preparedRequest ??
      (item.encrypted_request
        ? decryptJson<CreateReportInput>(item.encrypted_request, this.config.dataEncryptionKey)
        : null);
    if (!request) throw new Error("Experimental item has no encrypted create request.");
    const attempt = await this.database.markExperimentalCreateAttempt(item.id);
    try {
      const report = await this.api.createReport(interactionIdentity, request);
      await this.database.markExperimentalSubmissionCreated(item.id, trackingId, report);
      botLog("experimental_batch_report_created", {
        actorKey: pseudonymousActorKey(item.discord_user_id, this.config.keyPepper),
        mode: item.mode,
        ordinal: item.ordinal,
        status: report.status
      });
    } catch (error) {
      const safeCode = createErrorCode(error);
      if (error instanceof DsaApiError && error.status === 429 && attempt < 2) {
        await this.database.rescheduleExperimentalBatchItem(
          item.id,
          "creating",
          120,
          safeCode
        );
      } else if (error instanceof DsaApiError && error.status < 500) {
        await this.database.failExperimentalBatchItem(item.id, safeCode);
      } else {
        await this.database.rescheduleExperimentalBatchItem(
          item.id,
          "reconciling",
          60,
          safeCode
        );
      }
    }
  }

  private async observeItem(item: ExperimentalBatchWorkItemRow): Promise<void> {
    if (!item.tracking_id || !item.current_report_id) {
      await this.createItem(item);
      return;
    }
    try {
      const report = await this.api.report(item.current_report_id);
      const schedule = await this.database.observeExperimentalBatchItem(
        item.id,
        item.tracking_id,
        report,
        item.lifecycle_retries
      );
      if (schedule.state === "retrying") await this.retryLifecycle(item);
    } catch (error) {
      await this.database.rescheduleExperimentalBatchItem(
        item.id,
        "observing",
        error instanceof DsaApiError && error.status === 429 ? 120 : 60,
        "api_observation_failed"
      );
    }
  }

  private async retryLifecycle(item: ExperimentalBatchWorkItemRow): Promise<void> {
    if (!item.current_report_id || !item.tracking_id || item.lifecycle_retries >= 1) return;
    const identity = `experimental-retry:${item.batch_id}:${item.ordinal}`;
    try {
      const report = await this.api.retryReport(
        item.current_report_id,
        identity,
        item.discord_user_id
      );
      await this.database.trackExperimentalRetryReport(
        item.id,
        item.tracking_id,
        identity,
        report
      );
      botLog("experimental_batch_report_retried", {
        actorKey: pseudonymousActorKey(item.discord_user_id, this.config.keyPepper),
        mode: item.mode,
        ordinal: item.ordinal,
        status: report.status
      });
    } catch (error) {
      if (error instanceof DsaApiError && error.status < 500 && error.status !== 429) {
        await this.database.failExperimentalBatchItem(item.id, "lifecycle_retry_rejected");
      } else {
        await this.database.rescheduleExperimentalBatchItem(
          item.id,
          "retrying",
          error instanceof DsaApiError && error.status === 429 ? 120 : 60,
          "lifecycle_retry_ambiguous"
        );
      }
    }
  }

  private async refreshBatch(batchId: string): Promise<void> {
    const previous = this.refreshes.get(batchId) ?? Promise.resolve();
    const current = previous
      .catch(() => undefined)
      .then(() => this.performBatchRefresh(batchId));
    this.refreshes.set(batchId, current);
    try {
      await current;
    } finally {
      if (this.refreshes.get(batchId) === current) this.refreshes.delete(batchId);
    }
  }

  private async performBatchRefresh(batchId: string): Promise<void> {
    const rows = await this.database.experimentalBatchView(batchId);
    const first = rows[0];
    if (!first || first.dm_blocked) return;
    let reportedMessage: string | null = null;
    try {
      const draft = decryptJson<ReportDraft>(
        first.encrypted_draft,
        this.config.dataEncryptionKey
      );
      if (draft.messageEvidence?.status === "captured") {
        reportedMessage = experimentalReportedMessage(draft.messageEvidence.snapshot);
      }
    } catch {
      reportedMessage = null;
    }
    const items = rows.map((row) => {
      let reportReason: string | null = null;
      if (row.encrypted_request) {
        try {
          reportReason = decryptJson<CreateReportInput>(
            row.encrypted_request,
            this.config.dataEncryptionKey
          ).reportReason;
        } catch {
          reportReason = null;
        }
      }
      return {
        ordinal: row.ordinal,
        categoryLabel: row.report_type
          ? row.category_snapshot.find((reason) => reason.value === row.report_type)?.label ??
            reportReasonLabel("message_urf", row.report_type)
          : "Choosing category",
        state: row.state,
        lastStatus: row.last_status,
        lastDiscordStatus: row.last_discord_status,
        lastReviewStatus: row.last_review_status,
        reportReason,
        originalReportId: row.original_report_id,
        currentReportId: row.current_report_id,
        successorReportId: row.successor_report_id,
        safeErrorCode: row.safe_error_code
      };
    });
    const payload = {
      embeds: [
        experimentalBatchEmbed({
          mode: first.mode,
          itemCount: first.item_count,
          reportedMessage,
          items
        })
      ],
      components: [],
      allowedMentions: { parse: [] as never[] }
    };
    try {
      const user = await this.client.users.fetch(first.discord_user_id);
      let message = first.status_dm_message_id
        ? await this.storedBatchMessage(user, first.status_dm_message_id)
        : null;
      if (message) {
        await message.edit(payload);
      } else {
        message = await user.send(payload);
        await this.database.saveExperimentalBatchDm(batchId, message.id);
      }
    } catch (error) {
      if (discordErrorCode(error) === 50_007) {
        await this.database.markExperimentalBatchDmBlocked(batchId);
        return;
      }
      throw error;
    }
  }

  private async storedBatchMessage(user: User, messageId: string): Promise<Message | null> {
    const channel = await user.createDM();
    try {
      return await channel.messages.fetch(messageId);
    } catch (error) {
      if (isUnknownMessage(error)) return null;
      throw error;
    }
  }
}
