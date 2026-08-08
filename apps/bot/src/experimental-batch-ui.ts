import { Colors, EmbedBuilder } from "discord.js";
import type {
  DiscordReportStatus,
  DiscordReviewStatus,
  ReportStatus
} from "@discord-dsa/contracts";

import type {
  ExperimentalBatchItemState,
  ExperimentalBatchMode,
  MessageSnapshot
} from "./types.js";

export interface ExperimentalOutcomeInput {
  state: ExperimentalBatchItemState;
  lastStatus: ReportStatus | null;
  lastDiscordStatus: DiscordReportStatus | null;
  lastReviewStatus: DiscordReviewStatus | null;
}

export interface ExperimentalBatchDisplayItem extends ExperimentalOutcomeInput {
  ordinal: number;
  categoryLabel: string;
  reportReason: string | null;
  originalReportId: string | null;
  currentReportId: string | null;
  successorReportId: string | null;
  safeErrorCode: string | null;
}

export interface ExperimentalBatchDisplayView {
  mode: ExperimentalBatchMode;
  itemCount: number;
  reportedMessage: string | null;
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

const STATUS_LABELS: Record<ReportStatus, string> = {
  queued: "Report queued",
  requesting_verification: "Requesting verification",
  awaiting_verification: "Awaiting verification",
  verification_received: "Verification received",
  verifying: "Verifying report",
  submitting: "Submitting report",
  submitted: "Submitted — awaiting confirmation",
  failed: "Failed"
};

const DISCORD_STATUS_LABELS: Record<DiscordReportStatus, string> = {
  received: "Report received — awaiting decision",
  actioned: "Report accepted",
  closed_no_action: "Report closed without action",
  review_not_approved: "Appeal denied"
};

const REVIEW_STATUS_LABELS: Record<DiscordReviewStatus, string> = {
  queued: "Appeal preparing",
  requested: "Appeal submitted — awaiting confirmation",
  received: "Appeal received — awaiting decision",
  confirmation_timeout: "Appeal submitted — confirmation not received",
  request_failed: "Appeal failed",
  ineligible: "Appeal unavailable",
  request_ambiguous: "Appeal uncertain",
  approved: "Appeal accepted",
  not_approved: "Appeal denied"
};

function truncate(value: string, maximum: number): string {
  return value.length <= maximum ? value : `${value.slice(0, maximum - 1)}…`;
}

function shortId(value: string | null): string {
  if (!value) return "Not assigned";
  return value.length <= 22 ? value : `${value.slice(0, 8)}…${value.slice(-6)}`;
}

export function experimentalLatestOutcome(item: ExperimentalOutcomeInput): string {
  if (item.lastReviewStatus) return REVIEW_STATUS_LABELS[item.lastReviewStatus];
  if (item.lastDiscordStatus) return DISCORD_STATUS_LABELS[item.lastDiscordStatus];
  if (item.lastStatus) return STATUS_LABELS[item.lastStatus];
  return STATE_LABELS[item.state];
}

export function experimentalReportedMessage(snapshot: MessageSnapshot): string {
  const content = snapshot.content.replace(/\r\n?/g, "\n").trim();
  if (content) return truncate(content, 500);
  const attachmentLabel = snapshot.attachments.length === 1 ? "attachment" : "attachments";
  const embedLabel = snapshot.embeds.length === 1 ? "embed" : "embeds";
  return `No text content · ${snapshot.attachments.length} ${attachmentLabel} · ${snapshot.embeds.length} ${embedLabel}`;
}

function itemValue(item: ExperimentalBatchDisplayItem): string {
  const references = item.successorReportId
    ? `Original: \`${shortId(item.originalReportId)}\` · Retry: \`${shortId(item.successorReportId)}\``
    : `Report: \`${shortId(item.currentReportId ?? item.originalReportId)}\``;
  return truncate(
    [
      `Latest: **${experimentalLatestOutcome(item)}**`,
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
      `${modeLabel}\nSubmitted: **${submitted}** · Failed: **${failed}** · Active: **${active}**${
        view.reportedMessage
          ? `\n\n**Reported message**\n${truncate(view.reportedMessage, 500)}`
          : ""
      }`
    );
  for (const item of view.items.slice(0, 25)) {
    embed.addFields({
      name: truncate(`${item.ordinal}. ${item.categoryLabel}`, 256),
      value: itemValue(item)
    });
  }
  return embed;
}
