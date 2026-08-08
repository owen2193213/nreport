import type { ReportDetail } from "@discord-dsa/contracts";
import { USER_MESSAGE_REPORT_REASONS } from "@discord-dsa/contracts";
import type { Pool } from "pg";
import { describe, expect, it } from "vitest";

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
import { experimentalBatchEmbed } from "../src/experimental-batch-ui.js";

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

  public connect = async () => ({
    query: async (sql: string, values: unknown[] = []) => {
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

  public connect = async () => ({
    query: async (sql: string, values: unknown[] = []) => {
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

  public connect = async () => ({
    query: async (sql: string, values: unknown[] = []) => {
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

describe("experimental report batch aggregate card", () => {
  it("fits every current message category in one Discord embed", () => {
    const embed = experimentalBatchEmbed({
      mode: "all_categories",
      itemCount: 18,
      items: USER_MESSAGE_REPORT_REASONS.map((reason, index) => ({
        ordinal: index + 1,
        categoryLabel: reason.label,
        state: "submitted",
        reportReason: "A".repeat(512),
        originalReportId: `original-report-${index + 1}`,
        currentReportId: `current-report-${index + 1}`,
        successorReportId: null,
        safeErrorCode: null
      }))
    }).toJSON();

    expect(embed.fields).toHaveLength(18);
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
