import { USER_MESSAGE_REPORT_REASONS } from "@discord-dsa/contracts";
import { describe, expect, it } from "vitest";

import {
  explanationFingerprint,
  experimentalBatchDefinitions,
  experimentalItemIdentity,
  experimentalVariationInstruction
} from "../src/experimental-batches.js";

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
