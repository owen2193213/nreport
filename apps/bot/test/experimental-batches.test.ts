import { randomBytes } from "node:crypto";

import { DsaApiError } from "@discord-dsa/contracts";
import type { ReportDetail } from "@discord-dsa/contracts";
import type { DsaApi } from "@discord-dsa/contracts";
import { USER_MESSAGE_REPORT_REASONS } from "@discord-dsa/contracts";
import type { Client } from "discord.js";
import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";

import type { BotConfig } from "../src/config.js";
import { encryptJson } from "../src/crypto.js";
import {
  explanationFingerprint,
  experimentalBatchDefinitions,
  experimentalItemIdentity,
  experimentalVariationInstruction
} from "../src/experimental-batches.js";
import {
  batchBalanceAfterReservation,
  BotDatabase,
  experimentalClaimLimit,
  experimentalObservationSchedule,
  experimentalRetryDelaySeconds
} from "../src/database.js";
import {
  experimentalBatchEmbed,
  experimentalLatestOutcome,
  experimentalReportedMessage
} from "../src/experimental-batch-ui.js";
import {
  ExperimentalBatchWorker,
  runWithConcurrency
} from "../src/experimental-batch-worker.js";
import type { ReportWriter } from "../src/report-writer.js";
import type { MessageSnapshot, ReportDraft } from "../src/types.js";
import type { ExperimentalBatchWorkItemRow } from "../src/database.js";

class ReservationPool {
  public balance: number;
  public readonly batches: string[] = [];
  public readonly items: string[] = [];
  public readonly ledgerDeltas: number[] = [];
  public commits = 0;
  public rollbacks = 0;

  public constructor(balance: number) {
    this.balance = balance;
  }

  public connect = () => ({
    query: (sql: string, values: unknown[] = []) => {
      if (sql === "BEGIN") return { rows: [], rowCount: null };
      if (sql === "COMMIT") {
        this.commits += 1;
        return { rows: [], rowCount: null };
      }
      if (sql === "ROLLBACK") {
        this.rollbacks += 1;
        return { rows: [], rowCount: null };
      }
      if (sql.includes("INSERT INTO bot_users")) return { rows: [], rowCount: 1 };
      if (sql.includes("FROM experimental_report_batches")) {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes("SELECT credits") && sql.includes("FROM bot_users")) {
        return {
          rows: [
            {
              credits: this.balance,
              default_country: null,
              suspended: false,
              suspension_reason: null
            }
          ],
          rowCount: 1
        };
      }
      if (sql.includes("INSERT INTO experimental_report_batches")) {
        this.batches.push(String(values[0]));
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("INSERT INTO experimental_report_batch_items")) {
        this.items.push(String(values[0]));
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("UPDATE bot_users SET credits")) {
        this.balance = Number(values[1]);
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("INSERT INTO credit_ledger")) {
        this.ledgerDeltas.push(Number(values[1]));
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`Unexpected SQL in reservation test: ${sql}`);
    },
    release: () => undefined
  });
}

class ClaimPool {
  public selectedLimit: number | null = null;
  public lockedIds: string[] = [];

  public connect = () => ({
    query: (sql: string, values: unknown[] = []) => {
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") {
        return { rows: [], rowCount: null };
      }
      if (sql.includes("FROM experimental_report_batch_items AS item")) {
        this.selectedLimit = Number(values[0]);
        return {
          rows: [
            { id: "item-1", batch_id: "batch-id", ordinal: 1, state: "queued" },
            { id: "item-2", batch_id: "batch-id", ordinal: 2, state: "queued" }
          ].slice(0, this.selectedLimit),
          rowCount: this.selectedLimit
        };
      }
      if (sql.includes("SET locked_at = now()")) {
        this.lockedIds = values[0] as string[];
        return { rows: [], rowCount: this.lockedIds.length };
      }
      throw new Error(`Unexpected SQL in claim test: ${sql}`);
    },
    release: () => undefined
  });
}

class ReleasePool {
  public balance = 4;
  public creditState = "reserved";
  public state = "queued";
  public ledgerEntries = 0;

  public connect = () => ({
    query: (sql: string, values: unknown[] = []) => {
      if (sql === "BEGIN" || sql === "ROLLBACK") return { rows: [], rowCount: null };
      if (sql === "COMMIT") return { rows: [], rowCount: null };
      if (
        sql.includes("FROM experimental_report_batch_items AS item") &&
        sql.includes("FOR UPDATE")
      ) {
        return {
          rows: [
            {
              id: "item-id",
              batch_id: "batch-id",
              discord_user_id: "1197857362942378017",
              credit_state: this.creditState,
              state: this.state,
              tracking_id: null
            }
          ],
          rowCount: 1
        };
      }
      if (sql.includes("SELECT credits") && sql.includes("FROM bot_users")) {
        return { rows: [{ credits: this.balance }], rowCount: 1 };
      }
      if (sql.includes("UPDATE bot_users SET credits")) {
        this.balance = Number(values[1]);
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("INSERT INTO credit_ledger")) {
        this.ledgerEntries += 1;
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("UPDATE experimental_report_batch_items")) {
        this.creditState = "released";
        this.state = "failed";
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`Unexpected SQL in release test: ${sql}`);
    },
    release: () => undefined
  });
}

class LifecyclePool {
  public readonly batchReviewStatuses: unknown[] = [];

  public connect = () => ({
    query: (sql: string, values: unknown[] = []) => {
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") {
        return { rows: [], rowCount: null };
      }
      if (sql.includes("SELECT item.* FROM experimental_report_batch_items")) {
        return {
          rows: [{ ...this.itemRow(), lifecycle_retries: 0 }],
          rowCount: 1
        };
      }
      if (sql.includes("SELECT * FROM report_tracking")) {
        return {
          rows: [{
            discord_user_id: "1197857362942378017",
            flow: "message_urf",
            encrypted_request: "encrypted",
            server_snapshot: null,
            ai_decisions: []
          }],
          rowCount: 1
        };
      }
      if (sql.includes("UPDATE experimental_report_batch_items")) {
        const placeholder = /last_review_status\s*=\s*\$(\d+)/.exec(sql);
        this.batchReviewStatuses.push(
          placeholder ? values[Number(placeholder[1]) - 1] : undefined
        );
      }
      return { rows: [], rowCount: 1 };
    },
    release: () => undefined
  });

  private itemRow(): ExperimentalBatchWorkItemRow {
    return {
      id: "item-id",
      batch_id: "batch-id",
      ordinal: 1,
      report_type: "sub_other_hate_speech",
      state: "retrying",
      preparation_attempts: 1,
      create_attempts: 1,
      lifecycle_retries: 0,
      explanation_fingerprint: null,
      tracking_id: "tracking-id",
      original_report_id: "report-1",
      current_report_id: "report-1",
      successor_report_id: null,
      credit_state: "consumed",
      safe_error_code: null,
      last_status: "failed",
      last_discord_status: null,
      last_review_status: null,
      retryable: true,
      discord_user_id: "1197857362942378017",
      interaction_id: "interaction-id",
      mode: "same_category_10x",
      item_count: 10,
      encrypted_draft: "encrypted",
      category_snapshot: [...USER_MESSAGE_REPORT_REASONS],
      shared_report_type: "sub_other_hate_speech",
      status_dm_message_id: null,
      dm_blocked: false,
      encrypted_request: "encrypted"
    };
  }
}

describe("experimental report batch domain", () => {
  it("creates ten blocked same-category items after one Auto seed", () => {
    const items = experimentalBatchDefinitions(
      "same_category_10x",
      USER_MESSAGE_REPORT_REASONS
    );

    expect(items).toHaveLength(10);
    expect(items[0]).toMatchObject({ ordinal: 1, reportType: null, state: "queued" });
    expect(items.slice(1).every((item) => item.state === "blocked")).toBe(true);
  });

  it("captures every message category exactly once in catalog order", () => {
    const items = experimentalBatchDefinitions(
      "all_categories",
      USER_MESSAGE_REPORT_REASONS
    );

    expect(items.map((item) => item.reportType)).toEqual([
      "sub_general_scrm_icwm",
      "sub_icwm",
      "sub_icaam",
      "sub_csam",
      "threatening_behavior",
      "sub_glorifying_violence",
      "sub_racist_or_discriminatory_language_or_imagery",
      "sub_coppa",
      "sub_self_harm_encouragement",
      "sub_cracked_accounts",
      "sub_illicit_goods",
      "sub_ncp",
      "sub_unsolicited_porn",
      "sub_other_child_safety",
      "sub_other_threats",
      "sub_other_cybercrime",
      "sub_other_hate_speech",
      "sub_other_unwanted_sexual_content"
    ]);
  });

  it("normalizes explanation fingerprints and creates stable per-item identities", () => {
    expect(explanationFingerprint("  HATE\nSpeech ")).toBe(
      explanationFingerprint("hate speech")
    );
    expect(experimentalItemIdentity("batch-id", 3)).toBe("experimental:batch-id:3");
  });

  it("gives each variant a factual distinctness instruction", () => {
    const instruction = experimentalVariationInstruction(2, 10, ["First reason"]);

    expect(instruction).toContain("Variant 2 of 10");
    expect(instruction).toContain("First reason");
    expect(instruction).toContain("materially different");
    expect(instruction).toContain("Do not invent evidence");
  });
});

describe("experimental report batch credits", () => {
  it("reserves the complete batch or preserves a bypassed balance", () => {
    expect(batchBalanceAfterReservation(20, 10, false)).toBe(10);
    expect(batchBalanceAfterReservation(20, 18, false)).toBe(2);
    expect(batchBalanceAfterReservation(20, 18, true)).toBe(20);
  });

  it("rejects a partial batch before credits are deducted", () => {
    expect(() => batchBalanceAfterReservation(9, 10, false)).toThrow(
      "You need 10 report credits."
    );
  });

  it("atomically persists every item and deducts the full reservation once", async () => {
    const pool = new ReservationPool(5);
    const database = new BotDatabase("postgres://test", pool as unknown as Pool);
    const categories = USER_MESSAGE_REPORT_REASONS.slice(0, 2);

    const result = await database.reserveExperimentalBatch({
      userId: "1197857362942378017",
      interactionId: "interaction-id",
      mode: "all_categories",
      requiredCredits: 2,
      encryptedDraft: "encrypted",
      categories,
      definitions: experimentalBatchDefinitions("all_categories", categories),
      adminBypass: false
    });

    expect(result).toMatchObject({
      itemCount: 2,
      balanceBefore: 5,
      balanceAfter: 3,
      replayed: false
    });
    expect(pool.balance).toBe(3);
    expect(pool.batches).toHaveLength(1);
    expect(pool.items).toHaveLength(2);
    expect(pool.ledgerDeltas).toEqual([-2]);
    expect(pool.commits).toBe(1);
    expect(pool.rollbacks).toBe(0);
  });

  it("rolls back an insufficient reservation without partial state", async () => {
    const pool = new ReservationPool(1);
    const database = new BotDatabase("postgres://test", pool as unknown as Pool);
    const categories = USER_MESSAGE_REPORT_REASONS.slice(0, 2);

    await expect(
      database.reserveExperimentalBatch({
        userId: "1197857362942378017",
        interactionId: "interaction-id",
        mode: "all_categories",
        requiredCredits: 2,
        encryptedDraft: "encrypted",
        categories,
        definitions: experimentalBatchDefinitions("all_categories", categories),
        adminBypass: false
      })
    ).rejects.toThrow("You need 2 report credits.");

    expect(pool.balance).toBe(1);
    expect(pool.batches).toHaveLength(0);
    expect(pool.items).toHaveLength(0);
    expect(pool.ledgerDeltas).toHaveLength(0);
    expect(pool.commits).toBe(0);
    expect(pool.rollbacks).toBe(1);
  });
});

describe("experimental report batch scheduling", () => {
  const report = (overrides: Partial<ReportDetail>): ReportDetail =>
    ({
      status: "queued",
      discordStatus: null,
      retryable: false,
      error: null,
      ...overrides
    }) as ReportDetail;

  it("caps every database claim at the global concurrency of two", () => {
    expect(experimentalClaimLimit(100)).toBe(2);
    expect(experimentalClaimLimit(2)).toBe(2);
    expect(experimentalClaimLimit(0)).toBe(1);
  });

  it("uses bounded backoff for the two preparation attempts", () => {
    expect(experimentalRetryDelaySeconds(1)).toBe(15);
    expect(experimentalRetryDelaySeconds(2)).toBe(30);
    expect(experimentalRetryDelaySeconds(8)).toBe(300);
  });

  it("schedules exactly one safe lifecycle retry", () => {
    expect(
      experimentalObservationSchedule(
        report({ status: "failed", retryable: true }),
        0
      )
    ).toEqual({ state: "retrying", delaySeconds: 0 });
    expect(
      experimentalObservationSchedule(
        report({ status: "failed", retryable: true }),
        1
      )
    ).toEqual({ state: "failed", delaySeconds: null });
  });

  it("never retries an ambiguous final submission", () => {
    expect(
      experimentalObservationSchedule(
        report({
          status: "failed",
          retryable: false,
          error: { code: "ambiguous_submission_state", message: "Unknown final state." }
        }),
        0
      )
    ).toEqual({ state: "failed", delaySeconds: null });
  });

  it("polls active reports but lets submitted reports wait for lifecycle events", () => {
    expect(experimentalObservationSchedule(report({ status: "verifying" }), 0)).toEqual({
      state: "observing",
      delaySeconds: 30
    });
    expect(experimentalObservationSchedule(report({ status: "submitted" }), 0)).toEqual({
      state: "submitted",
      delaySeconds: null
    });
  });

  it("claims no more than two durable items and locks exactly those rows", async () => {
    const pool = new ClaimPool();
    const database = new BotDatabase("postgres://test", pool as unknown as Pool);

    const claimed = await database.claimExperimentalBatchItems(99);

    expect(claimed.map((item) => item.id)).toEqual(["item-1", "item-2"]);
    expect(pool.selectedLimit).toBe(2);
    expect(pool.lockedIds).toEqual(["item-1", "item-2"]);
  });

  it("releases one reserved item exactly once", async () => {
    const pool = new ReleasePool();
    const database = new BotDatabase("postgres://test", pool as unknown as Pool);

    await database.failExperimentalBatchItem("item-id", "ai_preparation_failed");
    await database.failExperimentalBatchItem("item-id", "ai_preparation_failed");

    expect(pool.balance).toBe(5);
    expect(pool.creditState).toBe("released");
    expect(pool.state).toBe("failed");
    expect(pool.ledgerEntries).toBe(1);
  });
});

describe("experimental report batch lifecycle persistence", () => {
  const lifecycleReport = (
    reviewStatus: ReportDetail["reviewStatus"]
  ): ReportDetail => ({
    internalReportId: "report-2",
    status: "submitted",
    discordStatus: "actioned",
    reviewStatus,
    retryable: false,
    error: null,
    country: "DE",
    reportType: "sub_other_hate_speech"
  } as ReportDetail);

  it("persists appeal status on create, observation, and retry transitions", async () => {
    const pool = new LifecyclePool();
    const database = new BotDatabase("postgres://test", pool as unknown as Pool);

    await database.markExperimentalSubmissionCreated(
      "item-id",
      "tracking-id",
      lifecycleReport(null)
    );
    await database.observeExperimentalBatchItem(
      "item-id",
      "tracking-id",
      lifecycleReport("approved"),
      0
    );
    await database.trackExperimentalRetryReport(
      "item-id",
      "tracking-id",
      "experimental:batch-id:1",
      lifecycleReport("requested")
    );

    expect(pool.batchReviewStatuses).toEqual([null, "approved", "requested"]);
  });
});

describe("experimental report batch aggregate card", () => {
  it.each([
    [{ state: "submitted", lastStatus: "submitted", lastDiscordStatus: null,
      lastReviewStatus: "approved" }, "Appeal accepted"],
    [{ state: "submitted", lastStatus: "submitted", lastDiscordStatus: "actioned",
      lastReviewStatus: null }, "Report accepted"],
    [{ state: "submitted", lastStatus: "submitted", lastDiscordStatus: "closed_no_action",
      lastReviewStatus: null }, "Report closed without action"],
    [{ state: "submitted", lastStatus: "submitted", lastDiscordStatus: "received",
      lastReviewStatus: null }, "Report received — awaiting decision"],
    [{ state: "submitted", lastStatus: "submitted", lastDiscordStatus: null,
      lastReviewStatus: null }, "Submitted — awaiting confirmation"],
    [{ state: "preparing", lastStatus: null, lastDiscordStatus: null,
      lastReviewStatus: null }, "Preparing with AI"]
  ] as const)("selects the authoritative latest outcome", (item, expected) => {
    expect(experimentalLatestOutcome(item)).toBe(expected);
  });

  it.each([
    ["queued", "Appeal preparing"],
    ["requested", "Appeal submitted — awaiting confirmation"],
    ["received", "Appeal received — awaiting decision"],
    ["confirmation_timeout", "Appeal submitted — confirmation not received"],
    ["request_failed", "Appeal failed"],
    ["ineligible", "Appeal unavailable"],
    ["request_ambiguous", "Appeal uncertain"],
    ["approved", "Appeal accepted"],
    ["not_approved", "Appeal denied"]
  ] as const)("renders review status %s", (lastReviewStatus, expected) => {
    expect(experimentalLatestOutcome({
      state: "submitted",
      lastStatus: "submitted",
      lastDiscordStatus: "actioned",
      lastReviewStatus
    })).toBe(expected);
  });

  it("renders a bounded original message or a content-count fallback", () => {
    const snapshot: MessageSnapshot = {
      messageId: "message-1",
      channelId: "channel-1",
      channelName: "general",
      serverId: "server-1",
      serverName: "Example",
      authorId: "author-1",
      authorUsername: "author",
      authorDisplayName: "Author",
      authorBot: false,
      content: `  Original targeted content\r\n${"x".repeat(600)}  `,
      createdAt: "2026-08-09T00:00:00.000Z",
      attachments: [],
      embeds: []
    };

    const rendered = experimentalReportedMessage(snapshot);
    expect(rendered).toContain("Original targeted content\n");
    expect(rendered).toHaveLength(500);
    expect(experimentalReportedMessage({
      ...snapshot,
      content: "",
      attachments: [
        { name: "one", url: "https://example.invalid/one", contentType: null },
        { name: "two", url: "https://example.invalid/two", contentType: null }
      ],
      embeds: [{ title: null, description: null, url: null }]
    })).toBe("No text content · 2 attachments · 1 embed");
  });

  it("fits every current message category in one Discord embed", () => {
    const embed = experimentalBatchEmbed({
      mode: "all_categories",
      itemCount: 18,
      reportedMessage: "Original targeted content",
      items: USER_MESSAGE_REPORT_REASONS.map((reason, index) => ({
        ordinal: index + 1,
        categoryLabel: reason.label,
        state: "submitted",
        lastStatus: "submitted",
        lastDiscordStatus: "actioned",
        lastReviewStatus: null,
        reportReason: "A".repeat(512),
        originalReportId: `original-report-${index + 1}`,
        currentReportId: `current-report-${index + 1}`,
        successorReportId: null,
        safeErrorCode: null
      }))
    }).toJSON();

    expect(embed.fields).toHaveLength(18);
    expect(embed.description).toContain("**Reported message**\nOriginal targeted content");
    expect(embed.fields![0]?.value).toContain("Latest: **Report accepted**");
    expect(embed.fields!.every((field) => field.name.length <= 256)).toBe(true);
    expect(embed.fields!.every((field) => field.value.length <= 1_024)).toBe(true);
    const characters =
      (embed.title?.length ?? 0) +
      (embed.description?.length ?? 0) +
      embed.fields!.reduce(
        (sum, field) => sum + field.name.length + field.value.length,
        0
      );
    expect(characters).toBeLessThanOrEqual(6_000);
  });
});

describe("experimental report batch worker", () => {
  const encryptionKey = randomBytes(32);
  const draft = {
    flow: "message_urf" as const,
    country: "DE",
    countrySelection: "default" as const,
    messageUrl:
      "https://discord.com/channels/1/123456789012345678/123456789012345679",
    sendToDms: false
  };

  function workItem(
    overrides: Partial<ExperimentalBatchWorkItemRow> = {}
  ): ExperimentalBatchWorkItemRow {
    return {
      id: "item-1",
      batch_id: "batch-1",
      ordinal: 1,
      report_type: null,
      state: "queued",
      preparation_attempts: 0,
      create_attempts: 0,
      lifecycle_retries: 0,
      explanation_fingerprint: null,
      tracking_id: null,
      original_report_id: null,
      current_report_id: null,
      successor_report_id: null,
      credit_state: "reserved",
      safe_error_code: null,
      last_status: null,
      last_discord_status: null,
      last_review_status: null,
      retryable: null,
      discord_user_id: "1197857362942378017",
      interaction_id: "interaction-id",
      mode: "same_category_10x",
      item_count: 10,
      encrypted_draft: encryptJson(draft, encryptionKey),
      category_snapshot: [...USER_MESSAGE_REPORT_REASONS],
      shared_report_type: null,
      status_dm_message_id: null,
      dm_blocked: false,
      encrypted_request: null,
      ...overrides
    };
  }

  function report(overrides: Partial<ReportDetail> = {}): ReportDetail {
    return {
      internalReportId: "report-1",
      country: "DE",
      flow: "message_urf",
      reportType: "sub_other_hate_speech",
      submitterDiscordUserId: "1197857362942378017",
      pseudonym: "hidden",
      email: "hidden@example.invalid",
      locale: "de-DE",
      timezone: "Europe/Berlin",
      lifecycleAttempt: 1,
      retryable: false,
      retryOfReportId: null,
      retriedAsReportId: null,
      retrySequence: 0,
      failureStage: null,
      status: "queued",
      discordReportId: null,
      discordStatus: null,
      discordStatusUpdatedAt: null,
      reviewStatus: null,
      reviewStatusUpdatedAt: null,
      reviewError: null,
      appealRetryable: false,
      resubmittable: false,
      error: null,
      createdAt: "2026-08-09T00:00:00.000Z",
      updatedAt: "2026-08-09T00:00:00.000Z",
      reportedDetails: {
        kind: "message",
        messageUrl: draft.messageUrl,
        reportReason: "Distinct explanation.",
        context: "Distinct final report."
      },
      timeline: [],
      ...overrides
    };
  }

  function writerResult(reportReason = "Distinct explanation.") {
    return {
      country: "DE",
      legalResearch: {
        country: "DE",
        lawReference: "Germany's Basic Law (Grundgesetz), Article 1",
        summary: "Relevant law summary.",
        sources: [],
        researchedAt: "2026-08-09T00:00:00.000Z",
        searchRequests: 0
      },
      report: "Distinct final report.",
      reportReason,
      reportType: "sub_other_hate_speech",
      conversation: []
    };
  }

  function config(): BotConfig {
    return {
      dataEncryptionKey: encryptionKey,
      keyPepper: "test-key-pepper"
    } as BotConfig;
  }

  it("runs no more than two item pipelines concurrently", async () => {
    let active = 0;
    let peak = 0;

    await runWithConcurrency([1, 2, 3, 4, 5], 2, async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
    });

    expect(peak).toBe(2);
  });

  it("keeps all ten variants in the seed category with unique create identities", async () => {
    const items = Array.from({ length: 10 }, (_, index) =>
      workItem({
        id: `item-${index + 1}`,
        ordinal: index + 1,
        report_type: index === 0 ? null : "sub_other_hate_speech",
        shared_report_type: index === 0 ? null : "sub_other_hate_speech"
      })
    );
    const chunks = [items.slice(0, 1), ...Array.from({ length: 5 }, (_, index) =>
      items.slice(index * 2 + 1, index * 2 + 3)
    )];
    const claimExperimentalBatchItems = vi.fn(() =>
      Promise.resolve(chunks.shift() ?? [])
    );
    const prepareExperimentalBatchItem = vi.fn(
      (input: { itemId: string }) => {
        const ordinal = Number(input.itemId.slice("item-".length));
        return Promise.resolve({
          trackingId: `tracking-${ordinal}`,
          interactionIdentity: `experimental:batch-1:${ordinal}`
        });
      }
    );
    const seenTypes: Array<string | undefined> = [];
    const generate = vi.fn((inputDraft: ReportDraft) => {
      seenTypes.push(inputDraft.reportType);
      return Promise.resolve(writerResult(`Distinct explanation ${inputDraft.experimentalVariation?.ordinal}.`));
    });
    const createdIdentities: string[] = [];
    const createReport = vi.fn((identity: string) => {
      createdIdentities.push(identity);
      return Promise.resolve(report());
    });
    const database = {
      claimExperimentalBatchItems,
      experimentalBatchView: vi.fn().mockResolvedValue([]),
      markExperimentalPreparationAttempt: vi.fn().mockResolvedValue(1),
      acceptedExperimentalReasons: vi.fn().mockResolvedValue([]),
      prepareExperimentalBatchItem,
      markExperimentalCreateAttempt: vi.fn().mockResolvedValue(1),
      markExperimentalSubmissionCreated: vi.fn().mockResolvedValue(undefined)
    } as unknown as BotDatabase;
    const worker = new ExperimentalBatchWorker(
      database,
      { createReport } as unknown as DsaApi,
      {} as Client,
      config(),
      { generate } as unknown as ReportWriter
    );

    for (let index = 0; index < 6; index += 1) await worker.tick();

    expect(generate).toHaveBeenCalledTimes(10);
    expect(seenTypes[0]).toBeUndefined();
    expect(seenTypes.slice(1)).toEqual(Array(9).fill("sub_other_hate_speech"));
    expect(new Set(createdIdentities).size).toBe(10);
  });

  it("retries AI preparation once and then creates the report", async () => {
    const item = workItem();
    const claimExperimentalBatchItems = vi
      .fn()
      .mockResolvedValueOnce([item])
      .mockResolvedValueOnce([item]);
    const rescheduleExperimentalBatchItem = vi.fn().mockResolvedValue(undefined);
    const failExperimentalBatchItem = vi.fn().mockResolvedValue(undefined);
    const prepareExperimentalBatchItem = vi.fn().mockResolvedValue({
      trackingId: "tracking-id",
      interactionIdentity: "experimental:batch-1:1"
    });
    const database = {
      claimExperimentalBatchItems,
      experimentalBatchView: vi.fn().mockResolvedValue([]),
      markExperimentalPreparationAttempt: vi
        .fn()
        .mockResolvedValueOnce(1)
        .mockResolvedValueOnce(2),
      acceptedExperimentalReasons: vi.fn().mockResolvedValue([]),
      rescheduleExperimentalBatchItem,
      failExperimentalBatchItem,
      prepareExperimentalBatchItem,
      markExperimentalCreateAttempt: vi.fn().mockResolvedValue(1),
      markExperimentalSubmissionCreated: vi.fn().mockResolvedValue(undefined)
    } as unknown as BotDatabase;
    const generate = vi
      .fn()
      .mockRejectedValueOnce(new Error("temporary writer failure"))
      .mockResolvedValueOnce(writerResult());
    const createReport = vi.fn().mockResolvedValue(report());
    const worker = new ExperimentalBatchWorker(
      database,
      { createReport } as unknown as DsaApi,
      {} as Client,
      config(),
      { generate } as unknown as ReportWriter
    );

    await worker.tick();
    await worker.tick();

    expect(generate).toHaveBeenCalledTimes(2);
    expect(rescheduleExperimentalBatchItem).toHaveBeenCalledWith(
      "item-1",
      "queued",
      15,
      "ai_preparation_failed"
    );
    expect(failExperimentalBatchItem).not.toHaveBeenCalled();
    expect(prepareExperimentalBatchItem).toHaveBeenCalledOnce();
    expect(createReport).toHaveBeenCalledOnce();
  });

  it("releases an item after its second AI preparation failure", async () => {
    const item = workItem({ preparation_attempts: 1 });
    const failExperimentalBatchItem = vi.fn().mockResolvedValue(undefined);
    const rescheduleExperimentalBatchItem = vi.fn().mockResolvedValue(undefined);
    const database = {
      claimExperimentalBatchItems: vi.fn().mockResolvedValue([item]),
      experimentalBatchView: vi.fn().mockResolvedValue([]),
      markExperimentalPreparationAttempt: vi.fn().mockResolvedValue(2),
      acceptedExperimentalReasons: vi.fn().mockResolvedValue([]),
      rescheduleExperimentalBatchItem,
      failExperimentalBatchItem
    } as unknown as BotDatabase;
    const worker = new ExperimentalBatchWorker(
      database,
      {} as DsaApi,
      {} as Client,
      config(),
      {
        generate: vi.fn().mockRejectedValue(new Error("writer failed again"))
      } as unknown as ReportWriter
    );

    await worker.tick();

    expect(failExperimentalBatchItem).toHaveBeenCalledWith(
      "item-1",
      "ai_preparation_failed"
    );
    expect(rescheduleExperimentalBatchItem).not.toHaveBeenCalled();
  });

  it("edits one saved aggregate DM instead of sending per-item messages", async () => {
    type AggregatePayload = {
      embeds: Array<{
        toJSON(): {
          description?: string;
          fields?: Array<{ value: string }>;
        };
      }>;
    };
    const messageSnapshot: MessageSnapshot = {
      messageId: "message-1",
      channelId: "channel-1",
      channelName: "general",
      serverId: "server-1",
      serverName: "Example",
      authorId: "author-1",
      authorUsername: "author",
      authorDisplayName: "Author",
      authorBot: false,
      content: "Original targeted content",
      createdAt: "2026-08-09T00:00:00.000Z",
      attachments: [],
      embeds: []
    };
    const item = workItem({
      preparation_attempts: 1,
      encrypted_draft: encryptJson({ ...draft, messageSnapshot }, encryptionKey)
    });
    const savedRow = {
      ...item,
      state: "submitted" as const,
      status_dm_message_id: "dm-1",
      last_status: "submitted" as const,
      last_discord_status: "actioned" as const,
      last_review_status: "approved" as const
    };
    let sentEmbed: ReturnType<AggregatePayload["embeds"][number]["toJSON"]> | undefined;
    let editedEmbed: ReturnType<AggregatePayload["embeds"][number]["toJSON"]> | undefined;
    const edit = vi.fn((payload: AggregatePayload) => {
      editedEmbed = payload.embeds[0]?.toJSON();
      return Promise.resolve(undefined);
    });
    const message = {
      id: "dm-1",
      edit
    };
    const send = vi.fn((payload: AggregatePayload) => {
      sentEmbed = payload.embeds[0]?.toJSON();
      return Promise.resolve(message);
    });
    const fetchMessage = vi.fn().mockResolvedValue(message);
    const database = {
      claimExperimentalBatchItems: vi.fn().mockResolvedValue([item]),
      experimentalBatchView: vi
        .fn()
        .mockResolvedValueOnce([item])
        .mockResolvedValueOnce([savedRow]),
      saveExperimentalBatchDm: vi.fn().mockResolvedValue(undefined),
      markExperimentalBatchDmBlocked: vi.fn().mockResolvedValue(undefined),
      markExperimentalPreparationAttempt: vi.fn().mockResolvedValue(2),
      acceptedExperimentalReasons: vi.fn().mockResolvedValue([]),
      failExperimentalBatchItem: vi.fn().mockResolvedValue(undefined)
    } as unknown as BotDatabase;
    const client = {
      users: {
        fetch: vi.fn().mockResolvedValue({
          send,
          createDM: vi.fn().mockResolvedValue({ messages: { fetch: fetchMessage } })
        })
      }
    } as unknown as Client;
    const worker = new ExperimentalBatchWorker(
      database,
      {} as DsaApi,
      client,
      config(),
      { generate: vi.fn().mockRejectedValue(new Error("writer failed")) } as unknown as ReportWriter
    );

    await worker.tick();

    expect(send).toHaveBeenCalledOnce();
    expect(fetchMessage).toHaveBeenCalledWith("dm-1");
    expect(edit).toHaveBeenCalledOnce();
    expect(sentEmbed?.description).toContain("Original targeted content");
    expect(editedEmbed?.description).toContain("Original targeted content");
    expect(editedEmbed?.fields?.[0]?.value).toContain("Appeal accepted");
  });

  it("releases a definite create rejection", async () => {
    const request = {
      flow: "message_urf" as const,
      country: "DE",
      reportType: "sub_other_hate_speech",
      reportReason: "Distinct explanation.",
      context: "Distinct final report.",
      submitterDiscordUserId: "1197857362942378017",
      messageUrl: draft.messageUrl
    };
    const item = workItem({
      state: "creating",
      tracking_id: "tracking-id",
      encrypted_request: encryptJson(request, encryptionKey)
    });
    const failExperimentalBatchItem = vi.fn().mockResolvedValue(undefined);
    const rescheduleExperimentalBatchItem = vi.fn().mockResolvedValue(undefined);
    const database = {
      claimExperimentalBatchItems: vi.fn().mockResolvedValue([item]),
      experimentalBatchView: vi.fn().mockResolvedValue([]),
      markExperimentalCreateAttempt: vi.fn().mockResolvedValue(1),
      failExperimentalBatchItem,
      rescheduleExperimentalBatchItem
    } as unknown as BotDatabase;
    const worker = new ExperimentalBatchWorker(
      database,
      {
        createReport: vi.fn().mockRejectedValue(
          new DsaApiError(400, "invalid_request", "Rejected")
        )
      } as unknown as DsaApi,
      {} as Client,
      config(),
      {} as ReportWriter
    );

    await worker.tick();

    expect(failExperimentalBatchItem).toHaveBeenCalledWith(
      "item-1",
      "api_create_invalid_request"
    );
    expect(rescheduleExperimentalBatchItem).not.toHaveBeenCalled();
  });

  it("reconciles an ambiguous create with the same stable identity", async () => {
    const request = {
      flow: "message_urf" as const,
      country: "DE",
      reportType: "sub_other_hate_speech",
      reportReason: "Distinct explanation.",
      context: "Distinct final report.",
      submitterDiscordUserId: "1197857362942378017",
      messageUrl: draft.messageUrl
    };
    const item = workItem({
      state: "creating",
      tracking_id: "tracking-id",
      encrypted_request: encryptJson(request, encryptionKey)
    });
    const createReport = vi.fn().mockRejectedValue(new Error("connection lost"));
    const rescheduleExperimentalBatchItem = vi.fn().mockResolvedValue(undefined);
    const database = {
      claimExperimentalBatchItems: vi.fn().mockResolvedValue([item]),
      experimentalBatchView: vi.fn().mockResolvedValue([]),
      markExperimentalCreateAttempt: vi.fn().mockResolvedValue(1),
      rescheduleExperimentalBatchItem
    } as unknown as BotDatabase;
    const worker = new ExperimentalBatchWorker(
      database,
      { createReport } as unknown as DsaApi,
      {} as Client,
      config(),
      {} as ReportWriter
    );

    await worker.tick();

    expect(createReport).toHaveBeenCalledWith(
      "experimental:batch-1:1",
      request
    );
    expect(rescheduleExperimentalBatchItem).toHaveBeenCalledWith(
      "item-1",
      "reconciling",
      60,
      "api_create_ambiguous"
    );
  });

  it("retries one API-declared retryable lifecycle failure without another credit", async () => {
    const item = workItem({
      state: "observing",
      tracking_id: "tracking-id",
      current_report_id: "report-1",
      original_report_id: "report-1",
      encrypted_request: encryptJson(
        {
          flow: "message_urf",
          country: "DE",
          reportType: "sub_other_hate_speech",
          reportReason: "Distinct explanation.",
          context: "Distinct final report.",
          submitterDiscordUserId: "1197857362942378017",
          messageUrl: draft.messageUrl
        },
        encryptionKey
      )
    });
    const retryReport = vi.fn().mockResolvedValue(
      report({
        internalReportId: "report-2",
        retryOfReportId: "report-1"
      })
    );
    const trackExperimentalRetryReport = vi.fn().mockResolvedValue("tracking-2");
    const database = {
      claimExperimentalBatchItems: vi
        .fn()
        .mockResolvedValueOnce([item])
        .mockResolvedValueOnce([]),
      experimentalBatchView: vi.fn().mockResolvedValue([]),
      observeExperimentalBatchItem: vi
        .fn()
        .mockResolvedValue({ state: "retrying", delaySeconds: 0 }),
      trackExperimentalRetryReport
    } as unknown as BotDatabase;
    const api = {
      report: vi.fn().mockResolvedValue(
        report({
          status: "failed",
          retryable: true,
          error: { code: "verification_email_timeout", message: "Timed out." }
        })
      ),
      retryReport
    } as unknown as DsaApi;
    const worker = new ExperimentalBatchWorker(
      database,
      api,
      {} as Client,
      config(),
      {} as ReportWriter
    );

    await worker.tick();
    await worker.tick();

    expect(retryReport).toHaveBeenCalledOnce();
    expect(trackExperimentalRetryReport).toHaveBeenCalledOnce();
  });

  it("does not retry an ambiguous final submission", async () => {
    const item = workItem({
      state: "observing",
      tracking_id: "tracking-id",
      current_report_id: "report-1"
    });
    const retryReport = vi.fn();
    const database = {
      claimExperimentalBatchItems: vi.fn().mockResolvedValue([item]),
      experimentalBatchView: vi.fn().mockResolvedValue([]),
      observeExperimentalBatchItem: vi
        .fn()
        .mockResolvedValue({ state: "failed", delaySeconds: null })
    } as unknown as BotDatabase;
    const worker = new ExperimentalBatchWorker(
      database,
      {
        report: vi.fn().mockResolvedValue(
          report({
            status: "failed",
            retryable: false,
            error: {
              code: "ambiguous_submission_state",
              message: "Unknown final state."
            }
          })
        ),
        retryReport
      } as unknown as DsaApi,
      {} as Client,
      config(),
      {} as ReportWriter
    );

    await worker.tick();

    expect(retryReport).not.toHaveBeenCalled();
  });
});
