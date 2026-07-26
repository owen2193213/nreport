import {
  GUILD_ELEMENT_LABELS,
  GUILD_ELEMENTS,
  PROFILE_ELEMENT_LABELS,
  PROFILE_ELEMENTS,
  reportReasonLabel,
  reportReasons
} from "@discord-dsa/contracts";
import type { CreateReportInput, ReportFlow, ReportView } from "@discord-dsa/contracts";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Colors,
  EmbedBuilder,
  LabelBuilder,
  ModalBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  TextInputBuilder,
  TextInputStyle
} from "discord.js";

import type { AccessKeyView } from "./database.js";
import { countryDisplay } from "./countries.js";
import { reportHasLawReference } from "./report-writer.js";
import type { AccessView, ReportDraft, ServerSnapshot } from "./types.js";

const FLOW_LABELS: Record<ReportFlow, string> = {
  message_urf: "Message",
  user_urf: "Profile",
  guild_urf: "Server"
};

const STATUS_LABELS: Record<string, string> = {
  queued: "Queued",
  requesting_verification: "Requesting verification",
  awaiting_verification: "Awaiting verification",
  verification_received: "Verification received",
  verifying: "Verifying",
  submitting: "Submitting to Discord",
  submitted: "Submitted to Discord",
  failed: "Failed",
  received: "Received by Discord",
  actioned: "Action taken",
  closed_no_action: "Closed — no action",
  review_not_approved: "Review not approved"
};

function statusLabel(status: string | null): string {
  if (status === null) return "Pending Discord review";
  return STATUS_LABELS[status] ?? status.replaceAll("_", " ");
}

function statusColor(report: Pick<ReportView, "status" | "discordStatus">): number {
  if (report.status === "failed" || report.discordStatus === "review_not_approved") return Colors.Red;
  if (report.discordStatus === "actioned") return Colors.Green;
  if (report.discordStatus === "closed_no_action") return Colors.Greyple;
  if (report.status === "submitted" || report.discordStatus === "received") return Colors.Blurple;
  return Colors.Yellow;
}

function discordTimestamp(value: string): string {
  const seconds = Math.floor(new Date(value).getTime() / 1_000);
  return Number.isFinite(seconds) ? `<t:${seconds}:R>` : value;
}

function shortId(value: string): string {
  return value.length <= 18 ? value : `${value.slice(0, 8)}…${value.slice(-6)}`;
}

function labeledElements(flow: ReportFlow, elements: readonly string[]): string[] {
  if (flow === "user_urf") {
    return elements.map(
      (element) => PROFILE_ELEMENT_LABELS[element as keyof typeof PROFILE_ELEMENT_LABELS] ?? element
    );
  }
  if (flow === "guild_urf") {
    return elements.map(
      (element) => GUILD_ELEMENT_LABELS[element as keyof typeof GUILD_ELEMENT_LABELS] ?? element
    );
  }
  return [];
}

function reasonText(flow: ReportFlow, reportType: string, elements: readonly string[]): string {
  const labels = labeledElements(flow, elements);
  return `${reportReasonLabel(flow, reportType)}${labels.length > 0 ? ` — ${labels.join(", ")}` : ""}`;
}

function serverSnapshotText(snapshot: ServerSnapshot | null | undefined): string | null {
  if (!snapshot) return null;
  return [
    `**${snapshot.name}** (\`${snapshot.id}\`)`,
    snapshot.description,
    snapshot.approximateMemberCount === null
      ? null
      : `Members: **${snapshot.approximateMemberCount.toLocaleString("en")}**${
          snapshot.approximatePresenceCount === null
            ? ""
            : ` • Online: **${snapshot.approximatePresenceCount.toLocaleString("en")}**`
        }`
  ]
    .filter((value): value is string => Boolean(value))
    .join("\n");
}

function splitField(value: string, maximum = 1_024): string[] {
  const chunks: string[] = [];
  let remaining = value || "Not provided";
  while (remaining.length > maximum) {
    let boundary = remaining.lastIndexOf("\n", maximum);
    if (boundary < maximum / 2) boundary = maximum;
    chunks.push(remaining.slice(0, boundary));
    remaining = remaining.slice(boundary).replace(/^\n/, "");
  }
  chunks.push(remaining);
  return chunks;
}

export function infoEmbed(title: string, description: string): EmbedBuilder {
  return new EmbedBuilder().setColor(Colors.Blurple).setTitle(title).setDescription(description);
}

export function successEmbed(title: string, description: string): EmbedBuilder {
  return new EmbedBuilder().setColor(Colors.Green).setTitle(title).setDescription(description);
}

export function errorEmbed(description: string): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(Colors.Red)
    .setTitle("Unable to complete that action")
    .setDescription(description.slice(0, 4_000));
}

function textLabel(input: {
  customId: string;
  label: string;
  description?: string;
  required?: boolean;
  style?: TextInputStyle;
  minLength?: number;
  maxLength: number;
  value?: string;
}): LabelBuilder {
  const field = new TextInputBuilder()
    .setCustomId(input.customId)
    .setStyle(input.style ?? TextInputStyle.Short)
    .setRequired(input.required ?? true)
    .setMaxLength(input.maxLength);
  if (input.minLength !== undefined) field.setMinLength(input.minLength);
  if (input.value !== undefined && input.value.length > 0) field.setValue(input.value);
  const label = new LabelBuilder().setLabel(input.label).setTextInputComponent(field);
  if (input.description !== undefined) label.setDescription(input.description);
  return label;
}

function selectLabel(input: {
  customId: string;
  label: string;
  description?: string;
  options: Array<{ label: string; value: string; default?: boolean }>;
  maxValues?: number;
}): LabelBuilder {
  const select = new StringSelectMenuBuilder()
    .setCustomId(input.customId)
    .setRequired(true)
    .setMinValues(1)
    .setMaxValues(input.maxValues ?? 1)
    .addOptions(
      input.options.map((option) => {
        const builder = new StringSelectMenuOptionBuilder()
          .setLabel(option.label)
          .setValue(option.value);
        if (option.default === true) builder.setDefault(true);
        return builder;
      })
    );
  const label = new LabelBuilder().setLabel(input.label).setStringSelectMenuComponent(select);
  if (input.description !== undefined) label.setDescription(input.description);
  return label;
}

export function buildReportModal(draftId: string, draft: ReportDraft): ModalBuilder {
  const modal = new ModalBuilder()
    .setCustomId(`report:modal:${draftId}`)
    .setTitle(`Report ${FLOW_LABELS[draft.flow]}`);
  modal.addLabelComponents(
    selectLabel({
      customId: "report_type",
      label: "Why are you reporting this?",
      options: reportReasons(draft.flow).map((reason) => ({
        label: reason.label,
        value: reason.value,
        default: reason.value === draft.reportType
      }))
    })
  );

  if (draft.flow === "message_urf" && draft.messageUrl === undefined) {
    modal.addLabelComponents(
      textLabel({
        customId: "message_url",
        label: "Discord message link",
        description: "Copy Message Link from Discord",
        maxLength: 300
      })
    );
  }
  if (draft.flow === "user_urf") {
    modal.addLabelComponents(
      selectLabel({
        customId: "profile_elements",
        label: "Which profile elements are unlawful?",
        options: PROFILE_ELEMENTS.map((element) => ({
          label: PROFILE_ELEMENT_LABELS[element],
          value: element,
          default: draft.profileElements?.includes(element) ?? false
        })),
        maxValues: PROFILE_ELEMENTS.length
      })
    );
  }
  if (draft.flow === "guild_urf") {
    if (draft.guildIdOrInviteCode === undefined) {
      modal.addLabelComponents(
        textLabel({
          customId: "guild_target",
          label: "Server ID or invite code",
          maxLength: 100
        })
      );
    }
    modal.addLabelComponents(
      selectLabel({
        customId: "guild_elements",
        label: "Where does the unlawful content appear?",
        options: GUILD_ELEMENTS.map((element) => ({
          label: GUILD_ELEMENT_LABELS[element],
          value: element,
          default: draft.guildElements?.includes(element) ?? false
        })),
        maxValues: GUILD_ELEMENTS.length
      })
    );
  }
  modal.addLabelComponents(
    textLabel({
      customId: "brief",
      label: draft.aiDisabled ? "Final report text" : "Briefly explain the report",
      description: draft.aiDisabled
        ? "AI is disabled. Write the final report in 512 characters or fewer."
        : "A short or vague reason is okay. Grok will draft the final report for review.",
      required: true,
      style: TextInputStyle.Paragraph,
      minLength: 1,
      maxLength: draft.aiDisabled ? 512 : 1_000,
      ...(draft.reportBrief === undefined ? {} : { value: draft.reportBrief })
    })
  );
  return modal;
}

export function buildRefinementModal(draftId: string): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(`writer:refine:${draftId}`)
    .setTitle("Refine AI report")
    .addLabelComponents(
      textLabel({
        customId: "instruction",
        label: "What should Grok change?",
        description: "This continues the existing AI conversation.",
        style: TextInputStyle.Paragraph,
        minLength: 1,
        maxLength: 1_000
      })
    );
}

export function buildManualReportModal(draftId: string, draft: ReportDraft): ModalBuilder {
  const current = (draft.context ?? draft.reportBrief ?? "").slice(0, 512);
  return new ModalBuilder()
    .setCustomId(`writer:edit:${draftId}`)
    .setTitle("Edit report manually")
    .addLabelComponents(
      textLabel({
        customId: "report_text",
        label: "Final report",
        description: "Maximum 512 characters. Keep the researched law or provision in the text.",
        style: TextInputStyle.Paragraph,
        minLength: 1,
        maxLength: 512,
        ...(current ? { value: current } : {})
      })
    );
}

export function buildCountryPicker(
  countries: readonly string[],
  draftId: string,
  page: number,
  allowAuto = true
): { embeds: EmbedBuilder[]; components: ActionRowBuilder<StringSelectMenuBuilder | ButtonBuilder>[] } {
  const pageSize = 24;
  const choices = allowAuto ? ["AUTO", ...countries] : [...countries];
  const pageCount = Math.max(1, Math.ceil(choices.length / pageSize));
  const safePage = Math.min(Math.max(page, 0), pageCount - 1);
  const options = choices.slice(safePage * pageSize, (safePage + 1) * pageSize);
  const picker = new StringSelectMenuBuilder()
    .setCustomId(`country:select:${draftId}:${safePage}`)
    .setPlaceholder("Choose the relevant EU country")
    .addOptions(options.map((country) => ({ label: countryDisplay(country), value: country })))
    .setMinValues(1)
    .setMaxValues(1);
  const components: ActionRowBuilder<StringSelectMenuBuilder | ButtonBuilder>[] = [
    new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(picker)
  ];
  if (pageCount > 1) {
    components.push(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`country:page:${draftId}:${safePage - 1}`)
          .setLabel("Previous")
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(safePage === 0),
        new ButtonBuilder()
          .setCustomId(`country:page:${draftId}:${safePage + 1}`)
          .setLabel("Next")
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(safePage === pageCount - 1)
      )
    );
  }
  return {
    embeds: [
      infoEmbed(
        "Choose the applicable country",
        `${
          allowAuto
            ? "Choose **Auto** to let Grok select a supported country based on legal relevance, or select a country override."
            : "AI is disabled for this report, so select a country manually."
        }\n\nPage **${safePage + 1} of ${pageCount}**`
      )
    ],
    components
  };
}

function profileSnapshotText(snapshot: ReportDraft["reportedUserSnapshot"]): string | null {
  if (!snapshot) return null;
  return [
    snapshot.globalDisplayName ? `**${snapshot.globalDisplayName}**` : null,
    `@${snapshot.username}`,
    `User ID: \`${snapshot.userId}\``,
    snapshot.serverDisplayName ? `Server display name: **${snapshot.serverDisplayName}**` : null,
    snapshot.bot ? "Discord bot account" : null
  ]
    .filter((value): value is string => Boolean(value))
    .join("\n");
}

export function buildProfileTargetConfirmation(
  draftId: string,
  draft: ReportDraft
): { embeds: EmbedBuilder[]; components: ActionRowBuilder<ButtonBuilder>[] } {
  if (draft.flow !== "user_urf" || !draft.profileTargetRaw) {
    throw new Error("Profile target confirmation requires a profile draft.");
  }
  const resolved = profileSnapshotText(draft.reportedUserSnapshot);
  const embed = new EmbedBuilder()
    .setColor(resolved ? Colors.Blurple : Colors.Orange)
    .setTitle(resolved ? "Discord account found" : "User ID lookup was unsuccessful")
    .setDescription(
      resolved
        ? "Review the resolved account before continuing."
        : `Discord could not resolve \`${draft.profileTargetRaw}\`. The account may not exist or Discord may be temporarily unavailable.`
    )
    .addFields(
      resolved
        ? { name: "Resolved account", value: resolved }
        : { name: "Original value", value: `\`${draft.profileTargetRaw}\`` }
    );
  if (draft.reportedUserSnapshot?.avatarUrl) {
    embed.setThumbnail(draft.reportedUserSnapshot.avatarUrl);
  }
  const buttons = new ActionRowBuilder<ButtonBuilder>();
  if (resolved) {
    buttons.addComponents(
      new ButtonBuilder()
        .setCustomId(`profile:continue:${draftId}`)
        .setLabel("Continue")
        .setStyle(ButtonStyle.Danger)
    );
  }
  if (!resolved) {
    buttons.addComponents(
      new ButtonBuilder()
        .setCustomId(`profile:retry:${draftId}`)
        .setLabel("Try Lookup Again")
        .setStyle(ButtonStyle.Secondary)
    );
  }
  buttons.addComponents(
    new ButtonBuilder()
      .setCustomId(`draft:cancel:${draftId}`)
      .setLabel("Cancel")
      .setStyle(ButtonStyle.Secondary)
  );
  return { embeds: [embed], components: [buttons] };
}

function targetSummary(draft: ReportDraft): string {
  switch (draft.flow) {
    case "message_urf":
      return draft.messageUrl ?? "Missing message link";
    case "user_urf":
      return `${profileSnapshotText(draft.reportedUserSnapshot) ?? draft.reportedUsername ?? "Missing username"}${
        draft.reportedUserServerId ? ` in server ${draft.reportedUserServerId}` : ""
      }`;
    case "guild_urf":
      return draft.guildIdOrInviteCode ?? "Missing server ID or invite";
  }
}

function truncate(value: string, maximum: number): string {
  return value.length <= maximum ? value : `${value.slice(0, maximum - 1)}…`;
}

function countryOrigin(draft: ReportDraft): string {
  switch (draft.countrySelection) {
    case "auto":
      return "Auto-selected by Grok";
    case "default":
      return "Saved default";
    case "override":
      return "Report override";
    default:
      return "Report country";
  }
}

export function buildReview(draftId: string, draft: ReportDraft): {
  embeds: EmbedBuilder[];
  components: ActionRowBuilder<ButtonBuilder>[];
} {
  if (
    !draft.country ||
    !draft.reportType ||
    !draft.context ||
    (!draft.aiDisabled && !draft.legalResearch)
  ) {
    throw new Error("Report draft is incomplete.");
  }
  const elements =
    draft.flow === "user_urf"
      ? draft.profileElements ?? []
      : draft.flow === "guild_urf"
        ? draft.guildElements ?? []
        : [];
  const details = [
    draft.flow === "guild_urf" ? serverSnapshotText(draft.serverSnapshot) : null,
    draft.flow === "user_urf" && draft.reportedUserServerId
      ? `Observed in server: \`${draft.reportedUserServerId}\``
      : null,
    draft.context
  ]
    .filter((value): value is string => Boolean(value))
    .join("\n\n");
  const embed = new EmbedBuilder()
    .setColor(Colors.Orange)
    .setTitle(`Review ${FLOW_LABELS[draft.flow].toLowerCase()} report`)
    .setDescription("Submitting creates a real DSA report. Confirm that the information is truthful and authorized.")
    .addFields(
      { name: "Reported thing", value: truncate(targetSummary(draft), 1_000) },
      { name: "Report category", value: FLOW_LABELS[draft.flow], inline: true },
      {
        name: "Country",
        value: `${countryDisplay(draft.country)}\n${countryOrigin(draft)}`,
        inline: true
      },
      { name: "Reason", value: reasonText(draft.flow, draft.reportType, elements) },
      ...splitField(details).map((value, index) => ({
        name: index === 0 ? "Reported details" : `Reported details (${index + 1})`,
        value
      }))
    );
  embed.setFooter({ text: `${draft.context.length}/512 characters • Review carefully before submitting` });
  if (draft.flow === "user_urf" && draft.reportedUserSnapshot?.avatarUrl) {
    embed.setThumbnail(draft.reportedUserSnapshot.avatarUrl);
  } else if (draft.serverSnapshot?.iconUrl) {
    embed.setThumbnail(draft.serverSnapshot.iconUrl);
  }
  const buttons = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`draft:submit:${draftId}`)
      .setLabel("Submit DSA Report")
      .setStyle(ButtonStyle.Danger),
    ...(draft.aiDisabled
      ? []
      : [
          new ButtonBuilder()
            .setCustomId(`draft:refine:${draftId}`)
            .setLabel("Refine")
            .setStyle(ButtonStyle.Primary),
          new ButtonBuilder()
            .setCustomId(`draft:regenerate:${draftId}`)
            .setLabel("Regenerate")
            .setStyle(ButtonStyle.Secondary)
        ]),
    new ButtonBuilder()
      .setCustomId(`draft:edit:${draftId}`)
      .setLabel("Edit manually")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`draft:cancel:${draftId}`)
      .setLabel("Cancel")
      .setStyle(ButtonStyle.Secondary)
  );
  const countryButton = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`draft:country:${draftId}`)
      .setLabel("Change country")
      .setStyle(ButtonStyle.Secondary)
  );
  return { embeds: [embed], components: [buttons, countryButton] };
}

export function buildWriterFailure(
  draftId: string,
  description: string,
  retryAction: "refine" | "regenerate" = "regenerate",
  canManualEdit = false
): {
  embeds: EmbedBuilder[];
  components: ActionRowBuilder<ButtonBuilder>[];
} {
  return {
    embeds: [errorEmbed(description)],
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`draft:${retryAction}:${draftId}`)
          .setLabel("Retry")
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId(`draft:country:${draftId}`)
          .setLabel("Change country")
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId(`draft:brief:${draftId}`)
          .setLabel("Edit details")
          .setStyle(ButtonStyle.Secondary),
        ...(canManualEdit
          ? [
              new ButtonBuilder()
                .setCustomId(`draft:edit:${draftId}`)
                .setLabel("Edit manually")
                .setStyle(ButtonStyle.Secondary)
            ]
          : []),
        new ButtonBuilder()
          .setCustomId(`draft:cancel:${draftId}`)
          .setLabel("Cancel")
          .setStyle(ButtonStyle.Secondary)
      )
    ]
  };
}

export function draftToCreateInput(draft: ReportDraft, userId: string): CreateReportInput {
  if (
    !draft.country ||
    !draft.reportType ||
    !draft.context ||
    (!draft.aiDisabled &&
      (!draft.legalResearch || !reportHasLawReference(draft.context, draft.legalResearch)))
  ) {
    throw new Error("Report draft is incomplete.");
  }
  const common = {
    country: draft.country,
    reportType: draft.reportType,
    submitterDiscordUserId: userId,
    context: draft.context
  };
  switch (draft.flow) {
    case "message_urf":
      if (!draft.messageUrl) throw new Error("A message link is required.");
      return { ...common, flow: draft.flow, messageUrl: draft.messageUrl };
    case "user_urf":
      if (
        !draft.reportedUsername ||
        !draft.reportedUserId ||
        !draft.reportedUserSnapshot ||
        !draft.profileElements?.length
      ) {
        throw new Error("A resolved Discord user and profile element are required.");
      }
      return {
        ...common,
        flow: draft.flow,
        reportedUsername: draft.reportedUsername,
        reportedUserId: draft.reportedUserId,
        reportedUserSnapshot: draft.reportedUserSnapshot,
        profileElements: draft.profileElements,
        ...(draft.reportedUserServerId === undefined
          ? {}
          : { reportedUserServerId: draft.reportedUserServerId })
      };
    case "guild_urf":
      if (!draft.guildIdOrInviteCode || !draft.guildElements?.length) {
        throw new Error("A server target and server element are required.");
      }
      return {
        ...common,
        flow: draft.flow,
        guildIdOrInviteCode: draft.guildIdOrInviteCode,
        guildElements: draft.guildElements
      };
  }
}

export function accessEmbed(access: AccessView, admin: boolean, userId?: string): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setColor(access.suspended ? Colors.Red : Colors.Blurple)
    .setTitle(userId ? "User access" : "Your reporting access")
    .addFields(
      { name: "Access level", value: admin ? "Administrator — unlimited reports" : "Credit-based access", inline: true },
      { name: "Credits", value: admin ? "Unlimited" : access.credits.toString(), inline: true },
      {
        name: "Default country",
        value: access.defaultCountry ? countryDisplay(access.defaultCountry) : countryDisplay("AUTO"),
        inline: true
      },
      { name: "Account status", value: access.suspended ? "Suspended" : "Active", inline: true },
      {
        name: "AI usage",
        value: [
          `Requests: **${access.aiRequestCount.toLocaleString("en")}**`,
          `Input tokens: **${access.aiInputTokens.toLocaleString("en")}**`,
          `Output tokens: **${access.aiOutputTokens.toLocaleString("en")}**`,
          `Reasoning tokens: **${access.aiReasoningTokens.toLocaleString("en")}**`,
          `Web searches: **${access.aiSearchRequests.toLocaleString("en")}**`,
          `OpenRouter cost: **${access.aiCostCredits.toFixed(6)} credits**`
        ].join("\n")
      }
    );
  if (userId) embed.setDescription(`Discord user: \`${userId}\``);
  if (access.suspensionReason) embed.addFields({ name: "Suspension reason", value: access.suspensionReason });
  return embed;
}

function reportElements(report: ReportView): readonly string[] {
  return report.reportedDetails.kind === "profile"
    ? report.reportedDetails.profileElements
    : report.reportedDetails.kind === "server"
      ? report.reportedDetails.guildElements
      : [];
}

function reportTarget(report: ReportView, snapshot?: ServerSnapshot | null): string {
  switch (report.reportedDetails.kind) {
    case "message":
      return report.reportedDetails.messageUrl;
    case "profile":
      return (
        profileSnapshotText(report.reportedDetails.reportedUserSnapshot) ??
        report.reportedDetails.reportedUsername
      );
    case "server":
      return serverSnapshotText(snapshot) ?? report.reportedDetails.guildIdOrInviteCode;
  }
}

function reportDetails(report: ReportView, snapshot?: ServerSnapshot | null): string {
  const details = report.reportedDetails;
  return (
    [
      details.kind === "profile" && details.reportedUserServerId
        ? `Observed in server: \`${details.reportedUserServerId}\``
        : null,
      details.kind === "profile" && details.reportedUserSnapshot
        ? `Name submitted to Discord: \`@${details.reportedUsername}\`\nAccount information captured ${discordTimestamp(details.reportedUserSnapshot.resolvedAt)}`
        : null,
      details.kind === "server" ? serverSnapshotText(snapshot) : null,
      details.context
    ]
      .filter((value): value is string => Boolean(value))
      .join("\n\n") || "No additional context supplied."
  );
}

type HistoryStage = "created" | "retry" | "submitted" | "received" | "outcome" | "failed";

function historyStage(event: ReportView["timeline"][number]): {
  key: HistoryStage;
  label: string;
  icon: string;
} | null {
  if (event.type === "report_created") {
    return { key: "created", label: "Report created", icon: "✅" };
  }
  if (event.type === "report_retry_requested") {
    return { key: "retry", label: "Retry started", icon: "🔄" };
  }
  if (event.type === "report_submitted") {
    return { key: "submitted", label: "Submitted to Discord", icon: "✅" };
  }
  if (event.type === "report_failed") {
    return { key: "failed", label: "Processing failed", icon: "❌" };
  }
  if (event.type !== "discord_status_updated" || !event.discordStatus) return null;
  switch (event.discordStatus) {
    case "received":
      return { key: "received", label: "Received by Discord", icon: "✅" };
    case "actioned":
      return { key: "outcome", label: "Discord took action", icon: "✅" };
    case "closed_no_action":
      return { key: "outcome", label: "Closed without action", icon: "⚪" };
    case "review_not_approved":
      return { key: "outcome", label: "Report not approved", icon: "⚠️" };
  }
}

function pendingHistoryStage(report: ReportView): string | null {
  if (
    report.status === "failed" ||
    report.discordStatus === "actioned" ||
    report.discordStatus === "closed_no_action" ||
    report.discordStatus === "review_not_approved"
  ) {
    return null;
  }
  if (report.status !== "submitted") return "⏳ Preparing and submitting report";
  if (report.discordStatus === null) return "⏳ Waiting for Discord to receive the report";
  return "⏳ Awaiting Discord's decision";
}

export function reportHistory(report: ReportView): string {
  const attempts = new Map<number, Map<HistoryStage, { label: string; icon: string; at: string }>>();
  for (const event of report.timeline) {
    const stage = historyStage(event);
    if (!stage) continue;
    const attempt = event.lifecycleAttempt ?? 1;
    const stages =
      attempts.get(attempt) ??
      new Map<HistoryStage, { label: string; icon: string; at: string }>();
    if (!stages.has(stage.key)) {
      stages.set(stage.key, { label: stage.label, icon: stage.icon, at: event.occurredAt });
    }
    attempts.set(attempt, stages);
  }
  const attemptNumbers = [...attempts.keys()].sort((left, right) => left - right);
  if (!attemptNumbers.includes(report.lifecycleAttempt)) {
    attemptNumbers.push(report.lifecycleAttempt);
    attemptNumbers.sort((left, right) => left - right);
  }
  const showAttemptHeadings = Math.max(report.lifecycleAttempt, ...attemptNumbers) > 1;
  const order: HistoryStage[] = ["created", "retry", "submitted", "received", "outcome", "failed"];
  const lines: string[] = [];
  for (const attempt of attemptNumbers) {
    const stages = attempts.get(attempt);
    if (showAttemptHeadings) lines.push(`**Attempt ${attempt}**`);
    for (const key of order) {
      const stage = stages?.get(key);
      if (stage) lines.push(`${stage.icon} ${stage.label} — ${discordTimestamp(stage.at)}`);
    }
  }
  const pending = pendingHistoryStage(report);
  if (pending) lines.push(pending);
  return lines.join("\n") || "No report history is available yet.";
}

export interface ReportEmbedOptions {
  page?: { current: number; total: number };
  title?: string;
  hideStatusDescription?: boolean;
}

export function reportEmbed(
  report: ReportView,
  snapshot?: ServerSnapshot | null,
  options: ReportEmbedOptions = {}
): EmbedBuilder {
  const currentStatus = report.discordStatus ?? report.status;
  const embed = new EmbedBuilder()
    .setColor(statusColor(report))
    .setTitle(options.title ?? `${FLOW_LABELS[report.flow]} report`)
    .addFields(
      { name: "Reported thing", value: truncate(reportTarget(report, snapshot), 1_024) },
      { name: "Report category", value: FLOW_LABELS[report.flow], inline: true },
      { name: "Country", value: countryDisplay(report.country), inline: true },
      { name: "Reason", value: reasonText(report.flow, report.reportType, reportElements(report)) },
      ...splitField(reportDetails(report, snapshot)).map((value, index) => ({
        name: index === 0 ? "Reported details" : `Reported details (${index + 1})`,
        value
      })),
      {
        name: "References",
        value: `Report: \`${shortId(report.internalReportId)}\`\nDiscord: ${
          report.discordReportId ? `\`${report.discordReportId}\`` : "Not assigned"
        }${
          report.retryOfReportId
            ? `\nPrevious report: \`${shortId(report.retryOfReportId)}\``
            : ""
        }${
          report.retriedAsReportId
            ? `\nRetried as: \`${shortId(report.retriedAsReportId)}\``
            : ""
        }`,
        inline: true
      },
      {
        name: "Dates",
        value: `Created ${discordTimestamp(report.createdAt)}\nUpdated ${discordTimestamp(report.updatedAt)}`,
        inline: true
      }
    );
  if (!options.hideStatusDescription) embed.setDescription(`**${statusLabel(currentStatus)}**`);
  if (report.retrySequence > 0 || report.retryable) {
    embed.addFields({
      name: "Retry",
      value: `Report **${report.retrySequence + 1} of 3**${
        report.retryable ? " • Another retry is available" : ""
      }`
    });
  }
  for (const [index, value] of splitField(reportHistory(report)).entries()) {
    embed.addFields({ name: index === 0 ? "History" : `History (${index + 1})`, value });
  }
  const profileAvatar =
    report.reportedDetails.kind === "profile"
      ? report.reportedDetails.reportedUserSnapshot?.avatarUrl
      : null;
  if (profileAvatar ?? snapshot?.iconUrl) embed.setThumbnail(profileAvatar ?? snapshot!.iconUrl!);
  if (report.error) {
    embed.addFields({
      name: "Latest error",
      value: `${report.error.message ?? report.error.code}\nRetry available: **${report.retryable ? "Yes" : "No"}**`
    });
  }
  embed.setFooter({
    text: options.page
      ? `Report ${options.page.current} of ${options.page.total} • Full ID: ${report.internalReportId}`
      : `Full ID: ${report.internalReportId}`
  });
  return embed;
}

export function reportRetryComponents(
  report: ReportView
): ActionRowBuilder<ButtonBuilder>[] {
  if (!(report.status === "failed" && report.retryable && report.retrySequence < 2)) return [];
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`reports:retry:${report.internalReportId}`)
        .setLabel("Retry as new report")
        .setStyle(ButtonStyle.Primary)
    )
  ];
}

export function reportBrowser(
  report: ReportView,
  snapshot: ServerSnapshot | null | undefined,
  page: number,
  total: number
): { embeds: EmbedBuilder[]; components: ActionRowBuilder<ButtonBuilder>[] } {
  const safePage = Math.min(Math.max(page, 0), total - 1);
  const controls = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`reports:page:${safePage - 1}`).setLabel("Previous").setStyle(ButtonStyle.Secondary).setDisabled(safePage === 0),
    new ButtonBuilder().setCustomId(`reports:page:${safePage + 1}`).setLabel("Next").setStyle(ButtonStyle.Primary).setDisabled(safePage === total - 1)
  );
  const retryControls = reportRetryComponents(report);
  return {
    embeds: [reportEmbed(report, snapshot, { page: { current: safePage + 1, total } })],
    components: [...(total > 1 ? [controls] : []), ...retryControls]
  };
}

export function accessKeysEmbed(keys: readonly AccessKeyView[]): EmbedBuilder {
  const embed = infoEmbed("Access keys", keys.length === 0 ? "No access keys exist." : `Showing the ${keys.length} most recent keys.`);
  for (const key of keys) {
    embed.addFields({
      name: `${key.code_prefix} • ${statusLabel(key.status)}`,
      value: [
        `ID: \`${key.id}\``,
        `Credits granted: **${key.credits_total}** • Expires: ${key.expires_at ? discordTimestamp(key.expires_at.toISOString()) : "Never"}`,
        key.redeemed_by
          ? `Redeemed by: \`${key.redeemed_by}\`${key.redeemed_at ? ` • ${discordTimestamp(key.redeemed_at.toISOString())}` : ""}`
          : "Redeemed by: Nobody"
      ].join("\n"),
      inline: true
    });
  }
  return embed;
}

export function accessKeyEmbed(key: AccessKeyView): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(key.status === "active" ? Colors.Green : key.status === "revoked" ? Colors.Red : Colors.Blurple)
    .setTitle("Access key details")
    .setDescription(`\`${key.id}\``)
    .addFields(
      { name: "Prefix", value: key.code_prefix, inline: true },
      { name: "Credits granted", value: key.credits_total.toString(), inline: true },
      { name: "Status", value: statusLabel(key.status), inline: true },
      { name: "Expires", value: key.expires_at ? discordTimestamp(key.expires_at.toISOString()) : "Never", inline: true },
      { name: "Redeemed by", value: key.redeemed_by ? `\`${key.redeemed_by}\`` : "Nobody", inline: true },
      { name: "Revoked", value: key.revoked_at ? discordTimestamp(key.revoked_at.toISOString()) : "No", inline: true }
    );
}

export function generatedKeysEmbed(keys: readonly { id: string; code: string }[]): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(Colors.Green)
    .setTitle("Access keys created")
    .setDescription(["These plaintext values are shown once. Store them securely.", "", ...keys.map((key) => `\`${key.code}\``)].join("\n"));
}
