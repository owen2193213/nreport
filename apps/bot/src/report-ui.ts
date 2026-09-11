import { createHash } from "node:crypto";

import {
  GUILD_ELEMENT_LABELS,
  GUILD_ELEMENTS,
  PROFILE_ELEMENT_LABELS,
  PROFILE_ELEMENTS,
  reportReasonLabel,
  reportReasons,
  type GuildElement,
  type ReportDetail,
  type ReportFlow,
  type UserProfileElement
} from "@nreport/contracts";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  LabelBuilder,
  MessageFlags,
  ModalBuilder,
  RadioGroupBuilder,
  RadioGroupOptionBuilder,
  SectionBuilder,
  SeparatorBuilder,
  SeparatorSpacingSize,
  StringSelectMenuBuilder,
  TextDisplayBuilder,
  TextInputBuilder,
  TextInputStyle,
  ThumbnailBuilder
} from "discord.js";

export interface TargetDisplayContext {
  flow: ReportFlow;
  name: string;
  handle?: string;
  imageUrl?: string;
  kind: string;
  excerpt?: string;
  metadata: Array<[label: string, value: string]>;
}

export type ReportViewKey =
  | "preparing" | "submitting" | "submitted" | "failed"
  | "report_denied" | "appeal_denied" | "report_accepted" | "appeal_accepted"
  | "report_timeout" | "appeal_timeout" | "ineligible";

export interface ReportViewState {
  key: ReportViewKey;
  title: string;
  description: string;
  mark: string;
  terminal: boolean;
}

export function shouldSendDecisionDm(
  eventType: string,
  viewKey: ReportViewKey,
  preferences: { decisionEnabled: boolean; reportDeniedEnabled: boolean; problemEnabled: boolean }
): boolean {
  if (viewKey === "report_denied") return eventType === "discord:closed_no_action" && preferences.reportDeniedEnabled;
  if (viewKey === "report_accepted" || viewKey === "appeal_accepted") return eventType === "discord:actioned" && preferences.decisionEnabled;
  if (viewKey === "appeal_denied") return eventType === "discord:review_not_approved" && preferences.decisionEnabled;
  if (viewKey === "report_timeout") return eventType === "report_receipt_timeout" && preferences.problemEnabled;
  if (viewKey === "appeal_timeout") return eventType === "review_confirmation_timeout" && preferences.problemEnabled;
  if (viewKey === "ineligible") return eventType === "review_ineligible" && preferences.problemEnabled;
  return viewKey === "failed" && eventType === "report_failed" && preferences.problemEnabled;
}

export interface ReportModalValues {
  mode: "ai" | "manual";
  country: string;
  categories: readonly string[];
  details: string;
  profileElements?: readonly string[];
  guildElements?: readonly string[];
}

export type ParsedReportModalValues = {
  useAi: boolean;
  country?: string;
  category?: string;
  description?: string;
  finalText?: string;
  profileElements?: UserProfileElement[];
  guildElements?: GuildElement[];
};

export function parseReportModalValues(flow: ReportFlow, values: ReportModalValues, countries: readonly string[]): ParsedReportModalValues {
  const country = values.country.trim().toUpperCase();
  const category = values.categories[0];
  const details = values.details.trim();
  if (country && !countries.includes(country)) throw new Error("Choose a supported country code.");
  if (category && !reportReasons(flow).some((reason) => reason.value === category)) throw new Error("Choose a report category from the list.");
  const profileElements = flow === "profile" ? validateElements(values.profileElements, PROFILE_ELEMENTS, "profile") : undefined;
  const guildElements = flow === "server" ? validateElements(values.guildElements, GUILD_ELEMENTS, "server") : undefined;
  if (values.mode === "manual" && (!country || !category || !details)) throw new Error("Country, category, and final report text are required in manual mode.");
  return {
    useAi: values.mode === "ai",
    ...(country ? { country } : {}),
    ...(category ? { category } : {}),
    ...(details ? (values.mode === "ai" ? { description: details } : { finalText: details, description: details }) : {}),
    ...(profileElements ? { profileElements } : {}),
    ...(guildElements ? { guildElements } : {})
  };
}

function validateElements<T extends string>(values: readonly string[] | undefined, allowed: readonly T[], label: string): T[] {
  if (!values || values.length === 0 || values.some((value) => !allowed.includes(value as T))) throw new Error(`Choose at least one valid ${label} element.`);
  return values as T[];
}

const PREPARING = new Set(["planning", "researching", "writing"]);

export function classifyReportView(report: ReportDetail): ReportViewState {
  if (report.reviewStatus === "confirmation_timeout") return state("appeal_timeout", "Appeal unconfirmed", "Discord did not confirm the appeal within 2 minutes. It will not be retried automatically.", "No retry", true);
  if (report.reviewStatus === "ineligible") return state("ineligible", "Appeal unavailable", "Discord marked this report as ineligible for appeal. No resend or appeal retry is available.", "Closed", true);
  if (report.discordStatus === "review_not_approved" || report.reviewStatus === "not_approved") return state("appeal_denied", "Appeal denied", "Discord did not approve the automatic appeal. You can create a replacement report.", "Action available", true);
  if (report.discordStatus === "actioned") {
    const appealed = report.reviewStatus === "approved" || report.timeline.some((event) => event.type === "review_requested");
    return appealed
      ? state("appeal_accepted", "Appeal accepted", "Discord accepted the appeal and took action.", "Accepted", true)
      : state("report_accepted", "Report accepted", "Discord accepted the original report and took action.", "Accepted", true);
  }
  if (report.discordStatus === "closed_no_action") {
    if (report.reviewStatus === "requested" || report.reviewStatus === "received") {
      return state("report_denied", "Appeal submitted", "The original report was denied. The automatic appeal was submitted and is awaiting Discord's decision.", "Awaiting Discord's decision", false);
    }
    if (report.reviewStatus === "queued") {
      return state("report_denied", "Preparing appeal", "The original report was denied. The automatic appeal is queued but has not been submitted yet.", "Not submitted yet", false);
    }
    return state("report_denied", "Report denied", "Discord closed the original report without action. The appeal has not been submitted.", "Appeal not submitted", false);
  }
  if (report.failure?.code === "discord_receipt_timeout") return state("report_timeout", "Report unconfirmed", "Discord did not confirm the report within 2 minutes. The message may have been deleted or become inaccessible, so it will not be retried.", "No retry", true);
  if (report.status === "failed") return state("failed", "Report failed", report.failure?.message ?? "The report stopped before Discord confirmed submission.", "Needs attention", true);
  if (report.status === "queued") return state("preparing", "Queued for Discord submission", "The report is waiting for processing.", "Queued", false);
  if (PREPARING.has(report.status)) return state("preparing", "Preparing report", "Reviewing the evidence and writing the report.", "In progress", false);
  if (report.status === "requesting_verification") return state("submitting", "Requesting verification from Discord", "Starting Discord's verification step.", "In progress", false);
  if (report.status === "awaiting_verification") return state("submitting", "Waiting for Discord verification email", "Discord has been asked to send the verification email.", "In progress", false);
  if (["verification_received", "verifying", "submitting"].includes(report.status)) return state("submitting", "Submitting report to Discord", "Completing verification and sending the report to Discord.", "In progress", false);
  return state("submitted", "Report submitted", "Discord received the report. Waiting for its decision.", "Submitted", false);
}

function state(key: ReportViewKey, title: string, description: string, mark: string, terminal: boolean): ReportViewState {
  return { key, title, description, mark, terminal };
}

export function statusMessageOptions(report: ReportDetail, context: TargetDisplayContext) {
  return {
    flags: MessageFlags.IsComponentsV2 as const,
    components: [buildStatusCard(report, context)],
    allowedMentions: { parse: [] as const }
  };
}

export function visibleStatusHash(report: ReportDetail, context: TargetDisplayContext): string {
  return createHash("sha256").update(JSON.stringify(statusMessageOptions(report, context))).digest("hex");
}

export function buildStatusCard(report: ReportDetail, context: TargetDisplayContext): ContainerBuilder {
  const view = classifyReportView(report);
  const container = new ContainerBuilder()
    .setAccentColor(accent(view.key))
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(`## ${view.title}\n${view.description}\n**${view.mark}**`))
    .addSeparatorComponents(separator())
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(`### ${targetHeading(context.flow)}`));

  const userId = context.metadata.find(([label]) => label === "User ID")?.[1];
  const messageUrl = context.metadata.find(([label]) => label === "Message")?.[1];
  const identity = new TextDisplayBuilder().setContent(context.flow === "message"
    ? `${userId ? `<@${safe(userId)}>` : `**${safe(context.name)}**`}${context.handle ? ` (${safe(context.handle)})` : ""}${validHttpsUrl(messageUrl) ? `\n${messageUrl}` : ""}${context.excerpt ? `\n${reportCodeBlock(context.excerpt)}` : ""}`
    : `**${safe(context.name)}**${context.handle ? `\n${safe(context.handle)}` : ""}\n${safe(context.kind)}`);
  if (validHttpsUrl(context.imageUrl)) {
    container.addSectionComponents(new SectionBuilder().addTextDisplayComponents(identity).setThumbnailAccessory(new ThumbnailBuilder().setURL(context.imageUrl!)));
  } else {
    container.addTextDisplayComponents(identity);
  }
  if (context.flow !== "message" && context.excerpt) container.addTextDisplayComponents(new TextDisplayBuilder().setContent(`> ${safe(context.excerpt)}`));
  const preparationLog = aiPreparationLog(report);
  if (preparationLog !== null) {
    container.addSeparatorComponents(separator()).addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`### AI preparation\n${preparationLog.join("\n")}`)
    );
  }
  const visibleMetadata = context.flow === "message"
    ? context.metadata.filter(([label]) => !["Location", "Posted", "Attachments", "User ID", "Message"].includes(label))
    : context.metadata;
  if (visibleMetadata.length > 0) {
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(visibleMetadata.map(([label, value]) => `**${safe(label)}:** ${safe(value)}`).join("\n")));
  }
  if (report.status === "queued") container.addTextDisplayComponents(new TextDisplayBuilder().setContent(`Queue length: **${report.queueLength ?? 0}**`));
  container.addTextDisplayComponents(new TextDisplayBuilder().setContent(`Report ID: \`${safe(report.reportId)}\``));
  if (report.category || report.country) {
    container.addSeparatorComponents(separator()).addTextDisplayComponents(new TextDisplayBuilder().setContent([
      report.category ? `**Category:** ${safe(reportReasonLabel(report.flow, report.category))}` : null,
      report.country ? `**Country:** ${safe(report.country)}` : null,
      `**Report type:** ${report.useAi ? "Written with AI" : "Written manually"}`
    ].filter(Boolean).join("\n")));
  }
  if (report.finalText !== null) {
    container.addSeparatorComponents(separator()).addTextDisplayComponents(new TextDisplayBuilder().setContent(`### Report sent to Discord\n${reportCodeBlock(report.finalText)}`));
  }
  const history = milestoneHistory(report);
  if (history.length > 0) container.addSeparatorComponents(separator()).addTextDisplayComponents(new TextDisplayBuilder().setContent(`### History\n${history.join("\n")}`));
  if (view.key === "appeal_denied" && report.successorReportId === null && report.retryableModes.includes("rewrite_ai") && report.retryableModes.includes("edit_manual")) {
    container.addActionRowComponents(new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`report-rewrite:${report.reportId}`).setLabel("Rewrite with AI").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`report-edit:${report.reportId}`).setLabel("Edit manually").setStyle(ButtonStyle.Secondary)
    ));
  }
  if (view.key === "failed" && report.successorReportId === null) {
    const buttons: ButtonBuilder[] = [];
    if (report.retryableModes.includes("reuse")) buttons.push(new ButtonBuilder().setCustomId(`report-retry-reuse:${report.reportId}`).setLabel("Retry submission").setStyle(ButtonStyle.Primary));
    if (report.retryableModes.includes("regenerate")) buttons.push(new ButtonBuilder().setCustomId(`report-retry-regenerate:${report.reportId}`).setLabel("Retry with fresh report").setStyle(ButtonStyle.Secondary));
    if (buttons.length > 0) container.addActionRowComponents(new ActionRowBuilder<ButtonBuilder>().addComponents(...buttons));
  }
  return container;
}

function aiPreparationLog(report: ReportDetail): string[] | null {
  if (!report.useAi) return null;
  const failedStage = report.failure?.stage ?? "";
  const terminal = report.status !== "queued" && report.status !== "planning" && report.status !== "researching" && report.status !== "writing";
  const researchDone = terminal || report.status === "writing" || (report.status === "failed" && !failedStage.includes("research"));
  const writingDone = terminal && !(report.status === "failed" && failedStage.includes("writing"));
  const analysis = report.status === "queued" || report.status === "planning" ? "⏳ **AI is analyzing the report details**" : "AI analyzed the report details";
  const research = researchDone ? "AI researched applicable laws" : "⏳ **AI is researching applicable laws**";
  const writing = writingDone ? "AI drafted the report" : "⏳ **AI is drafting the report**";
  return [analysis, research, writing];
}

export function decisionMessageOptions(report: ReportDetail, context: TargetDisplayContext) {
  const view = classifyReportView(report);
  const action = view.key === "failed" ? view.description
    : view.key === "appeal_denied" ? "Use the report card to rewrite with AI or edit manually."
    : view.key === "report_denied" ? "The automatic appeal is continuing."
      : view.key === "report_accepted" || view.key === "appeal_accepted" ? "No further action is needed."
        : "Open the report status for details.";
  const target = context.handle ?? context.name;
  const category = report.category ? reportReasonLabel(report.flow, report.category) : "Auto-selected category";
  return {
    flags: MessageFlags.IsComponentsV2 as const,
    components: [new ContainerBuilder().setAccentColor(accent(view.key)).addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`## ${view.title}\n**Target:** ${safe(target)}\n**Category:** ${safe(category)}\n${action}`)
    )],
    allowedMentions: { parse: [] as const }
  };
}

export function buildReportModal(customId: string, flow: ReportFlow, targetLabel: string): ModalBuilder {
  const modal = new ModalBuilder().setCustomId(customId).setTitle(`Report ${targetLabel}`.slice(0, 45));
  modal.addLabelComponents(
    new LabelBuilder().setLabel("How should this report be written?").setDescription("Choose who writes the final report.").setRadioGroupComponent(
      new RadioGroupBuilder().setCustomId("writer-mode").setRequired(true).addOptions(
        new RadioGroupOptionBuilder().setLabel("Use AI").setValue("ai").setDescription("AI chooses blank fields, researches the law, and writes the report.").setDefault(true),
        new RadioGroupOptionBuilder().setLabel("Write it myself").setValue("manual").setDescription("You must provide country, category, and exact final report text.")
      )
    ),
    new LabelBuilder().setLabel("Why are you reporting this?").setDescription("Optional in AI mode; blank means Auto.").setStringSelectMenuComponent(
      new StringSelectMenuBuilder().setCustomId("category").setRequired(false).setMinValues(0).setMaxValues(1)
        .addOptions(reportReasons(flow).map((reason) => ({ label: reason.label, value: reason.value })))
    )
  );
  if (flow === "profile") modal.addLabelComponents(elementLabel("Which profile elements are unlawful?", "profile-elements", PROFILE_ELEMENTS.map((value) => ({ label: PROFILE_ELEMENT_LABELS[value], value }))));
  if (flow === "server") modal.addLabelComponents(elementLabel("Where does the unlawful content appear?", "server-elements", GUILD_ELEMENTS.map((value) => ({ label: GUILD_ELEMENT_LABELS[value], value }))));
  modal.addLabelComponents(
    new LabelBuilder().setLabel("Report details").setDescription("AI: optional evidence or guidance. Manual: exact final report text.").setTextInputComponent(
      new TextInputBuilder().setCustomId("report-details").setStyle(TextInputStyle.Paragraph).setRequired(false).setMaxLength(512).setPlaceholder("Explain what Discord should review")
    ),
    new LabelBuilder().setLabel("Country").setDescription("Optional in AI mode; blank means Auto. Manual mode requires a supported two-letter code.").setTextInputComponent(
      new TextInputBuilder().setCustomId("country").setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(2).setPlaceholder("Auto or e.g. DE")
    )
  );
  return modal;
}

export function buildManualRetryModal(customId: string, report: ReportDetail): ModalBuilder {
  const modal = new ModalBuilder().setCustomId(customId).setTitle("Edit and resubmit report");
  modal.addLabelComponents(
    new LabelBuilder().setLabel("Report category").setDescription("Choose the category that best matches the fixed evidence.").setStringSelectMenuComponent(
      new StringSelectMenuBuilder().setCustomId("category").setRequired(true).setMinValues(1).setMaxValues(1)
        .addOptions(reportReasons(report.flow).map((reason) => ({ label: reason.label, value: reason.value, default: reason.value === report.category })))
    )
  );
  const target = report.target;
  if (report.flow === "profile" && "reportedUsername" in target) {
    modal.addLabelComponents(elementLabel("Which profile elements are unlawful?", "profile-elements", PROFILE_ELEMENTS.map((value) => ({ label: PROFILE_ELEMENT_LABELS[value], value, default: target.profileElements.includes(value) }))));
  }
  if (report.flow === "server" && "guildIdOrInviteCode" in target) {
    modal.addLabelComponents(elementLabel("Where does the unlawful content appear?", "server-elements", GUILD_ELEMENTS.map((value) => ({ label: GUILD_ELEMENT_LABELS[value], value, default: target.guildElements.includes(value) }))));
  }
  modal.addLabelComponents(
    new LabelBuilder().setLabel("Country").setDescription("Choose the supported country whose law this replacement uses.").setTextInputComponent(
      new TextInputBuilder().setCustomId("country").setStyle(TextInputStyle.Short).setRequired(true).setMinLength(2).setMaxLength(2).setValue(report.country ?? "")
    ),
    new LabelBuilder().setLabel("Final report text").setDescription("Complete text sent to Discord. The target and captured evidence stay fixed.").setTextInputComponent(
      new TextInputBuilder().setCustomId("report-details").setStyle(TextInputStyle.Paragraph).setRequired(true).setMinLength(1).setMaxLength(512).setValue(report.finalText ?? "")
    )
  );
  return modal;
}

export function targetContextFromReport(report: ReportDetail): TargetDisplayContext {
  const target = report.target;
  if ("reportedUsername" in target) return {
    flow: "profile",
    name: target.reportedUserSnapshot.globalDisplayName ?? target.reportedUsername,
    handle: `@${target.reportedUsername}`,
    kind: target.reportedUserSnapshot.bot ? "Bot account" : "User account",
    excerpt: target.profileElements.map((element) => PROFILE_ELEMENT_LABELS[element]).join(", "),
    metadata: [["User ID", target.reportedUserId]]
  };
  if ("guildIdOrInviteCode" in target) return {
    flow: "server", name: target.guildIdOrInviteCode, kind: "Discord server",
    excerpt: target.guildElements.map((element) => GUILD_ELEMENT_LABELS[element]).join(", "), metadata: []
  };
  const snapshot = target.messageEvidence?.status === "captured" ? target.messageEvidence.snapshot : undefined;
  return {
    flow: "message",
    name: snapshot?.authorDisplayName ?? snapshot?.authorUsername ?? "Reported message",
    ...(snapshot ? { handle: `@${snapshot.authorUsername}` } : {}),
    kind: snapshot?.authorBot ? "Bot account" : "User account",
    ...(snapshot?.content ? { excerpt: snapshot.content.slice(0, 300) } : {}),
    metadata: snapshot ? [["User ID", snapshot.authorId], ["Message", target.messageUrl]] : [["Message", target.messageUrl]]
  };
}

function elementLabel(label: string, customId: string, options: Array<{ label: string; value: string; default?: boolean }>): LabelBuilder {
  return new LabelBuilder().setLabel(label).setDescription("Select every element Discord should review.").setStringSelectMenuComponent(
    new StringSelectMenuBuilder().setCustomId(customId).setRequired(true).setMinValues(1).setMaxValues(options.length).addOptions(options)
  );
}

function separator(): SeparatorBuilder {
  return new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small);
}

function targetHeading(flow: ReportFlow): string {
  return flow === "message" ? "Reported message" : flow === "profile" ? "Reported profile" : "Reported server";
}

function milestoneHistory(report: ReportDetail): string[] {
  const milestones: Array<{ occurredAt: string; label: string }> = [
    { occurredAt: report.createdAt, label: "Added to submission queue" }
  ];
  const submitted = report.timeline.find((event) => event.type === "report_submitted");
  if (submitted) milestones.push({ occurredAt: submitted.occurredAt, label: "Report submitted" });
  else if (report.status === "submitted" || report.discordStatus !== null) milestones.push({ occurredAt: report.updatedAt, label: "Report submitted" });

  const denied = report.timeline.find((event) => event.type === "discord:closed_no_action");
  const appealSubmitted = report.timeline.find((event) => event.type === "review_requested");
  if (appealSubmitted) {
    milestones.push({ occurredAt: appealSubmitted.occurredAt, label: "Report denied; appeal submitted" });
  } else if (denied) {
    milestones.push({ occurredAt: denied.occurredAt, label: "Report denied" });
  }

  const actioned = lastTimelineEvent(report.timeline, (event) => event.type === "discord:actioned");
  if (actioned) {
    milestones.push({
      occurredAt: actioned.occurredAt,
      label: appealSubmitted || report.reviewStatus === "approved" ? "Appeal accepted" : "Report accepted"
    });
  }
  const appealDenied = lastTimelineEvent(report.timeline, (event) => event.type === "discord:review_not_approved");
  if (appealDenied) milestones.push({ occurredAt: appealDenied.occurredAt, label: "Appeal denied" });

  const view = classifyReportView(report);
  if (view.key === "failed") milestones.push({ occurredAt: report.updatedAt, label: "Report failed" });
  else if (view.key === "report_timeout") milestones.push({ occurredAt: report.updatedAt, label: "Report unconfirmed" });
  else if (view.key === "appeal_timeout") milestones.push({ occurredAt: report.updatedAt, label: "Appeal unconfirmed" });
  else if (view.key === "ineligible") milestones.push({ occurredAt: report.updatedAt, label: "Appeal unavailable" });

  return milestones.map(({ occurredAt, label }) => `- ${discordHistoryTime(occurredAt)} ${label}`);
}

function lastTimelineEvent(
  timeline: ReportDetail["timeline"],
  predicate: (event: ReportDetail["timeline"][number]) => boolean
): ReportDetail["timeline"][number] | undefined {
  for (let index = timeline.length - 1; index >= 0; index -= 1) {
    const event = timeline[index];
    if (event !== undefined && predicate(event)) return event;
  }
  return undefined;
}

function discordHistoryTime(value: string): string {
  const seconds = Math.floor(Date.parse(value) / 1_000);
  return Number.isFinite(seconds) ? `<t:${seconds}:R>` : safe(value);
}

function reportCodeBlock(finalText: string): string {
  return `\`\`\`\n${finalText.replaceAll("```", "``\u200b`")}\n\`\`\``;
}

function safe(value: string): string {
  return value.replaceAll("`", "ˋ").slice(0, 1_000);
}

function validHttpsUrl(value: string | undefined): boolean {
  if (!value) return false;
  try { return new URL(value).protocol === "https:"; }
  catch { return false; }
}

function accent(key: ReportViewKey): number {
  if (key === "report_accepted" || key === "appeal_accepted") return 0x23a559;
  if (key === "report_denied") return 0xf0b232;
  if (["appeal_denied", "report_timeout", "appeal_timeout", "ineligible", "failed"].includes(key)) return 0xda373c;
  return 0x5865f2;
}
