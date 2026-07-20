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
  LabelBuilder,
  ModalBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  TextInputBuilder,
  TextInputStyle
} from "discord.js";

import type { AccessView, ReportDraft } from "./types.js";

const FLOW_LABELS: Record<ReportFlow, string> = {
  message_urf: "Message",
  user_urf: "Profile",
  guild_urf: "Server"
};

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
): { content: string; components: ActionRowBuilder<StringSelectMenuBuilder | ButtonBuilder>[] } {
  const pageSize = 24;
  const pageCount = Math.max(1, Math.ceil(countries.length / pageSize));
  const safePage = Math.min(Math.max(page, 0), pageCount - 1);
  const options = countries.slice(safePage * pageSize, (safePage + 1) * pageSize);
  const picker = new StringSelectMenuBuilder()
    .setCustomId(`country:select:${draftId}:${safePage}`)
    .setPlaceholder("Choose the relevant EU country")
    .addOptions(options.map((country) => ({ label: country, value: country })))
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
    content: `Choose the country whose law applies. Page ${safePage + 1}/${pageCount}.`,
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
  content: string;
  components: ActionRowBuilder<ButtonBuilder>[];
} {
  if (!draft.country || !draft.reportType || !draft.context) {
    throw new Error("Report draft is incomplete.");
  }
  const elements =
    draft.flow === "user_urf"
      ? draft.profileElements?.join(", ")
      : draft.flow === "guild_urf"
        ? draft.guildElements?.join(", ")
        : undefined;
  const content = [
    "**Review this DSA report before submitting**",
    `Type: ${FLOW_LABELS[draft.flow]}`,
    `Country: ${draft.country}`,
    `Reason: ${reportReasonLabel(draft.flow, draft.reportType)}`,
    `Target: ${truncate(targetSummary(draft), 300)}`,
    ...(elements ? [`Elements: ${elements}`] : []),
    "",
    "**Context**",
    truncate(draft.context, 1_000),
    "",
    "Submitting creates a real report. Confirm that the information is truthful and authorized."
  ].join("\n");
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
  return { content, components: [buttons] };
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

export function renderAccess(access: AccessView, admin: boolean): string {
  return [
    admin ? "Access: administrator (unlimited)" : `Credits: ${access.credits}`,
    `Default country: ${access.defaultCountry ?? "not set"}`,
    `Suspended: ${access.suspended ? "yes" : "no"}`,
    ...(access.suspensionReason ? [`Reason: ${access.suspensionReason}`] : [])
  ].join("\n");
}

export function renderReport(report: ReportView): string {
  return [
    `Report: ${report.internalReportId}`,
    `Type: ${FLOW_LABELS[report.flow]} — ${reportReasonLabel(report.flow, report.reportType)}`,
    `Country: ${report.country}`,
    `Submission status: ${report.status}`,
    `Discord status: ${report.discordStatus ?? "not received yet"}`,
    `Discord report ID: ${report.discordReportId ?? "not assigned yet"}`,
    `Attempt: ${report.lifecycleAttempt}/3`,
    ...(report.error ? [`Error: ${report.error.code}`, `Retryable: ${report.retryable ? "yes" : "no"}`] : [])
  ].join("\n");
}
