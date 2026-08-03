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
  CheckboxGroupBuilder,
  CheckboxGroupOptionBuilder,
  Colors,
  EmbedBuilder,
  LabelBuilder,
  ModalBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  TextDisplayBuilder,
  TextInputBuilder,
  TextInputStyle
} from "discord.js";

import type { AccessKeyView } from "./database.js";
import { countryDisplay } from "./countries.js";
import type {
  AccessView,
  AiDecisionSummary,
  ReportDraft,
  ServerSnapshot
} from "./types.js";
import type { WriterProgress } from "./report-writer.js";

const FLOW_LABELS: Record<ReportFlow, string> = {
  message_urf: "Message",
  user_urf: "Profile",
  guild_urf: "Server"
};

const STATUS_LABELS: Record<string, string> = {
  queued: "Preparing report",
  requesting_verification: "Preparing report",
  awaiting_verification: "Preparing report",
  verification_received: "Preparing report",
  verifying: "Preparing report",
  submitting: "Preparing report",
  submitted: "Submitted to Discord",
  failed: "Failed",
  received: "Received by Discord",
  actioned: "Action taken",
  closed_no_action: "Closed — no action",
  review_not_approved: "Review not approved",
  review_queued: "Appeal queued",
  review_requested: "Appeal requested",
  review_received: "Appeal received by Discord",
  review_confirmation_timeout: "Appeal sent - email unconfirmed",
  review_request_failed: "Automatic appeal failed",
  review_ineligible: "DSA report ineligible for review",
  review_request_ambiguous: "Appeal result uncertain",
  review_approved: "Appeal approved",
  review_not_approved_final: "Appeal denied"
};

function statusLabel(status: string | null): string {
  if (status === null) return "Pending Discord review";
  return STATUS_LABELS[status] ?? status.replaceAll("_", " ");
}

function displayStatus(report: ReportView): string {
  if (report.reviewStatus === "approved") return "review_approved";
  if (report.reviewStatus === "not_approved") return "review_not_approved_final";
  if (report.reviewStatus !== null) return `review_${report.reviewStatus}`;
  return report.discordStatus ?? report.status;
}

function statusColor(
  report: Pick<ReportView, "status" | "discordStatus" | "reviewStatus">
): number {
  if (
    report.status === "failed" ||
    report.discordStatus === "review_not_approved" ||
    report.reviewStatus === "request_failed" ||
    report.reviewStatus === "request_ambiguous" ||
    report.reviewStatus === "not_approved"
  ) {
    return Colors.Red;
  }
  if (report.reviewStatus === "approved") return Colors.Green;
  if (
    report.reviewStatus === "confirmation_timeout" ||
    report.reviewStatus === "ineligible"
  ) {
    return Colors.Orange;
  }
  if (report.discordStatus === "actioned") return Colors.Green;
  if (report.discordStatus === "closed_no_action" && report.reviewStatus === null) {
    return Colors.Greyple;
  }
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

function codeBlock(value: string): string {
  return `\`\`\`\n${value.replaceAll("```", "`\u200b``")}\n\`\`\``;
}

function decisionText(decisions: readonly AiDecisionSummary[]): string {
  const visible = decisions.slice(-3);
  const lines = visible.flatMap((decision) => [
    `**${decision.action}** ${discordTimestamp(decision.decidedAt)}`,
    `Country: ${decision.country.before} → ${decision.country.after}`,
    `Category: ${decision.category.before} → ${decision.category.after}`,
    `Details: ${decision.details.before} → ${decision.details.after}`
  ]);
  if (decisions.length > visible.length) {
    lines.unshift(`_${decisions.length - visible.length} earlier AI decision(s) hidden_`);
  }
  return truncate(lines.join("\n"), 1_024);
}

function draftDecisionText(draft: ReportDraft, progress?: WriterProgress): string {
  if (progress) {
    const countryBefore =
      draft.countrySelection === "auto" || !draft.country
        ? "Auto"
        : countryDisplay(draft.country);
    const categoryBefore = draft.reportType
      ? reportReasonLabel(draft.flow, draft.reportType)
      : "Auto";
    const detailsBefore = draft.context
      ? "Existing draft"
      : draft.reportBrief
        ? "User guidance"
        : "Blank";
    const countryAfter =
      progress.country === "Auto" ? "Deciding" : countryDisplay(progress.country);
    const categoryAfter = progress.reportType === "Auto" ? "Deciding" : progress.reportType;
    return truncate(
      [
        `**In progress** ${discordTimestamp(new Date().toISOString())}`,
        `Country: ${countryBefore} → ${countryAfter}`,
        `Category: ${categoryBefore} → ${categoryAfter}`,
        `Details: ${detailsBefore} → ${progress.stage === "research" ? "Researching" : "Writing"}`
      ].join("\n"),
      1_024
    );
  }
  if (draft.aiDecisions?.length) return decisionText(draft.aiDecisions);
  return draft.aiDisabled
    ? "AI disabled — the report fields were supplied by the user."
    : "No completed AI decision yet.";
}

export function buildWriterProgress(
  draftId: string,
  draft: ReportDraft,
  progress: WriterProgress,
  status?: string
): EmbedBuilder {
  const now = new Date().toISOString();
  const details =
    progress.reportReason === "Auto"
      ? draft.reportBrief ?? "AI is interpreting the supplied evidence."
      : progress.reportReason;
  const embed = new EmbedBuilder()
    .setColor(Colors.Yellow)
    .setTitle(`${FLOW_LABELS[draft.flow]} report`)
    .addFields(
      { name: "Item", value: truncate(targetSummary(draft), 1_024) },
      {
        name: "Status",
        value:
          status ?? (progress.stage === "research" ? "Researching report" : "Writing report"),
        inline: true
      },
      { name: "Category", value: progress.reportType, inline: true },
      {
        name: "Country",
        value:
          progress.country === "Auto" ? "Auto-selected by AI" : countryDisplay(progress.country),
        inline: true
      },
      { name: "Details", value: codeBlock(details) },
      { name: "AI decisions", value: draftDecisionText(draft, progress) },
      {
        name: "References",
        value: `Draft: \`${shortId(draftId)}\`\nDiscord: Not assigned`,
        inline: true
      },
      {
        name: "Dates",
        value: `Created ${discordTimestamp(draft.createdAt ?? now)}\nUpdated ${discordTimestamp(now)}`,
        inline: true
      },
      { name: "Appeal", value: "Not available until submission" }
    );
  if (draft.flow === "user_urf" && draft.reportedUserSnapshot?.avatarUrl) {
    embed.setThumbnail(draft.reportedUserSnapshot.avatarUrl);
  } else if (draft.serverSnapshot?.iconUrl) {
    embed.setThumbnail(draft.serverSnapshot.iconUrl);
  }
  return embed;
}

function textLabel(input: {
  customId: string;
  label: string;
  description?: string;
  required?: boolean;
  style?: TextInputStyle;
  minLength?: number;
  maxLength: number;
  placeholder?: string;
  value?: string;
}): LabelBuilder {
  const field = new TextInputBuilder()
    .setCustomId(input.customId)
    .setStyle(input.style ?? TextInputStyle.Short)
    .setRequired(input.required ?? true)
    .setMaxLength(input.maxLength);
  if (input.minLength !== undefined) field.setMinLength(input.minLength);
  if (input.placeholder !== undefined) field.setPlaceholder(input.placeholder);
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
  placeholder?: string;
  required?: boolean;
}): LabelBuilder {
  const required = input.required ?? true;
  const select = new StringSelectMenuBuilder()
    .setCustomId(input.customId)
    .setRequired(required)
    .setMinValues(required ? 1 : 0)
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
  if (input.placeholder !== undefined) select.setPlaceholder(input.placeholder);
  const label = new LabelBuilder().setLabel(input.label).setStringSelectMenuComponent(select);
  if (input.description !== undefined) label.setDescription(input.description);
  return label;
}

function reportPreferencesLabel(draft: ReportDraft): LabelBuilder {
  const preferences = new CheckboxGroupBuilder()
    .setCustomId("preferences")
    .setRequired(false)
    .setMinValues(0)
    .setMaxValues(2)
    .addOptions(
      new CheckboxGroupOptionBuilder()
        .setLabel("Use AI")
        .setValue("USE_AI")
        .setDescription("Infer missing details and write the final report.")
        .setDefault(draft.aiDisabled !== true),
      new CheckboxGroupOptionBuilder()
        .setLabel("Send review to DMs")
        .setValue("SEND_DM")
        .setDescription("Send the generated review and confirmation buttons to DMs.")
        .setDefault(draft.sendToDms !== false)
    );
  return new LabelBuilder()
    .setLabel("Report preferences")
    .setDescription("Both options are enabled by default.")
    .setCheckboxGroupComponent(preferences);
}

function reportCountryLabel(draft: ReportDraft): LabelBuilder {
  const countryOptions = [
    {
      label: "Auto",
      value: "AUTO",
      default: draft.countrySelection === "auto"
    },
    ...(draft.countrySelection !== "auto" && draft.country
      ? [
          {
            label:
              draft.countrySelection === "default"
                ? `Saved default: ${countryDisplay(draft.country)}`
                : `Current: ${countryDisplay(draft.country)}`,
            value: "DEFAULT",
            default: true
          }
        ]
      : []),
    { label: "Choose another country", value: "CHOOSE" }
  ];
  return selectLabel({
    customId: "country_mode",
    label: "Country",
    description: "Use Auto, your saved default, or choose another country.",
    options: countryOptions
  });
}

export function buildReportModal(draftId: string, draft: ReportDraft): ModalBuilder {
  const modal = new ModalBuilder()
    .setCustomId(`report:modal:${draftId}`)
    .setTitle(`Report ${FLOW_LABELS[draft.flow]}`);
  modal.addLabelComponents(
    selectLabel({
      customId: "report_type",
      label: "Why are you reporting this?",
      description:
        "If blank, AI will automatically choose this field when Use AI is enabled.",
      placeholder: "Auto",
      required: false,
      options: reportReasons(draft.flow).map((reason) => ({
        label: reason.label,
        value: reason.value,
        default: reason.value === draft.reportType
      }))
    })
  );

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
      label: "Briefly explain the report",
      description:
        "If blank, AI will automatically write this field when Use AI is enabled. Maximum 512 characters.",
      placeholder: "Auto",
      required: false,
      style: TextInputStyle.Paragraph,
      maxLength: 512,
      ...(draft.reportBrief === undefined ? {} : { value: draft.reportBrief })
    })
  );
  modal.addLabelComponents(reportCountryLabel(draft), reportPreferencesLabel(draft));
  return modal;
}

export function buildRefinementModal(draftId: string): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(`writer:refine:${draftId}`)
    .setTitle("Refine AI report")
    .addLabelComponents(
      textLabel({
        customId: "instruction",
        label: "What should AI change?",
        description: "This continues the existing AI conversation.",
        style: TextInputStyle.Paragraph,
        minLength: 1,
        maxLength: 512
      })
    );
}

export function buildResubmissionRewriteModal(reportId: string): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(`reports:rewrite:${reportId}`)
    .setTitle("Rewrite denied report")
    .addLabelComponents(
      textLabel({
        customId: "instruction",
        label: "What should be improved?",
        description: "AI will create a new editable draft. Nothing is sent yet.",
        style: TextInputStyle.Paragraph,
        minLength: 1,
        maxLength: 512
      })
    );
}

export function buildManualReportModal(draftId: string, draft: ReportDraft): ModalBuilder {
  const current = (draft.context ?? draft.reportBrief ?? "").trim();
  const displayLimit = 3_940;
  const displayed =
    current.length <= displayLimit
      ? current
      : `${current.slice(0, displayLimit - 36)}\n\n[AI draft display truncated]`;
  const modal = new ModalBuilder()
    .setCustomId(`writer:edit:${draftId}`)
    .setTitle("Edit report manually");
  if (displayed) {
    modal.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`**AI draft to repair — copy from below**\n\n${displayed}`)
    );
  }
  modal.addLabelComponents(
      textLabel({
        customId: "report_text",
        label: "Final report",
        description:
          current.length > 512
            ? "Shorten the AI draft above, then paste up to 512 characters here."
            : "Review the AI draft above. Maximum 512 characters.",
        style: TextInputStyle.Paragraph,
        minLength: 1,
        maxLength: 512,
        ...(current.length > 0 && current.length <= 512 ? { value: current } : {})
      })
    );
  return modal;
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
            ? "Choose **Auto** to let AI select a supported country based on legal relevance, or select a country override."
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
    `Display name: **${snapshot.globalDisplayName ?? snapshot.username}**`,
    `@${snapshot.username}`,
    `User ID: \`${snapshot.userId}\``,
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
      return "Auto-selected";
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
    !draft.reportReason ||
    !draft.reportType ||
    !draft.reportReason ||
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
    .setTitle(`${FLOW_LABELS[draft.flow]} report`)
    .addFields(
      { name: "Item", value: truncate(targetSummary(draft), 1_000) },
      { name: "Status", value: "Ready for review", inline: true },
      {
        name: "Category",
        value: reasonText(draft.flow, draft.reportType, elements),
        inline: true
      },
      {
        name: "Country",
        value: `${countryDisplay(draft.country)}\n${countryOrigin(draft)}`,
        inline: true
      },
      ...splitField(details, 1_016).map((value, index) => ({
        name: index === 0 ? "Details" : `Details (${index + 1})`,
        value: codeBlock(value)
      })),
      { name: "AI decisions", value: draftDecisionText(draft) },
      {
        name: "References",
        value: `Draft: \`${shortId(draftId)}\`\nDiscord: Not assigned`,
        inline: true
      },
      {
        name: "Dates",
        value: `Created ${discordTimestamp(draft.createdAt ?? new Date().toISOString())}\nUpdated ${discordTimestamp(draft.updatedAt ?? new Date().toISOString())}`,
        inline: true
      },
      { name: "Appeal", value: "Not available until submission" }
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
  canManualEdit = false,
  draft?: ReportDraft
): {
  embeds: EmbedBuilder[];
  components: ActionRowBuilder<ButtonBuilder>[];
} {
  return {
    embeds: [
      errorEmbed(description).addFields({
        name: "AI decisions",
        value: draft ? draftDecisionText(draft) : "No completed AI decision was recorded."
      })
    ],
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
  const reportReason = draft.reportReason;
  if (
    !draft.country ||
    !reportReason ||
    !draft.reportType ||
    !draft.context ||
    draft.context.length > 512
  ) {
    throw new Error("Report draft is incomplete.");
  }
  const common = {
    country: draft.country,
    reportReason,
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

function discordTime(value: string): string {
  const seconds = Math.floor(new Date(value).getTime() / 1_000);
  return Number.isFinite(seconds) ? `<t:${seconds}:R>` : value;
}

interface HistoryStage {
  key: string;
  label: string;
  occurredAt: string;
}

function attemptHistoryStages(events: ReportView["timeline"]): HistoryStage[] {
  const stages: HistoryStage[] = [];
  const add = (key: string, label: string, occurredAt: string): void => {
    if (!stages.some((stage) => stage.key === key)) stages.push({ key, label, occurredAt });
  };
  for (const event of events) {
    if (event.type === "report_submitted") {
      add("submitted", "Submitted to Discord", event.occurredAt);
    } else if (event.type === "report_failed") {
      add(
        "failed",
        `Report failed${event.errorCode ? ` · ${event.errorCode}` : ""}`,
        event.occurredAt
      );
    } else if (event.type === "review_requested" || event.type === "review_received") {
      add("appeal_submitted", "Appeal submitted", event.occurredAt);
    } else if (event.type === "review_request_failed") {
      add("appeal_failed", "Appeal could not be submitted", event.occurredAt);
    } else if (event.type === "review_ineligible") {
      add(
        "appeal_ineligible",
        "Appeal unavailable — DSA report ineligible",
        event.occurredAt
      );
    } else if (event.type === "review_request_ambiguous") {
      add("appeal_ambiguous", "Appeal submission uncertain", event.occurredAt);
    } else if (event.type === "review_approved") {
      add("appeal_approved", "Appeal approved — Discord took action", event.occurredAt);
    } else if (event.type === "discord_status_updated") {
      if (event.discordStatus === "closed_no_action") {
        add("original_closed", "Original report: Closed without action", event.occurredAt);
      } else if (event.discordStatus === "actioned") {
        if (stages.some((stage) => stage.key === "appeal_submitted")) {
          add(
            "appeal_approved",
            "Appeal approved — Discord took action",
            event.occurredAt
          );
        } else {
          add("original_actioned", "Original report: Discord took action", event.occurredAt);
        }
      } else if (event.discordStatus === "review_not_approved") {
        add(
          "appeal_denied",
          "Appeal denied — Discord upheld no action",
          event.occurredAt
        );
      }
    }
  }
  return stages;
}

function currentHistoryStage(report: ReportView): HistoryStage {
  const reviewTime = report.reviewStatusUpdatedAt ?? report.updatedAt;
  switch (report.reviewStatus) {
    case "queued":
      return { key: "appeal_preparing", label: "Preparing appeal", occurredAt: reviewTime };
    case "requested":
      return {
        key: "appeal_confirmation",
        label: "Waiting for appeal confirmation",
        occurredAt: reviewTime
      };
    case "received":
      return {
        key: "appeal_waiting",
        label: "Waiting for appeal decision",
        occurredAt: reviewTime
      };
    case "confirmation_timeout":
      return {
        key: "appeal_waiting",
        label: "Waiting for appeal decision — confirmation delayed",
        occurredAt: reviewTime
      };
    case "request_failed":
      return {
        key: "appeal_failed",
        label: "Appeal could not be submitted",
        occurredAt: reviewTime
      };
    case "ineligible":
      return {
        key: "appeal_ineligible",
        label: "Appeal unavailable — DSA report ineligible",
        occurredAt: reviewTime
      };
    case "request_ambiguous":
      return {
        key: "appeal_ambiguous",
        label: "Appeal submission uncertain",
        occurredAt: reviewTime
      };
    case "approved":
      return {
        key: "appeal_approved",
        label: "Appeal approved — Discord took action",
        occurredAt: reviewTime
      };
    case "not_approved":
      return {
        key: "appeal_denied",
        label: "Appeal denied — Discord upheld no action",
        occurredAt: reviewTime
      };
  }
  const discordTimeValue = report.discordStatusUpdatedAt ?? report.updatedAt;
  if (report.discordStatus === "actioned") {
    return {
      key: "original_actioned",
      label: "Original report: Discord took action",
      occurredAt: discordTimeValue
    };
  }
  if (report.discordStatus === "closed_no_action") {
    return {
      key: "original_closed",
      label: "Original report: Closed without action",
      occurredAt: discordTimeValue
    };
  }
  if (report.discordStatus === "review_not_approved") {
    return {
      key: "appeal_denied",
      label: "Appeal denied — Discord upheld no action",
      occurredAt: discordTimeValue
    };
  }
  if (report.status === "failed") {
    return { key: "failed", label: "Report failed", occurredAt: report.updatedAt };
  }
  if (report.status === "queued") {
    return { key: "preparing", label: "Preparing report", occurredAt: report.updatedAt };
  }
  if (report.status === "requesting_verification" || report.status === "awaiting_verification") {
    return {
      key: "verification",
      label: "Waiting for verification email",
      occurredAt: report.updatedAt
    };
  }
  if (
    report.status === "verification_received" ||
    report.status === "verifying" ||
    report.status === "submitting"
  ) {
    return { key: "submitting", label: "Preparing submission", occurredAt: report.updatedAt };
  }
  return {
    key: "original_waiting",
    label:
      report.discordStatus === "received"
        ? "Waiting for original report decision"
        : "Waiting for Discord confirmation",
    occurredAt: discordTimeValue
  };
}

export function reportHistory(report: ReportView): string {
  const attempts = [...new Set(report.timeline.map((event) => event.lifecycleAttempt ?? 1))]
    .sort((left, right) => left - right)
    .slice(-3);
  const latestAttempt = attempts.at(-1) ?? report.lifecycleAttempt;
  const lines: string[] = [];
  for (const attempt of attempts.filter((value) => value !== latestAttempt)) {
    const stages = attemptHistoryStages(
      report.timeline.filter((event) => (event.lifecycleAttempt ?? 1) === attempt)
    );
    const summary = stages.at(-1);
    if (summary) {
      lines.push(`• ${discordTime(summary.occurredAt)} Attempt ${attempt} — ${summary.label}`);
    }
  }
  const current = currentHistoryStage(report);
  const latestStages = attemptHistoryStages(
    report.timeline.filter((event) => (event.lifecycleAttempt ?? 1) === latestAttempt)
  ).filter((stage) => stage.key !== current.key);
  for (const stage of latestStages) {
    lines.push(`• ${discordTime(stage.occurredAt)} ${stage.label}`);
  }
  lines.push(`• ${discordTime(current.occurredAt)} **${current.label}**`);
  return lines.join("\n");
}

export interface ReportEmbedOptions {
  aiDecisions?: readonly AiDecisionSummary[];
  history?: "dm_notice" | "full";
  page?: { current: number; total: number };
  title?: string;
}

export function reportEmbed(
  report: ReportView,
  snapshot?: ServerSnapshot | null,
  options: ReportEmbedOptions = {}
): EmbedBuilder {
  const currentStatus = displayStatus(report);
  const category = reasonText(report.flow, report.reportType, reportElements(report));
  const embed = new EmbedBuilder()
    .setColor(statusColor(report))
    .setTitle(options.title ?? `${FLOW_LABELS[report.flow]} report`)
    .addFields(
      { name: "Item", value: truncate(reportTarget(report, snapshot), 1_024) },
      { name: "Status", value: statusLabel(currentStatus), inline: true },
      { name: "Category", value: category, inline: true },
      { name: "Country", value: countryDisplay(report.country), inline: true },
      ...splitField(reportDetails(report, snapshot), 1_016).map((value, index) => ({
        name: index === 0 ? "Details" : `Details (${index + 1})`,
        value: codeBlock(value)
      })),
      ...(options.aiDecisions === undefined
        ? []
        : [
            {
              name: "AI decisions",
              value: options.aiDecisions.length
                ? decisionText(options.aiDecisions)
                : "No AI decisions were recorded for this report."
            }
          ]),
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
  embed.addFields({
    name: "Appeal",
    value:
      report.reviewStatus === null
        ? "Not available"
        : `${statusLabel(displayStatus(report))}${
            report.reviewError?.message ? `\n${report.reviewError.message}` : ""
          }`
  });
  if (report.resubmittable) {
    embed.addFields({
      name: "Resubmission",
      value: "A fresh linked report can be resent as-is or rewritten first."
    });
  }
  if (report.retrySequence > 0 || report.retryable) {
    embed.addFields({
      name: "Retry",
      value: `Attempt **${report.retrySequence + 1}**${
        report.retryable ? " · Another safe retry is available" : ""
      }`
    });
  }
  if (options.history === "dm_notice") {
    embed.addFields({ name: "History", value: "Check your DMs for the full status log." });
  } else {
    for (const [index, value] of splitField(reportHistory(report), 1_024).entries()) {
      embed.addFields({
        name: index === 0 ? "History" : `History (${index + 1})`,
        value
      });
    }
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
  if (report.resubmittable) {
    return [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`reports:retry:${report.internalReportId}`)
          .setLabel("Resend same report")
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId(`reports:rewrite:${report.internalReportId}`)
          .setLabel("Rewrite & resend")
          .setStyle(ButtonStyle.Secondary)
      )
    ];
  }
  if (!(report.status === "failed" && report.retryable)) return [];
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
    embeds: [
      reportEmbed(report, snapshot, {
        history: "dm_notice",
        page: { current: safePage + 1, total }
      })
    ],
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
