import { setTimeout as delay } from "node:timers/promises";

import {
  DsaApiError,
  GUILD_ELEMENTS,
  PROFILE_ELEMENTS
} from "@discord-dsa/contracts";
import type {
  DsaApi,
  GuildElement,
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
import { decryptJson, encryptJson, generateAccessKey, hashAccessKey } from "./crypto.js";
import { AccessError } from "./database.js";
import type { BotDatabase } from "./database.js";
import type { ReportDraft } from "./types.js";
import {
  buildCountryPicker,
  buildReportModal,
  buildReview,
  draftToCreateInput,
  renderAccess,
  renderReport
} from "./ui.js";

const EPHEMERAL = MessageFlags.Ephemeral;
const SNOWFLAKE = /^\d{15,22}$/;

export interface InteractionHandlerOptions {
  api: DsaApi;
  config: BotConfig;
  countries: readonly string[];
  database: BotDatabase;
}

function conciseError(error: unknown): string {
  if (error instanceof AccessError || error instanceof DsaApiError) return error.message;
  if (error instanceof Error) return error.message;
  return "An unexpected error occurred.";
}

function isDefinitePreCreationError(error: unknown): boolean {
  return error instanceof DsaApiError && error.status < 500 && error.status !== 409;
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

export class InteractionHandler {
  private readonly api: DsaApi;
  private readonly config: BotConfig;
  private readonly countries: readonly string[];
  private readonly database: BotDatabase;

  public constructor(options: InteractionHandlerOptions) {
    this.api = options.api;
    this.config = options.config;
    this.countries = options.countries;
    this.database = options.database;
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
      await this.respondWithError(interaction, error);
    }
  }

  private isAdmin(userId: string): boolean {
    return this.config.adminUserIds.has(userId);
  }

  private async requireReportAccess(userId: string): Promise<void> {
    if (this.isAdmin(userId) || !this.config.whitelistEnabled) return;
    const access = await this.database.getAccess(userId);
    if (access.suspended) {
      throw new AccessError("user_suspended", "Your reporting access is suspended. Contact an admin.");
    }
    if (access.credits < 1) {
      throw new AccessError("no_credits", "You need a report credit. Use `/access redeem` with a valid key.");
    }
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
    await this.requireReportAccess(interaction.user.id);
    const access = await this.database.getAccess(interaction.user.id);
    if (draft.country === undefined && access.defaultCountry !== null) {
      draft.country = access.defaultCountry;
    }
    const draftId = await this.saveDraft(interaction.user.id, draft);
    if (draft.country === undefined) {
      await interaction.reply({ ...buildCountryPicker(this.countries, draftId, 0), flags: EPHEMERAL });
      return;
    }
    await interaction.showModal(buildReportModal(draftId, draft));
  }

  private async handleMessageContext(
    interaction: MessageContextMenuCommandInteraction
  ): Promise<void> {
    if (interaction.commandName !== "Report Message") return;
    await this.startDraft(interaction, {
      flow: "message_urf",
      messageUrl: interaction.targetMessage.url
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
    if (subcommand === "message") {
      const messageUrl = interaction.options.getString("message-link")?.trim();
      await this.startDraft(interaction, {
        flow: "message_urf",
        ...(messageUrl ? { messageUrl } : {})
      });
      return;
    }
    if (subcommand === "profile") {
      const username = interaction.options.getString("username", true).trim();
      const serverId = interaction.options.getString("server-id")?.trim();
      if (serverId && !SNOWFLAKE.test(serverId)) {
        throw new AccessError("invalid_server_id", "Server ID must be a Discord snowflake.");
      }
      await this.startDraft(interaction, {
        flow: "user_urf",
        reportedUsername: username,
        ...(serverId ? { reportedUserServerId: serverId } : {})
      });
      return;
    }
    const suppliedTarget = interaction.options.getString("server-or-invite")?.trim();
    const guildTarget = interaction.guildId ?? undefined;
    const target = suppliedTarget || guildTarget;
    await this.startDraft(interaction, {
      flow: "guild_urf",
      ...(target ? { guildIdOrInviteCode: target } : {})
    });
  }

  private async handleReportsCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    const subcommand = interaction.options.getSubcommand();
    await interaction.deferReply({ flags: EPHEMERAL });
    if (subcommand === "list") {
      const { reports } = await this.api.reportsFor(interaction.user.id);
      const content =
        reports.length === 0
          ? "You have no reports."
          : reports
              .slice(0, 10)
              .map((report) =>
                `${report.internalReportId} — ${report.status}/${report.discordStatus ?? "pending"}`
              )
              .join("\n");
      await interaction.editReply({ content, allowedMentions: { parse: [] } });
      return;
    }
    const reportId = interaction.options.getString("report-id", true);
    const report = await this.api.report(reportId);
    this.assertOwner(report, interaction.user.id);
    if (subcommand === "status") {
      await interaction.editReply({ content: renderReport(report), allowedMentions: { parse: [] } });
      return;
    }
    await this.requireReportAccess(interaction.user.id);
    if (!(report.status === "failed" && report.retryable && report.lifecycleAttempt < 3)) {
      throw new AccessError("not_retryable", "This report is not currently safe to retry.");
    }
    const retried = await this.api.retryReport(reportId, interaction.id, interaction.user.id);
    await this.database.resumeTrackingByReport(reportId, interaction.user.id, retried);
    await interaction.editReply({ content: renderReport(retried), allowedMentions: { parse: [] } });
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
        content: `Key redeemed. You now have ${access.credits} report credit(s).`,
        flags: EPHEMERAL,
        allowedMentions: { parse: [] }
      });
      return;
    }
    const access = await this.database.getAccess(interaction.user.id);
    await interaction.reply({
      content: renderAccess(access, this.isAdmin(interaction.user.id)),
      flags: EPHEMERAL,
      allowedMentions: { parse: [] }
    });
  }

  private async handleSettingsCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    const country = interaction.options.getString("country", true).toUpperCase();
    if (!this.countries.includes(country)) {
      throw new AccessError("invalid_country", "Choose a country returned by autocomplete.");
    }
    await this.database.setDefaultCountry(interaction.user.id, country);
    await interaction.reply({ content: `Default report country set to ${country}.`, flags: EPHEMERAL });
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
        content: [
          "These key values are shown once:",
          ...generated.map((key) => `${key.id} — ${key.code}`)
        ].join("\n"),
        flags: EPHEMERAL,
        allowedMentions: { parse: [] }
      });
      return;
    }
    if (subcommand === "list") {
      const keys = await this.database.listAccessKeys();
      await interaction.reply({
        content:
          keys.length === 0
            ? "No access keys exist."
            : keys
                .map(
                  (key) =>
                    `${key.id} — ${key.code_prefix} — ${key.credits_total} credits — ${key.status}`
                )
                .join("\n"),
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
        content: [
          `ID: ${key.id}`,
          `Prefix: ${key.code_prefix}`,
          `Credits: ${key.credits_total}`,
          `Status: ${key.status}`,
          `Expires: ${key.expires_at?.toISOString() ?? "never"}`,
          `Redeemed by: ${key.redeemed_by ?? "nobody"}`,
          `Revoked: ${key.revoked_at?.toISOString() ?? "no"}`
        ].join("\n"),
        flags: EPHEMERAL,
        allowedMentions: { parse: [] }
      });
      return;
    }
    const reason = interaction.options.getString("reason")?.trim() || "Revoked by administrator";
    await this.database.revokeAccessKey(keyId, interaction.user.id, reason);
    await interaction.reply({ content: `Revoked access key ${keyId}.`, flags: EPHEMERAL });
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
        content: `User ${userId}\n${renderAccess(access, this.isAdmin(userId))}`,
        flags: EPHEMERAL,
        allowedMentions: { parse: [] }
      });
      return;
    }
    if (subcommand === "suspend") {
      const reason = interaction.options.getString("reason")?.trim() || "Suspended by administrator";
      await this.database.suspendUser(userId, interaction.user.id, reason);
      await interaction.reply({ content: `Suspended user ${userId} and cleared their credits.`, flags: EPHEMERAL });
      return;
    }
    await this.database.reinstateUser(userId, interaction.user.id);
    await interaction.reply({ content: `Reinstated user ${userId} with zero credits.`, flags: EPHEMERAL });
  }

  private async handleAutocomplete(interaction: AutocompleteInteraction): Promise<void> {
    if (interaction.commandName !== "settings") return;
    const focused = interaction.options.getFocused().toUpperCase();
    await interaction.respond(
      this.countries
        .filter((country) => country.includes(focused))
        .slice(0, 25)
        .map((country) => ({ name: country, value: country }))
    );
  }

  private async handleModal(interaction: ModalSubmitInteraction): Promise<void> {
    const [scope, action, draftId] = customParts(interaction.customId);
    if (scope !== "report" || action !== "modal" || !draftId) return;
    const draft = await this.loadDraft(interaction.user.id, draftId);
    const reportType = interaction.fields.getStringSelectValues("report_type")[0];
    if (!reportType) throw new AccessError("invalid_reason", "Choose a report reason.");
    draft.reportType = reportType;
    draft.context = interaction.fields.getTextInputValue("context").trim();
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
    draftToCreateInput(draft, interaction.user.id);
    await this.replaceDraft(interaction.user.id, draftId, draft);
    await interaction.reply({
      ...buildReview(draftId, draft),
      flags: EPHEMERAL,
      allowedMentions: { parse: [] }
    });
  }

  private async handleSelect(interaction: StringSelectMenuInteraction): Promise<void> {
    const [scope, action, draftId] = customParts(interaction.customId);
    if (scope !== "country" || action !== "select" || !draftId) return;
    const country = interaction.values[0];
    if (!country || !this.countries.includes(country)) {
      throw new AccessError("invalid_country", "Choose a supported country.");
    }
    const draft = await this.loadDraft(interaction.user.id, draftId);
    draft.country = country;
    await this.replaceDraft(interaction.user.id, draftId, draft);
    if (draft.reportType && draft.context) {
      await interaction.update({ ...buildReview(draftId, draft), allowedMentions: { parse: [] } });
    } else {
      await interaction.showModal(buildReportModal(draftId, draft));
    }
  }

  private async handleButton(interaction: ButtonInteraction): Promise<void> {
    const parts = customParts(interaction.customId);
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
      await interaction.update({ content: "Report cancelled.", components: [] });
      return;
    }
    const draft = await this.loadDraft(interaction.user.id, draftId);
    if (action === "edit") {
      await interaction.showModal(buildReportModal(draftId, draft));
      return;
    }
    if (action === "country") {
      await interaction.update(buildCountryPicker(this.countries, draftId, 0));
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
    await this.requireReportAccess(interaction.user.id);
    const request = draftToCreateInput(draft, interaction.user.id);
    await interaction.deferUpdate();
    const tracking = await this.database.reserveSubmission({
      draftId,
      userId: interaction.user.id,
      interactionId: interaction.id,
      flow: request.flow,
      country: request.country,
      reportType: request.reportType,
      encryptedRequest: encryptJson(request, this.config.dataEncryptionKey),
      adminBypass: this.isAdmin(interaction.user.id) || !this.config.whitelistEnabled
    });
    await interaction.editReply({ content: "Submitting the report…", components: [] });
    try {
      let report = await this.api.createReport(tracking.interactionId, request);
      await this.database.markSubmissionCreated(tracking.id, report);
      await this.database.deleteDraft(interaction.user.id, draftId);
      for (let attempt = 0; attempt < 5; attempt += 1) {
        if (report.status === "submitted" || report.status === "failed") break;
        await delay(2_000);
        report = await this.api.report(report.internalReportId);
      }
      await this.database.observeReport(tracking.id, report);
      await interaction.editReply({
        content: renderReport(report),
        components: [],
        allowedMentions: { parse: [] }
      });
    } catch (error) {
      if (isDefinitePreCreationError(error)) {
        await this.database.releaseReservation(tracking.id, "report_rejected");
      }
      await interaction.editReply({
        content: `The report could not be confirmed yet: ${conciseError(error)}\nYour idempotency key has been preserved.`,
        components: [],
        allowedMentions: { parse: [] }
      });
    }
  }

  private async respondWithError(interaction: Interaction, error: unknown): Promise<void> {
    if (!interaction.isRepliable()) return;
    const content = `Unable to complete that action: ${conciseError(error)}`.slice(0, 1900);
    if (interaction.deferred || interaction.replied) {
      await interaction.followUp({ content, flags: EPHEMERAL, allowedMentions: { parse: [] } });
    } else {
      await interaction.reply({ content, flags: EPHEMERAL, allowedMentions: { parse: [] } });
    }
  }
}
