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
  submitted: "Submitted",
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

const EVENT_LABELS: Record<string, string> = {
  report_created: "Report created",
  requesting_verification: "Verification requested",
  verification_requested: "Verification email requested",
  verification_email_received: "Verification email received",
  verification_started: "Verification started",
  submission_started: "Submission started",
  report_submitted: "Submitted to Discord",
  discord_status_updated: "Discord review updated",
  report_failed: "Processing failed",
  report_retry_requested: "Retry requested"
};

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
      customId: "context",
      label: "Why is this unlawful?",
      description: "Explain specifically why this violates the law in the selected country.",
      required: true,
      style: TextInputStyle.Paragraph,
      minLength: 1,
      maxLength: 4000,
      ...(draft.context === undefined ? {} : { value: draft.context })
    })
  );
  return modal;
}

export function buildCountryPicker(
  countries: readonly string[],
  draftId: string,
  page: number
): { embeds: EmbedBuilder[]; components: ActionRowBuilder<StringSelectMenuBuilder | ButtonBuilder>[] } {
  const pageSize = 24;
  const pageCount = Math.max(1, Math.ceil(countries.length / pageSize));
  const safePage = Math.min(Math.max(page, 0), pageCount - 1);
  const options = countries.slice(safePage * pageSize, (safePage + 1) * pageSize);
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
        `Select the EU country whose law applies to this report.\n\nPage **${safePage + 1} of ${pageCount}**`
      )
    ],
    components
  };
}

function targetSummary(draft: ReportDraft): string {
  switch (draft.flow) {
    case "message_urf":
      return draft.messageUrl ?? "Missing message link";
    case "user_urf":
      return `${draft.reportedUsername ?? "Missing username"}${
        draft.reportedUserServerId ? ` in server ${draft.reportedUserServerId}` : ""
      }`;
    case "guild_urf":
      return draft.guildIdOrInviteCode ?? "Missing server ID or invite";
  }
}

function truncate(value: string, maximum: number): string {
  return value.length <= maximum ? value : `${value.slice(0, maximum - 1)}…`;
}

export function buildReview(draftId: string, draft: ReportDraft): {
  embeds: EmbedBuilder[];
  components: ActionRowBuilder<ButtonBuilder>[];
} {
  if (!draft.country || !draft.reportType || !draft.context) {
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
      { name: "Country", value: countryDisplay(draft.country), inline: true },
      { name: "Reason", value: reasonText(draft.flow, draft.reportType, elements) },
      ...splitField(details).map((value, index) => ({
        name: index === 0 ? "Reported details" : `Reported details (${index + 1})`,
        value
      }))
    )
    .setFooter({ text: "Review carefully before submitting" });
  const buttons = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`draft:submit:${draftId}`)
      .setLabel("Submit DSA Report")
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(`draft:edit:${draftId}`)
      .setLabel("Edit")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`draft:country:${draftId}`)
      .setLabel("Change Country")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`draft:cancel:${draftId}`)
      .setLabel("Cancel")
      .setStyle(ButtonStyle.Secondary)
  );
  return { embeds: [embed], components: [buttons] };
}

export function draftToCreateInput(draft: ReportDraft, userId: string): CreateReportInput {
  if (!draft.country || !draft.reportType || !draft.context) {
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
      if (!draft.reportedUsername || !draft.profileElements?.length) {
        throw new Error("A username and profile element are required.");
      }
      return {
        ...common,
        flow: draft.flow,
        reportedUsername: draft.reportedUsername,
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
        value: access.defaultCountry ? countryDisplay(access.defaultCountry) : "Not configured",
        inline: true
      },
      { name: "Account status", value: access.suspended ? "Suspended" : "Active", inline: true }
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
      return report.reportedDetails.reportedUsername;
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
      details.kind === "server" ? serverSnapshotText(snapshot) : null,
      details.context
    ]
      .filter((value): value is string => Boolean(value))
      .join("\n\n") || "No additional context supplied."
  );
}

function reportTimeline(report: ReportView): string {
  if (report.timeline.length === 0) return "No timeline events recorded.";
  let previousAttempt: number | null = null;
  return report.timeline
    .flatMap((event) => {
      const label =
        event.type === "discord_status_updated" && event.discordStatus
          ? statusLabel(event.discordStatus)
          : EVENT_LABELS[event.type] ?? statusLabel(event.type);
      const attemptHeading =
        event.lifecycleAttempt !== null && event.lifecycleAttempt !== previousAttempt
          ? [`**Attempt ${event.lifecycleAttempt}**`]
          : [];
      previousAttempt = event.lifecycleAttempt;
      return [
        ...attemptHeading,
        `${discordTimestamp(event.occurredAt)} • **${label}**${
          event.errorCode ? ` • \`${event.errorCode}\`` : ""
        }`
      ];
    })
    .join("\n");
}

export function reportEmbed(
  report: ReportView,
  snapshot?: ServerSnapshot | null,
  page?: { current: number; total: number }
): EmbedBuilder {
  const currentStatus = report.discordStatus ?? report.status;
  const embed = new EmbedBuilder()
    .setColor(statusColor(report))
    .setTitle(`${FLOW_LABELS[report.flow]} report`)
    .setDescription(`**${statusLabel(currentStatus)}**`)
    .addFields(
      { name: "Reported thing", value: truncate(reportTarget(report, snapshot), 1_024) },
      { name: "Report category", value: FLOW_LABELS[report.flow], inline: true },
      { name: "Country", value: countryDisplay(report.country), inline: true },
      { name: "Reason", value: reasonText(report.flow, report.reportType, reportElements(report)) },
      ...splitField(reportDetails(report, snapshot)).map((value, index) => ({
        name: index === 0 ? "Reported details" : `Reported details (${index + 1})`,
        value
      })),
      { name: "Progress", value: statusLabel(report.status), inline: true },
      { name: "Discord review", value: statusLabel(report.discordStatus), inline: true },
      { name: "Report ID", value: `\`${shortId(report.internalReportId)}\``, inline: true },
      { name: "Discord ID", value: report.discordReportId ? `\`${report.discordReportId}\`` : "Not assigned", inline: true },
      { name: "Attempt", value: `${report.lifecycleAttempt} of 3`, inline: true },
      { name: "Created", value: discordTimestamp(report.createdAt), inline: true },
      { name: "Last updated", value: discordTimestamp(report.updatedAt), inline: true }
    );
  for (const [index, value] of splitField(reportTimeline(report)).entries()) {
    embed.addFields({ name: index === 0 ? "Timeline" : `Timeline (${index + 1})`, value });
  }
  if (snapshot?.iconUrl) embed.setThumbnail(snapshot.iconUrl);
  if (report.error) {
    embed.addFields({
      name: "Latest error",
      value: `${report.error.message ?? report.error.code}\nRetry available: **${report.retryable ? "Yes" : "No"}**`
    });
  }
  embed.setFooter({
    text: page
      ? `Report ${page.current} of ${page.total} • Full ID: ${report.internalReportId}`
      : `Full ID: ${report.internalReportId}`
  });
  return embed;
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
  return {
    embeds: [reportEmbed(report, snapshot, { current: safePage + 1, total })],
    components: total > 1 ? [controls] : []
  };
}

export function accessKeysEmbed(keys: readonly AccessKeyView[]): EmbedBuilder {
  const embed = infoEmbed("Access keys", keys.length === 0 ? "No access keys exist." : `Showing the ${keys.length} most recent keys.`);
  for (const key of keys) {
    embed.addFields({
      name: `${key.code_prefix} • ${statusLabel(key.status)}`,
      value: `ID: \`${key.id}\`\nCredits: **${key.credits_total}** • Expires: ${key.expires_at ? discordTimestamp(key.expires_at.toISOString()) : "Never"}`,
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
      { name: "Credits", value: key.credits_total.toString(), inline: true },
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
    .setDescription(["These plaintext values are shown once. Store them securely.", "", ...keys.map((key) => `\`${key.id}\`\n\`${key.code}\``)].join("\n"));
}
