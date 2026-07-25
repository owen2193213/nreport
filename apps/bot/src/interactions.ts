import { setTimeout as delay } from "node:timers/promises";

import {
  DsaApiError,
  GUILD_ELEMENTS,
  PROFILE_ELEMENTS
} from "@discord-dsa/contracts";
import type {
  DsaApi,
  GuildElement,
  ReportDetail,
  ReportView,
  UserProfileElement
} from "@discord-dsa/contracts";
import {
  MessageFlags,
  type AutocompleteInteraction,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Interaction,
  type MessageContextMenuCommandInteraction,
  type ModalSubmitInteraction,
  type StringSelectMenuInteraction
} from "discord.js";

import type { BotConfig } from "./config.js";
import { countryDisplay, matchingCountries } from "./countries.js";
import { decryptJson, encryptJson, generateAccessKey, hashAccessKey } from "./crypto.js";
import { AccessError } from "./database.js";
import type { BotDatabase } from "./database.js";
import { snapshotMessage } from "./message-resolver.js";
import type { MessageResolver } from "./message-resolver.js";
import { botLog, errorFields, pseudonymousActorKey } from "./observability.js";
import {
  isValidProfileTarget,
  normalizeProfileTarget
} from "./profile-resolver.js";
import type { ProfileResolver } from "./profile-resolver.js";
import {
  initialWriterPrompt,
  reportHasLawReference,
  ReportWriterError
} from "./report-writer.js";
import type { ReportWriter } from "./report-writer.js";
import type { ServerResolver } from "./server-resolver.js";
import type { ReportDraft } from "./types.js";
import {
  accessEmbed,
  accessKeyEmbed,
  accessKeysEmbed,
  buildCountryPicker,
  buildProfileTargetConfirmation,
  buildManualReportModal,
  buildRefinementModal,
  buildReportModal,
  buildReview,
  buildWriterFailure,
  draftToCreateInput,
  errorEmbed,
  generatedKeysEmbed,
  infoEmbed,
  reportBrowser,
  reportEmbed,
  reportRetryComponents,
  successEmbed
} from "./ui.js";

const EPHEMERAL = MessageFlags.Ephemeral;
const SNOWFLAKE = /^\d{15,22}$/;

export function reportCountryFields(country: string | undefined): Partial<ReportDraft> {
  if (country === "AUTO") return { countrySelection: "auto" };
  if (country) return { country, countrySelection: "override" };
  return {};
}

export interface InteractionHandlerOptions {
  api: DsaApi;
  config: BotConfig;
  countries: readonly string[];
  database: BotDatabase;
  messageResolver: MessageResolver;
  profileResolver: ProfileResolver;
  reportWriter: ReportWriter;
  serverResolver: ServerResolver;
}

export function conciseError(error: unknown): string {
  if (
    error instanceof AccessError ||
    error instanceof DsaApiError ||
    error instanceof ReportWriterError
  ) {
    return error.message;
  }
  return "An unexpected error occurred.";
}

function isDefinitePreCreationError(error: unknown): boolean {
  return error instanceof DsaApiError && error.status < 500 && error.status !== 409;
}

export function shouldBypassReportCredits(
  isAdmin: boolean,
  whitelistEnabled: boolean
): boolean {
  return isAdmin || !whitelistEnabled;
}

function parseExpiry(value: string | null): Date | null {
  if (value === null) return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.getTime() <= Date.now()) {
    throw new AccessError("invalid_expiry", "Expiry must be a future ISO-8601 date and time.");
  }
  if (date.getTime() > Date.now() + 365 * 24 * 60 * 60 * 1000) {
    throw new AccessError("invalid_expiry", "Expiry cannot be more than one year away.");
  }
  return date;
}

function customParts(customId: string): string[] {
  return customId.split(":");
}

function interactionLogFields(interaction: Interaction): Record<string, string> {
  if (interaction.isAutocomplete()) {
    return { interactionType: "autocomplete", commandName: interaction.commandName };
  }
  if (interaction.isMessageContextMenuCommand()) {
    return { interactionType: "message_context", commandName: interaction.commandName };
  }
  if (interaction.isChatInputCommand()) {
    return { interactionType: "chat_input", commandName: interaction.commandName };
  }
  if (interaction.isModalSubmit()) return { interactionType: "modal_submit" };
  if (interaction.isStringSelectMenu()) return { interactionType: "string_select" };
  if (interaction.isButton()) return { interactionType: "button" };
  return { interactionType: "unknown" };
}

export class InteractionHandler {
  private readonly api: DsaApi;
  private readonly config: BotConfig;
  private readonly countries: readonly string[];
  private readonly database: BotDatabase;
  private readonly messageResolver: MessageResolver;
  private readonly profileResolver: ProfileResolver;
  private readonly reportWriter: ReportWriter;
  private readonly serverResolver: ServerResolver;

  public constructor(options: InteractionHandlerOptions) {
    this.api = options.api;
    this.config = options.config;
    this.countries = options.countries;
    this.database = options.database;
    this.messageResolver = options.messageResolver;
    this.profileResolver = options.profileResolver;
    this.reportWriter = options.reportWriter;
    this.serverResolver = options.serverResolver;
  }

  public async handle(interaction: Interaction): Promise<void> {
    try {
      if (interaction.isAutocomplete()) {
        await this.handleAutocomplete(interaction);
      } else if (interaction.isMessageContextMenuCommand()) {
        await this.handleMessageContext(interaction);
      } else if (interaction.isChatInputCommand()) {
        await this.handleChatInput(interaction);
      } else if (interaction.isModalSubmit()) {
        await this.handleModal(interaction);
      } else if (interaction.isStringSelectMenu()) {
        await this.handleSelect(interaction);
      } else if (interaction.isButton()) {
        await this.handleButton(interaction);
      }
    } catch (error) {
      botLog(
        "interaction_failed",
        { ...interactionLogFields(interaction), ...errorFields(error) },
        "warn"
      );
      try {
        await this.respondWithError(interaction, error);
      } catch (responseError) {
        botLog(
          "interaction_error_response_failed",
          { ...interactionLogFields(interaction), ...errorFields(responseError) },
          "error"
        );
      }
    }
  }

  private isAdmin(userId: string): boolean {
    return this.config.adminUserIds.has(userId);
  }

  private aiActor(userId: string) {
    return {
      actorKey: pseudonymousActorKey(userId, this.config.keyPepper),
      userId
    };
  }

  private async requireReportAccess(userId: string): Promise<void> {
    if (shouldBypassReportCredits(this.isAdmin(userId), this.config.whitelistEnabled)) return;
    const access = await this.database.getAccess(userId);
    if (access.suspended) {
      throw new AccessError("user_suspended", "Your reporting access is suspended. Contact an admin.");
    }
    if (access.credits < 1) {
      throw new AccessError("no_credits", "You need a report credit. Use `/access redeem` with a valid key.");
    }
  }

  private async requireRetryAccess(userId: string): Promise<void> {
    if (this.isAdmin(userId)) return;
    const access = await this.database.getAccess(userId);
    if (access.suspended) {
      throw new AccessError("user_suspended", "Your reporting access is suspended. Contact an admin.");
    }
  }

  private async retryAsNewReport(
    reportId: string,
    interactionId: string,
    actorUserId: string
  ): Promise<ReportDetail> {
    const report = await this.api.report(reportId);
    this.assertOwner(report, actorUserId);
    await this.requireRetryAccess(actorUserId);
    if (!(report.status === "failed" && report.retryable && report.retrySequence < 2)) {
      throw new AccessError("not_retryable", "This report is not currently safe to retry.");
    }
    const ownerUserId = report.submitterDiscordUserId;
    if (!ownerUserId) throw new AccessError("owner_missing", "This report has no Discord owner.");
    const retried = await this.api.retryReport(reportId, interactionId, ownerUserId);
    await this.database.trackRetryReport(reportId, ownerUserId, interactionId, retried);
    return retried;
  }

  private requireAdmin(userId: string): void {
    if (!this.isAdmin(userId)) {
      throw new AccessError("admin_required", "This command is restricted to configured administrators.");
    }
  }

  private async loadDraft(userId: string, draftId: string): Promise<ReportDraft> {
    return decryptJson<ReportDraft>(
      await this.database.getDraft(userId, draftId),
      this.config.dataEncryptionKey
    );
  }

  private async saveDraft(userId: string, draft: ReportDraft): Promise<string> {
    return this.database.saveDraft(
      userId,
      encryptJson(draft, this.config.dataEncryptionKey)
    );
  }

  private async replaceDraft(userId: string, draftId: string, draft: ReportDraft): Promise<void> {
    await this.database.updateDraft(
      userId,
      draftId,
      encryptJson(draft, this.config.dataEncryptionKey)
    );
  }

  private async startDraft(
    interaction: ChatInputCommandInteraction | MessageContextMenuCommandInteraction,
    draft: ReportDraft
  ): Promise<void> {
    const draftId = await this.prepareDraft(interaction, draft);
    if (draftId) await interaction.showModal(buildReportModal(draftId, draft));
  }

  private async prepareDraft(
    interaction: ChatInputCommandInteraction | MessageContextMenuCommandInteraction,
    draft: ReportDraft
  ): Promise<string | null> {
    await this.requireReportAccess(interaction.user.id);
    const access = await this.database.getAccess(interaction.user.id);
    if (!draft.countrySelection) {
      if (draft.country) {
        draft.countrySelection = "override";
      } else if (access.defaultCountry !== null) {
        draft.country = access.defaultCountry;
        draft.countrySelection = "default";
      } else {
        draft.countrySelection = "auto";
      }
    }
    if (draft.flow === "guild_urf" && draft.guildIdOrInviteCode && !draft.serverSnapshot) {
      const snapshot = await this.serverResolver.resolve(
        draft.guildIdOrInviteCode,
        interaction.guild
      );
      if (snapshot) draft.serverSnapshot = snapshot;
    }
    return this.saveDraft(interaction.user.id, draft);
  }

  private countryOption(interaction: ChatInputCommandInteraction): string | undefined {
    const country = interaction.options.getString("country")?.trim().toUpperCase();
    if (country !== undefined && country !== "AUTO" && !this.countries.includes(country)) {
      throw new AccessError("invalid_country", "Choose a country returned by autocomplete.");
    }
    return country;
  }

  private async snapshotFor(report: ReportDetail, userId: string) {
    if (report.reportedDetails.kind !== "server") return null;
    const ownerId = report.submitterDiscordUserId ?? userId;
    const stored = await this.database.serverSnapshot(report.internalReportId, ownerId);
    if (stored) return stored;
    const resolved = await this.serverResolver.resolve(report.reportedDetails.guildIdOrInviteCode);
    if (resolved) {
      await this.database.saveServerSnapshot(report.internalReportId, ownerId, resolved);
    }
    return resolved;
  }

  private async reportPage(userId: string, requestedPage: number) {
    const { reports } = await this.api.reportsFor(userId);
    if (reports.length === 0) {
      return {
        embeds: [
          infoEmbed(
            "No reports yet",
            "Your submitted DSA reports will appear here. Use `/report` or **Apps → Report Message** to begin."
          )
        ],
        components: []
      };
    }
    const page = Math.min(Math.max(requestedPage, 0), reports.length - 1);
    const summary = reports[page];
    if (!summary) throw new Error("Report page is unavailable.");
    const report = await this.api.report(summary.internalReportId);
    return reportBrowser(report, await this.snapshotFor(report, userId), page, reports.length);
  }

  private async handleMessageContext(
    interaction: MessageContextMenuCommandInteraction
  ): Promise<void> {
    if (interaction.commandName !== "Report Message") return;
    await this.startDraft(interaction, {
      flow: "message_urf",
      messageUrl: interaction.targetMessage.url,
      messageSnapshot: snapshotMessage(interaction.targetMessage)
    });
  }

  private async handleChatInput(interaction: ChatInputCommandInteraction): Promise<void> {
    switch (interaction.commandName) {
      case "report":
        await this.handleReportCommand(interaction);
        break;
      case "reports":
        await this.handleReportsCommand(interaction);
        break;
      case "access":
        await this.handleAccessCommand(interaction);
        break;
      case "settings":
        await this.handleSettingsCommand(interaction);
        break;
      case "admin":
        await this.handleAdminCommand(interaction);
        break;
    }
  }

  private async handleReportCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    const subcommand = interaction.options.getSubcommand();
    const country = this.countryOption(interaction);
    if (subcommand === "message") {
      const messageUrl = interaction.options.getString("message-link", true).trim();
      await this.startDraft(interaction, {
        flow: "message_urf",
        messageUrl,
        ...reportCountryFields(country)
      });
      return;
    }
    if (subcommand === "profile") {
      const target = normalizeProfileTarget(interaction.options.getString("target", true));
      if (!isValidProfileTarget(target)) {
        throw new AccessError(
          "invalid_profile_target",
          "Enter a raw Discord user ID containing 15 to 22 digits."
        );
      }
      const serverId = interaction.options.getString("server-id")?.trim();
      if (serverId && !SNOWFLAKE.test(serverId)) {
        throw new AccessError("invalid_server_id", "Server ID must be a Discord snowflake.");
      }
      const draft: ReportDraft = {
        flow: "user_urf",
        profileTargetRaw: target,
        ...reportCountryFields(country),
        ...(serverId ? { reportedUserServerId: serverId } : {})
      };
      const draftId = await this.prepareDraft(interaction, draft);
      if (!draftId) return;
      await interaction.deferReply({ flags: EPHEMERAL });
      const resolved = await this.profileResolver.resolve(target, serverId, interaction.guild);
      if (resolved) {
        draft.reportedUsername = resolved.username;
        draft.reportedUserId = resolved.userId;
        draft.reportedUserSnapshot = resolved;
        await this.replaceDraft(interaction.user.id, draftId, draft);
      }
      await interaction.editReply({
        ...buildProfileTargetConfirmation(draftId, draft),
        allowedMentions: { parse: [] }
      });
      return;
    }
    const suppliedTarget = interaction.options.getString("server-or-invite")?.trim();
    const guildTarget = interaction.guildId ?? undefined;
    const target = suppliedTarget || guildTarget;
    await this.startDraft(interaction, {
      flow: "guild_urf",
      ...reportCountryFields(country),
      ...(target ? { guildIdOrInviteCode: target } : {})
    });
  }

  private async handleReportsCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    const subcommand = interaction.options.getSubcommand();
    await interaction.deferReply({ flags: EPHEMERAL });
    if (subcommand === "list") {
      await interaction.editReply({
        ...(await this.reportPage(interaction.user.id, 0)),
        allowedMentions: { parse: [] }
      });
      return;
    }
    const reportId = interaction.options.getString("report-id", true);
    const report = await this.api.report(reportId);
    this.assertOwner(report, interaction.user.id);
    if (subcommand === "status") {
      await interaction.editReply({
        embeds: [reportEmbed(report, await this.snapshotFor(report, interaction.user.id))],
        components: reportRetryComponents(report),
        allowedMentions: { parse: [] }
      });
      return;
    }
    const retried = await this.retryAsNewReport(reportId, interaction.id, interaction.user.id);
    await interaction.editReply({
      embeds: [reportEmbed(retried, await this.snapshotFor(retried, interaction.user.id))],
      components: reportRetryComponents(retried),
      allowedMentions: { parse: [] }
    });
  }

  private assertOwner(report: ReportView, userId: string): void {
    if (report.submitterDiscordUserId !== userId && !this.isAdmin(userId)) {
      throw new AccessError("owner_mismatch", "That report does not belong to you.");
    }
  }

  private async handleAccessCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    const subcommand = interaction.options.getSubcommand();
    if (subcommand === "redeem") {
      const code = interaction.options.getString("key", true);
      const access = await this.database.redeemAccessKey(
        interaction.user.id,
        hashAccessKey(code, this.config.keyPepper)
      );
      await interaction.reply({
        embeds: [
          successEmbed(
            "Access key redeemed",
            `Your new balance is **${access.credits} report credit${access.credits === 1 ? "" : "s"}**.`
          )
        ],
        flags: EPHEMERAL,
        allowedMentions: { parse: [] }
      });
      return;
    }
    const access = await this.database.getAccess(interaction.user.id);
    await interaction.reply({
      embeds: [accessEmbed(access, this.isAdmin(interaction.user.id))],
      flags: EPHEMERAL,
      allowedMentions: { parse: [] }
    });
  }

  private async handleSettingsCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    const country = interaction.options.getString("country", true).trim().toUpperCase();
    if (country !== "AUTO" && !this.countries.includes(country)) {
      throw new AccessError("invalid_country", "Choose a country returned by autocomplete.");
    }
    await this.database.setDefaultCountry(interaction.user.id, country === "AUTO" ? null : country);
    await interaction.reply({
      embeds: [
        successEmbed(
          "Default country updated",
          country === "AUTO"
            ? "New reports will use **Auto**, so Grok will select a supported country based on legal relevance. You can still override it per report."
            : `New reports will default to **${countryDisplay(country)}**. You can still override it per report.`
        )
      ],
      flags: EPHEMERAL
    });
  }

  private async handleAdminCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    this.requireAdmin(interaction.user.id);
    const group = interaction.options.getSubcommandGroup(true);
    const subcommand = interaction.options.getSubcommand(true);
    if (group === "key") {
      await this.handleAdminKey(interaction, subcommand);
    } else {
      await this.handleAdminUser(interaction, subcommand);
    }
  }

  private async handleAdminKey(
    interaction: ChatInputCommandInteraction,
    subcommand: string
  ): Promise<void> {
    if (subcommand === "create") {
      const credits = interaction.options.getInteger("credits", true);
      const count = interaction.options.getInteger("count") ?? 1;
      const expiresAt = parseExpiry(interaction.options.getString("expires-at"));
      const generated: Array<{ id: string; code: string }> = [];
      for (let index = 0; index < count; index += 1) {
        const key = generateAccessKey(this.config.keyPepper);
        await this.database.insertAccessKey({
          id: key.id,
          hash: key.hash,
          prefix: key.prefix,
          credits,
          expiresAt,
          actorId: interaction.user.id
        });
        generated.push({ id: key.id, code: key.code });
      }
      await interaction.reply({
        embeds: [generatedKeysEmbed(generated)],
        flags: EPHEMERAL,
        allowedMentions: { parse: [] }
      });
      return;
    }
    if (subcommand === "list") {
      const keys = await this.database.listAccessKeys();
      await interaction.reply({
        embeds: [accessKeysEmbed(keys)],
        flags: EPHEMERAL,
        allowedMentions: { parse: [] }
      });
      return;
    }
    const keyId = interaction.options.getString("key-id", true);
    if (subcommand === "inspect") {
      const key = await this.database.getAccessKey(keyId);
      if (!key) throw new AccessError("key_not_found", "Access key was not found.");
      await interaction.reply({
        embeds: [accessKeyEmbed(key)],
        flags: EPHEMERAL,
        allowedMentions: { parse: [] }
      });
      return;
    }
    const reason = interaction.options.getString("reason")?.trim() || "Revoked by administrator";
    await this.database.revokeAccessKey(keyId, interaction.user.id, reason);
    await interaction.reply({
      embeds: [successEmbed("Access key revoked", `Key \`${keyId}\` has been revoked.`)],
      flags: EPHEMERAL
    });
  }

  private async handleAdminUser(
    interaction: ChatInputCommandInteraction,
    subcommand: string
  ): Promise<void> {
    const userId = interaction.options.getString("user-id", true);
    if (!SNOWFLAKE.test(userId)) throw new AccessError("invalid_user_id", "User ID must be a Discord snowflake.");
    if (subcommand === "inspect") {
      const access = await this.database.getAccess(userId);
      await interaction.reply({
        embeds: [accessEmbed(access, this.isAdmin(userId), userId)],
        flags: EPHEMERAL,
        allowedMentions: { parse: [] }
      });
      return;
    }
    if (subcommand === "suspend") {
      const reason = interaction.options.getString("reason")?.trim() || "Suspended by administrator";
      await this.database.suspendUser(userId, interaction.user.id, reason);
      await interaction.reply({
        embeds: [successEmbed("User suspended", `User \`${userId}\` is suspended and their remaining credits were cleared.`)],
        flags: EPHEMERAL
      });
      return;
    }
    await this.database.reinstateUser(userId, interaction.user.id);
    await interaction.reply({
      embeds: [successEmbed("User reinstated", `User \`${userId}\` is active with **0 credits**.`)],
      flags: EPHEMERAL
    });
  }

  private async handleAutocomplete(interaction: AutocompleteInteraction): Promise<void> {
    if (interaction.commandName !== "settings" && interaction.commandName !== "report") return;
    const focused = interaction.options.getFocused(true);
    if (focused.name !== "country") return;
    await interaction.respond(matchingCountries(this.countries, String(focused.value)));
  }

  private async handleModal(interaction: ModalSubmitInteraction): Promise<void> {
    const [scope, action, draftId] = customParts(interaction.customId);
    if (!draftId) return;
    if (scope === "writer" && action === "refine") {
      const draft = await this.loadDraft(interaction.user.id, draftId);
      const instruction = interaction.fields.getTextInputValue("instruction").trim();
      await interaction.deferUpdate();
      await interaction.editReply({
        embeds: [infoEmbed("Refining report", "Grok is applying your feedback in the same conversation.")],
        components: []
      });
      try {
        const result = await this.reportWriter.refine(
          draft,
          instruction,
          this.aiActor(interaction.user.id)
        );
        draft.country = result.country;
        draft.legalResearch = result.legalResearch;
        draft.context = result.report;
        draft.writerConversation = result.conversation;
        await this.replaceDraft(interaction.user.id, draftId, draft);
        await interaction.editReply({ ...buildReview(draftId, draft), allowedMentions: { parse: [] } });
      } catch (error) {
        await interaction.editReply({
          ...buildWriterFailure(
            draftId,
            conciseError(error),
            "refine",
            Boolean(draft.legalResearch)
          ),
          allowedMentions: { parse: [] }
        });
      }
      return;
    }
    if (scope === "writer" && action === "edit") {
      const draft = await this.loadDraft(interaction.user.id, draftId);
      const report = interaction.fields.getTextInputValue("report_text").trim();
      if (!report || report.length > 512) {
        throw new AccessError("invalid_report_text", "The final report must contain 1 to 512 characters.");
      }
      if (!draft.legalResearch || !reportHasLawReference(report, draft.legalResearch)) {
        throw new AccessError(
          "missing_law_reference",
          "The final report must retain the researched law or provision."
        );
      }
      draft.context = report;
      const conversation = draft.writerConversation ?? [
        { role: "user" as const, content: initialWriterPrompt() }
      ];
      draft.writerConversation = [
        ...conversation,
        { role: "user", content: "Use this manually edited text as the current report." },
        { role: "assistant", content: JSON.stringify({ report }) }
      ];
      await interaction.deferUpdate();
      await this.replaceDraft(interaction.user.id, draftId, draft);
      await interaction.editReply({
        ...buildReview(draftId, draft),
        allowedMentions: { parse: [] }
      });
      return;
    }
    if (scope !== "report" || action !== "modal") return;
    const draft = await this.loadDraft(interaction.user.id, draftId);
    const reportType = interaction.fields.getStringSelectValues("report_type")[0];
    if (!reportType) throw new AccessError("invalid_reason", "Choose a report reason.");
    draft.reportType = reportType;
    draft.reportBrief = interaction.fields.getTextInputValue("brief").trim();
    if (draft.flow === "message_urf" && draft.messageUrl === undefined) {
      draft.messageUrl = interaction.fields.getTextInputValue("message_url").trim();
    }
    if (draft.flow === "user_urf") {
      const values = interaction.fields.getStringSelectValues("profile_elements");
      draft.profileElements = values.filter((value): value is UserProfileElement =>
        (PROFILE_ELEMENTS as readonly string[]).includes(value)
      );
    }
    if (draft.flow === "guild_urf") {
      if (draft.guildIdOrInviteCode === undefined) {
        draft.guildIdOrInviteCode = interaction.fields.getTextInputValue("guild_target").trim();
      }
      const values = interaction.fields.getStringSelectValues("guild_elements");
      draft.guildElements = values.filter((value): value is GuildElement =>
        (GUILD_ELEMENTS as readonly string[]).includes(value)
      );
    }
    await interaction.deferReply({ flags: EPHEMERAL });
    await interaction.editReply({
      embeds: [
        infoEmbed(
          "Researching and writing report",
          "Grok is choosing the applicable country when needed, researching the law, and preparing a concise report."
        )
      ],
      components: []
    });
    if (draft.flow === "message_urf" && draft.messageUrl && !draft.messageSnapshot) {
      const snapshot = await this.messageResolver.resolve(draft.messageUrl);
      if (snapshot) draft.messageSnapshot = snapshot;
    }
    if (draft.flow === "guild_urf") {
      if (draft.guildIdOrInviteCode) {
        const snapshot = await this.serverResolver.resolve(
          draft.guildIdOrInviteCode,
          interaction.guild
        );
        if (snapshot) draft.serverSnapshot = snapshot;
      }
    }
    delete draft.context;
    delete draft.writerConversation;
    delete draft.legalResearch;
    await this.replaceDraft(interaction.user.id, draftId, draft);
    try {
      const result = await this.reportWriter.generate(
        draft,
        this.aiActor(interaction.user.id)
      );
      draft.country = result.country;
      draft.legalResearch = result.legalResearch;
      draft.context = result.report;
      draft.writerConversation = result.conversation;
      await this.replaceDraft(interaction.user.id, draftId, draft);
      await interaction.editReply({
        ...buildReview(draftId, draft),
        allowedMentions: { parse: [] }
      });
    } catch (error) {
      await interaction.editReply({
        ...buildWriterFailure(draftId, conciseError(error), "regenerate", false),
        allowedMentions: { parse: [] }
      });
    }
  }

  private async handleSelect(interaction: StringSelectMenuInteraction): Promise<void> {
    const [scope, action, draftId] = customParts(interaction.customId);
    if (scope !== "country" || action !== "select" || !draftId) return;
    const country = interaction.values[0];
    if (!country || (country !== "AUTO" && !this.countries.includes(country))) {
      throw new AccessError("invalid_country", "Choose a supported country.");
    }
    const draft = await this.loadDraft(interaction.user.id, draftId);
    if (country === "AUTO") {
      delete draft.country;
      draft.countrySelection = "auto";
    } else {
      draft.country = country;
      draft.countrySelection = "override";
    }
    delete draft.context;
    delete draft.writerConversation;
    delete draft.legalResearch;
    await this.replaceDraft(interaction.user.id, draftId, draft);
    if (!draft.reportType || !draft.reportBrief) {
      await interaction.showModal(buildReportModal(draftId, draft));
      return;
    }
    await interaction.deferUpdate();
    await interaction.editReply({
      embeds: [
        infoEmbed(
          "Researching new country",
          "Grok is researching a relevant law and rewriting the report."
        )
      ],
      components: []
    });
    try {
      const result = await this.reportWriter.generate(
        draft,
        this.aiActor(interaction.user.id)
      );
      draft.country = result.country;
      draft.legalResearch = result.legalResearch;
      draft.context = result.report;
      draft.writerConversation = result.conversation;
      await this.replaceDraft(interaction.user.id, draftId, draft);
      await interaction.editReply({
        ...buildReview(draftId, draft),
        allowedMentions: { parse: [] }
      });
    } catch (error) {
      await interaction.editReply({
        ...buildWriterFailure(draftId, conciseError(error), "regenerate", false),
        allowedMentions: { parse: [] }
      });
    }
  }

  private async handleButton(interaction: ButtonInteraction): Promise<void> {
    const parts = customParts(interaction.customId);
    if (parts[0] === "reports" && parts[1] === "retry" && parts[2]) {
      await interaction.deferUpdate();
      const retried = await this.retryAsNewReport(parts[2], interaction.id, interaction.user.id);
      await interaction.editReply({
        content: null,
        embeds: [reportEmbed(retried, await this.snapshotFor(retried, interaction.user.id))],
        components: reportRetryComponents(retried),
        allowedMentions: { parse: [] }
      });
      return;
    }
    if (parts[0] === "reports" && parts[1] === "page" && parts[2]) {
      const requestedPage = Number(parts[2]);
      if (!Number.isInteger(requestedPage)) return;
      await interaction.deferUpdate();
      await interaction.editReply({
        ...(await this.reportPage(interaction.user.id, requestedPage)),
        allowedMentions: { parse: [] }
      });
      return;
    }
    if (parts[0] === "profile" && parts[1] && parts[2]) {
      const action = parts[1];
      const draftId = parts[2];
      const draft = await this.loadDraft(interaction.user.id, draftId);
      if (draft.flow !== "user_urf" || !draft.profileTargetRaw) return;
      if (action === "retry") {
        await interaction.deferUpdate();
        const resolved = await this.profileResolver.resolve(
          draft.profileTargetRaw,
          draft.reportedUserServerId,
          interaction.guild
        );
        if (resolved) {
          draft.reportedUsername = resolved.username;
          draft.reportedUserId = resolved.userId;
          draft.reportedUserSnapshot = resolved;
          await this.replaceDraft(interaction.user.id, draftId, draft);
        }
        await interaction.editReply({
          ...buildProfileTargetConfirmation(draftId, draft),
          allowedMentions: { parse: [] }
        });
        return;
      }
      if (action === "continue") {
        if (!draft.reportedUserSnapshot || !draft.reportedUserId) {
          throw new AccessError("user_not_resolved", "Try resolving that user ID again.");
        }
        draft.reportedUsername = draft.reportedUserSnapshot.username;
      } else {
        return;
      }
      await this.replaceDraft(interaction.user.id, draftId, draft);
      await interaction.showModal(buildReportModal(draftId, draft));
      return;
    }
    if (parts[0] === "country" && parts[1] === "page" && parts[2] && parts[3]) {
      await this.loadDraft(interaction.user.id, parts[2]);
      await interaction.update(buildCountryPicker(this.countries, parts[2], Number(parts[3])));
      return;
    }
    if (parts[0] !== "draft" || !parts[1] || !parts[2]) return;
    const action = parts[1];
    const draftId = parts[2];
    if (action === "cancel") {
      await this.database.deleteDraft(interaction.user.id, draftId);
      await interaction.update({
        content: null,
        embeds: [infoEmbed("Report cancelled", "The temporary encrypted draft has been deleted.")],
        components: []
      });
      return;
    }
    const draft = await this.loadDraft(interaction.user.id, draftId);
    if (action === "edit") {
      await interaction.showModal(buildManualReportModal(draftId, draft));
      return;
    }
    if (action === "country") {
      await interaction.update(buildCountryPicker(this.countries, draftId, 0));
      return;
    }
    if (action === "brief") {
      await interaction.showModal(buildReportModal(draftId, draft));
      return;
    }
    if (action === "refine") {
      await interaction.showModal(buildRefinementModal(draftId));
      return;
    }
    if (action === "regenerate") {
      await interaction.deferUpdate();
      await interaction.editReply({
        embeds: [
          infoEmbed(
            "Rewriting report",
            "Grok is rerunning country research and starting a fresh writing conversation."
          )
        ],
        components: []
      });
      try {
        const result = await this.reportWriter.generate(
          draft,
          this.aiActor(interaction.user.id)
        );
        draft.country = result.country;
        draft.legalResearch = result.legalResearch;
        draft.context = result.report;
        draft.writerConversation = result.conversation;
        await this.replaceDraft(interaction.user.id, draftId, draft);
        await interaction.editReply({
          ...buildReview(draftId, draft),
          allowedMentions: { parse: [] }
        });
      } catch (error) {
        await interaction.editReply({
          ...buildWriterFailure(
            draftId,
            conciseError(error),
            "regenerate",
            Boolean(draft.legalResearch)
          ),
          allowedMentions: { parse: [] }
        });
      }
      return;
    }
    if (action === "submit") {
      await this.submitDraft(interaction, draftId, draft);
    }
  }

  private async submitDraft(
    interaction: ButtonInteraction,
    draftId: string,
    draft: ReportDraft
  ): Promise<void> {
    await interaction.deferUpdate();
    let tracking: Awaited<ReturnType<BotDatabase["reserveSubmission"]>> | undefined;
    try {
      await this.requireReportAccess(interaction.user.id);
      const request = draftToCreateInput(draft, interaction.user.id);
      const isAdmin = this.isAdmin(interaction.user.id);
      const creditBypassReason = isAdmin
        ? "administrator"
        : !this.config.whitelistEnabled
          ? "whitelist_disabled"
          : "none";
      tracking = await this.database.reserveSubmission({
        draftId,
        userId: interaction.user.id,
        interactionId: interaction.id,
        flow: request.flow,
        country: request.country,
        reportType: request.reportType,
        encryptedRequest: encryptJson(request, this.config.dataEncryptionKey),
        ...(draft.serverSnapshot ? { serverSnapshot: draft.serverSnapshot } : {}),
        adminBypass: shouldBypassReportCredits(
          isAdmin,
          this.config.whitelistEnabled
        )
      });
      botLog("report_submission_reserved", {
        trackingId: tracking.id,
        flow: request.flow,
        country: request.country,
        creditState: tracking.creditState,
        creditBypassReason,
        reservationReplayed: tracking.replayed,
        creditBalanceBefore: tracking.balanceBefore,
        creditBalanceAfter: tracking.balanceAfter
      });
      await interaction.editReply({
        content: null,
        embeds: [
          infoEmbed(
            "Submitting report",
            "Your report is being prepared and sent securely. This may take a moment."
          )
        ],
        components: []
      });
      let report = await this.api.createReport(tracking.interactionId, request);
      const creditStateAfterCreation = await this.database.markSubmissionCreated(
        tracking.id,
        report
      );
      botLog("report_submission_created", {
        trackingId: tracking.id,
        reportId: report.internalReportId,
        status: report.status,
        creditState: creditStateAfterCreation
      });
      await this.database.deleteDraft(interaction.user.id, draftId);
      for (let attempt = 0; attempt < 5; attempt += 1) {
        if (report.status === "submitted" || report.status === "failed") break;
        await delay(2_000);
        report = await this.api.report(report.internalReportId);
      }
      await this.database.observeReport(tracking.id, report);
      botLog("report_submission_observed", {
        trackingId: tracking.id,
        reportId: report.internalReportId,
        status: report.status,
        discordStatus: report.discordStatus
      });
      await interaction.editReply({
        content: null,
        embeds: [reportEmbed(report, draft.serverSnapshot)],
        components: reportRetryComponents(report),
        allowedMentions: { parse: [] }
      });
    } catch (error) {
      botLog(
        "report_submission_failed",
        {
          ...(tracking ? { trackingId: tracking.id, creditState: tracking.creditState } : {}),
          ...errorFields(error)
        },
        "error"
      );
      if (tracking && isDefinitePreCreationError(error)) {
        await this.database.releaseReservation(tracking.id, "report_rejected");
      }
      await interaction.editReply({
        content: null,
        embeds: [
          errorEmbed(
            `${conciseError(error)}\n\nYour submission identity has been preserved and the bot will reconcile it safely.`
          )
        ],
        components: [],
        allowedMentions: { parse: [] }
      });
    }
  }

  private async respondWithError(interaction: Interaction, error: unknown): Promise<void> {
    if (!interaction.isRepliable()) return;
    const embeds = [errorEmbed(conciseError(error))];
    if (interaction.isButton() || interaction.isStringSelectMenu()) {
      const payload = {
        content: null,
        embeds,
        components: [],
        allowedMentions: { parse: [] as never[] }
      };
      if (interaction.deferred) {
        await interaction.editReply(payload);
      } else if (!interaction.replied) {
        await interaction.update(payload);
      } else {
        await interaction.followUp({ embeds, flags: EPHEMERAL, allowedMentions: { parse: [] } });
      }
      return;
    }
    if (interaction.deferred || interaction.replied) {
      await interaction.followUp({ embeds, flags: EPHEMERAL, allowedMentions: { parse: [] } });
    } else {
      await interaction.reply({ embeds, flags: EPHEMERAL, allowedMentions: { parse: [] } });
    }
  }
}
