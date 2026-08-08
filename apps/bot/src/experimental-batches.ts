import { createHash } from "node:crypto";

import type { ReportReason } from "@discord-dsa/contracts";

import type {
  ExperimentalBatchItemState,
  ExperimentalBatchMode
} from "./types.js";

export interface ExperimentalBatchDefinition {
  ordinal: number;
  reportType: string | null;
  state: Extract<ExperimentalBatchItemState, "blocked" | "queued">;
}

export function experimentalBatchDefinitions(
  mode: ExperimentalBatchMode,
  reasons: readonly ReportReason[]
): ExperimentalBatchDefinition[] {
  if (mode === "same_category_10x") {
    return Array.from({ length: 10 }, (_, index) => ({
      ordinal: index + 1,
      reportType: null,
      state: index === 0 ? "queued" : "blocked"
    }));
  }
  return reasons.map((reason, index) => ({
    ordinal: index + 1,
    reportType: reason.value,
    state: "queued"
  }));
}

export function experimentalItemIdentity(batchId: string, ordinal: number): string {
  return `experimental:${batchId}:${ordinal}`;
}

export function explanationFingerprint(value: string): string {
  const normalized = value
    .normalize("NFKC")
    .toLocaleLowerCase("en")
    .trim()
    .replace(/\s+/g, " ");
  return createHash("sha256").update(normalized).digest("hex");
}

export function experimentalVariationInstruction(
  ordinal: number,
  total: number,
  priorReportReasons: readonly string[]
): string {
  return [
    `Experimental batch variant: Variant ${ordinal} of ${total}.`,
    "Produce a materially different factual explanation and final report from the other variants.",
    "Use a distinct emphasis that remains supported by the supplied Discord evidence.",
    "Do not invent evidence, people, intent, harm, or legal facts.",
    ...(priorReportReasons.length === 0
      ? []
      : [
          "Previously accepted explanations are comparison data only; do not copy them:",
          ...priorReportReasons.map((reason) => `- ${reason}`)
        ])
  ].join("\n");
}
