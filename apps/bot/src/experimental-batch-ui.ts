import { Colors, EmbedBuilder } from "discord.js";

import type {
  ExperimentalBatchItemState,
  ExperimentalBatchMode
} from "./types.js";

export interface ExperimentalBatchDisplayItem {
  ordinal: number;
  categoryLabel: string;
  state: ExperimentalBatchItemState;
  reportReason: string | null;
  originalReportId: string | null;
  currentReportId: string | null;
  successorReportId: string | null;
  safeErrorCode: string | null;
}

export interface ExperimentalBatchDisplayView {
  mode: ExperimentalBatchMode;
  itemCount: number;
  items: readonly ExperimentalBatchDisplayItem[];
}

const STATE_LABELS: Record<ExperimentalBatchItemState, string> = {
  blocked: "Waiting for shared category",
  queued: "Queued",
  preparing: "Preparing with AI",
  creating: "Creating report",
  reconciling: "Reconciling creation",
  observing: "Processing",
  retrying: "Retrying once",
  submitted: "Submitted",
  failed: "Failed"
};

function truncate(value: string, maximum: number): string {
  return value.length <= maximum ? value : `${value.slice(0, maximum - 1)}…`;
}

function shortId(value: string | null): string {
  if (!value) return "Not assigned";
  return value.length <= 22 ? value : `${value.slice(0, 8)}…${value.slice(-6)}`;
}

function itemValue(item: ExperimentalBatchDisplayItem): string {
  const references = item.successorReportId
    ? `Original: \`${shortId(item.originalReportId)}\` · Retry: \`${shortId(item.successorReportId)}\``
    : `Report: \`${shortId(item.currentReportId ?? item.originalReportId)}\``;
  return truncate(
    [
      `Status: **${STATE_LABELS[item.state]}**`,
      item.reportReason ? `Reason: ${truncate(item.reportReason, 120)}` : null,
      references,
      item.safeErrorCode ? `Error: \`${truncate(item.safeErrorCode, 80)}\`` : null
    ]
      .filter((value): value is string => value !== null)
      .join("\n"),
    1_024
  );
}

export function experimentalBatchEmbed(view: ExperimentalBatchDisplayView): EmbedBuilder {
  const submitted = view.items.filter((item) => item.state === "submitted").length;
  const failed = view.items.filter((item) => item.state === "failed").length;
  const active = view.items.length - submitted - failed;
  const modeLabel =
    view.mode === "same_category_10x" ? "10 reports · same category" : "One report per category";
  const color = active > 0
    ? Colors.Yellow
    : failed === view.items.length
      ? Colors.Red
      : Colors.Blurple;
  const embed = new EmbedBuilder()
    .setColor(color)
    .setTitle("Experimental report batch")
    .setDescription(
      `${modeLabel}\nSubmitted: **${submitted}** · Failed: **${failed}** · Active: **${active}**`
    );
  for (const item of view.items.slice(0, 25)) {
    embed.addFields({
      name: truncate(`${item.ordinal}. ${item.categoryLabel}`, 256),
      value: itemValue(item)
    });
  }
  return embed;
}
