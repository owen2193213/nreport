import {
  DsaAdminApi,
  DsaApi,
  DsaApiError,
  type CreateReportInput,
  type ReportDetail,
  type ReportTarget
} from "@discord-dsa/contracts";
import {
  ActionRowBuilder,
  EmbedBuilder,
  MessageFlags,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ChatInputCommandInteraction,
  type Client,
  type Interaction,
  type MessageContextMenuCommandInteraction,
  type ModalSubmitInteraction
} from "discord.js";

import { ConnectionConflictError, type AccountBotDatabase, type ApiConnection } from "./account-database.js";
import type { BotConfig } from "./config.js";
import { decryptJson, encryptJson } from "./crypto.js";
import { capturedMessageEvidence, resolvedMessageEvidence, unavailableMessageEvidence, type MessageResolver } from "./message-resolver.js";
import type { ProfileResolver } from "./profile-resolver.js";

interface Dependencies {
  client: Client;
  config: BotConfig;
  database: AccountBotDatabase;
  messageResolver: MessageResolver;
  profileResolver: ProfileResolver;
}

type PendingTarget =
  | { flow: "message"; messageUrl: string; evidence?: ReturnType<typeof capturedMessageEvidence> }
  | { flow: "profile"; userId: string; serverId?: string }
  | { flow: "server"; serverOrInvite: string };

export class AccountInteractionHandler {
  private readonly adminApi: DsaAdminApi;

  public constructor(private readonly dependencies: Dependencies) {
    this.adminApi = new DsaAdminApi({ baseUrl: dependencies.config.apiBaseUrl, adminKey: dependencies.config.adminApiKey });
  }

  public async handle(interaction: Interaction): Promise<void> {
    try {
      if (interaction.isModalSubmit()) await this.modal(interaction);
      else if (interaction.isMessageContextMenuCommand()) await this.contextMenu(interaction);
      else if (interaction.isChatInputCommand()) await this.command(interaction);
    } catch (error) {
      await this.error(interaction, error);
    }
  }

  private async command(interaction: ChatInputCommandInteraction): Promise<void> {
    if (interaction.commandName === "access") await this.access(interaction);
    else if (interaction.commandName === "report") await this.reportCommand(interaction);
    else if (interaction.commandName === "reports") await this.reports(interaction);
    else if (interaction.commandName === "analytics") await this.analytics(interaction);
    else if (interaction.commandName === "settings") await this.settings(interaction);
    else if (interaction.commandName === "admin") await this.admin(interaction);
  }

  private async access(interaction: ChatInputCommandInteraction): Promise<void> {
    const action = interaction.options.getSubcommand();
    if (action === "connect") {
      const modal = new ModalBuilder().setCustomId("access:connect").setTitle("Connect reporting account")
        .addComponents(row(new TextInputBuilder().setCustomId("api-key").setLabel("Personal API key").setStyle(TextInputStyle.Short).setRequired(true).setMinLength(60).setMaxLength(150)));
      await interaction.showModal(modal);
      return;
    }
    if (action === "disconnect") {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const disconnected = await this.dependencies.database.disconnect(interaction.user.id);
      await interaction.editReply(disconnected ? "Disconnected. Future background updates are stopped." : "No API account was connected.");
      return;
    }
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const connection = await this.dependencies.database.connection(interaction.user.id);
    if (connection === null) {
      await interaction.editReply("No API account is connected. Use `/access connect`.");
      return;
    }
    const account = await this.api(connection).account();
    await interaction.editReply(
      `Connected as **${account.username}** (${account.keyPrefix})\nCredits: ${account.availableCredits} available, ${account.reservedCredits} reserved\nAI usage: ${account.usage.aiRequests} requests, ${account.usage.inputTokens + account.usage.outputTokens} tokens, ${account.usage.searchRequests} searches`
    );
  }

  private async modal(interaction: ModalSubmitInteraction): Promise<void> {
    if (interaction.customId === "access:connect") {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const apiKey = interaction.fields.getTextInputValue("api-key").trim();
      const api = new DsaApi({ baseUrl: this.dependencies.config.apiBaseUrl, apiKey });
      const account = await api.account();
      await this.dependencies.database.connectAccount(
        interaction.user.id,
        account,
        encryptJson(apiKey, this.dependencies.config.dataEncryptionKey)
      );
      await interaction.editReply(`Connected as **${account.username}**. You have ${account.availableCredits} report credits.`);
      return;
    }
    if (!interaction.customId.startsWith("report:")) return;
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const [, pendingId, aiFlag] = interaction.customId.split(":");
    if (pendingId === undefined) throw new UserFacingError("Report form is invalid.");
    const encrypted = await this.dependencies.database.pendingForm(pendingId, interaction.user.id);
    if (encrypted === null) throw new UserFacingError("This report form expired. Start again.");
    const pending = decryptJson<PendingTarget>(encrypted, this.dependencies.config.dataEncryptionKey);
    const useAi = aiFlag === "ai";
    const input = await this.createInput(interaction, pending, useAi);
    await this.submit(interaction, input, `create:${interaction.id}`, pendingId);
  }

  private async reportCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    const flow = interaction.options.getSubcommand();
    const useAi = interaction.options.getBoolean("use-ai") ?? true;
    let pending: PendingTarget;
    if (flow === "message") {
      pending = { flow, messageUrl: interaction.options.getString("message-link", true) };
    } else if (flow === "profile") {
      const serverId = interaction.options.getString("server-id") ?? undefined;
      pending = { flow, userId: interaction.options.getString("target", true), ...(serverId === undefined ? {} : { serverId }) };
    } else {
      pending = { flow: "server", serverOrInvite: interaction.options.getString("server-or-invite") ?? interaction.guildId ?? "" };
    }
    await this.showReportModal(interaction, pending, useAi);
  }

  private async contextMenu(interaction: MessageContextMenuCommandInteraction): Promise<void> {
    const pending: PendingTarget = {
      flow: "message",
      messageUrl: interaction.targetMessage.url,
      evidence: capturedMessageEvidence(interaction.targetMessage, "context_menu")
    };
    if (interaction.commandName === "Quick Report Message") {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      await this.submit(interaction, {
        flow: "message",
        useAi: true,
        target: { messageUrl: pending.messageUrl, ...(pending.evidence === undefined ? {} : { messageEvidence: pending.evidence }) }
      }, `create:${interaction.id}`);
    } else await this.showReportModal(interaction, pending, true);
  }

  private async showReportModal(
    interaction: ChatInputCommandInteraction | MessageContextMenuCommandInteraction,
    pending: PendingTarget,
    useAi: boolean
  ): Promise<void> {
    const pendingId = await this.dependencies.database.savePendingForm(
      interaction.user.id,
      encryptJson(pending, this.dependencies.config.dataEncryptionKey)
    );
    const modal = new ModalBuilder().setCustomId(`report:${pendingId}:${useAi ? "ai" : "manual"}`)
      .setTitle(useAi ? "Submit automatic report" : "Submit manual report");
    modal.addComponents(
      row(field("country", "Country code", !useAi, 2, 2)),
      row(field("category", "Report category", !useAi, 1, 100)),
      row(field("description", "Evidence or guidance", false, 1, 1_000, TextInputStyle.Paragraph))
    );
    if (!useAi) modal.addComponents(row(field("final-text", "Final report text", true, 1, 512, TextInputStyle.Paragraph)));
    await interaction.showModal(modal);
  }

  private async createInput(interaction: ModalSubmitInteraction, pending: PendingTarget, useAi: boolean): Promise<CreateReportInput> {
    const country = optionalField(interaction, "country")?.toUpperCase();
    const category = optionalField(interaction, "category");
    const description = optionalField(interaction, "description");
    let target: ReportTarget;
    if (pending.flow === "message") {
      const evidence = pending.evidence ?? await this.dependencies.messageResolver.resolve(pending.messageUrl)
        .then((snapshot) => snapshot === null ? unavailableMessageEvidence() : resolvedMessageEvidence(snapshot));
      target = { messageUrl: pending.messageUrl, ...(evidence === undefined ? {} : { messageEvidence: evidence }) };
    } else if (pending.flow === "profile") {
      const snapshot = await this.dependencies.profileResolver.resolve(pending.userId);
      if (snapshot === null) throw new UserFacingError("That Discord profile could not be resolved.");
      target = {
        reportedUsername: snapshot.username,
        reportedUserId: pending.userId,
        reportedUserSnapshot: snapshot,
        profileElements: ["photos", "name", "descriptors"],
        ...(pending.serverId === undefined ? {} : { reportedUserServerId: pending.serverId })
      };
    } else {
      if (!pending.serverOrInvite) throw new UserFacingError("A server ID or invite is required.");
      target = { guildIdOrInviteCode: pending.serverOrInvite, guildElements: ["name", "icon", "banner", "invite_splash", "discovery_splash", "welcome_screen_description", "channel_names", "other"] };
    }
    if (useAi) {
      return { flow: pending.flow, useAi: true, target, ...(country ? { country } : {}), ...(category ? { category } : {}), ...(description ? { description } : {}) };
    }
    const finalText = interaction.fields.getTextInputValue("final-text").trim();
    if (!country || !category || !finalText) throw new UserFacingError("Country, category, and final report text are required in manual mode.");
    return { flow: pending.flow, useAi: false, target, country, category, finalText, ...(description ? { description } : {}) };
  }

  private async submit(
    interaction: ModalSubmitInteraction | MessageContextMenuCommandInteraction,
    input: CreateReportInput,
    idempotencyKey: string,
    pendingId?: string
  ): Promise<void> {
    const connection = await this.requiredConnection(interaction.user.id);
    const linkId = await this.dependencies.database.beginReportLink(
      interaction.user.id,
      connection.account_id,
      idempotencyKey,
      encryptJson(input, this.dependencies.config.dataEncryptionKey)
    );
    let report: ReportDetail;
    try {
      report = await this.api(connection).createReport(idempotencyKey, input);
    } catch (error) {
      if (error instanceof DsaApiError && error.status < 500) await this.dependencies.database.abandonReportLink(linkId);
      throw error;
    }
    await this.dependencies.database.completeReportLink(linkId, report.reportId);
    if (pendingId !== undefined) await this.dependencies.database.deletePendingForm(pendingId, interaction.user.id);
    let dmWarning = "";
    if (await this.dependencies.database.claimDmCard(report.reportId)) {
      try {
        const message = await interaction.user.send({ embeds: [statusEmbed(report)] });
        await this.dependencies.database.setDmMapping(report.reportId, message.channelId, message.id);
      } catch (error) {
        await this.dependencies.database.releaseDmCard(report.reportId);
        const code = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
        dmWarning = code === 50007
          ? " I could not send the private status card; use `/reports status` to follow it."
          : " The report continues, but its private status card could not be created; use `/reports status`.";
      }
    } else {
      dmWarning = " Your private status card is being created.";
    }
    await interaction.editReply(`Report **${report.reportId}** is queued.${dmWarning}`);
  }

  private async reports(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const connection = await this.requiredConnection(interaction.user.id);
    const api = this.api(connection);
    const action = interaction.options.getSubcommand();
    if (action === "list") {
      const page = await api.reports({ limit: 10 });
      await interaction.editReply(page.items.length === 0 ? "No reports yet." : page.items.map((report) => `• ${report.reportId} — ${report.status}`).join("\n"));
    } else if (action === "status") {
      const report = await api.report(interaction.options.getString("report-id", true));
      await interaction.editReply({ embeds: [statusEmbed(report)] });
    } else {
      const reportId = interaction.options.getString("report-id", true);
      const mode = interaction.options.getString("mode", true) as "reuse" | "regenerate";
      const idempotencyKey = `retry:${interaction.id}`;
      const linkId = await this.dependencies.database.beginReportLink(interaction.user.id, connection.account_id, idempotencyKey, encryptJson({ reportId, mode }, this.dependencies.config.dataEncryptionKey));
      let report: ReportDetail;
      try {
        report = await api.retryReport(reportId, idempotencyKey, mode);
      } catch (error) {
        if (error instanceof DsaApiError && error.status < 500) await this.dependencies.database.abandonReportLink(linkId);
        throw error;
      }
      await this.dependencies.database.completeReportLink(linkId, report.reportId);
      let warning = "";
      if (await this.dependencies.database.claimDmCard(report.reportId)) {
        try {
          const message = await interaction.user.send({ embeds: [statusEmbed(report)] });
          await this.dependencies.database.setDmMapping(report.reportId, message.channelId, message.id);
        } catch {
          await this.dependencies.database.releaseDmCard(report.reportId);
          warning = " I could not create the DM status card; use `/reports status`.";
        }
      } else {
        warning = " Your private status card is being created.";
      }
      await interaction.editReply(`Retry **${report.reportId}** is queued.${warning}`);
    }
  }

  private async analytics(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const connection = await this.requiredConnection(interaction.user.id);
    const period = (interaction.options.getString("period") ?? "30d") as "24h" | "7d" | "30d" | "ytd" | "365d" | "all";
    const community = interaction.options.getBoolean("community") ?? false;
    const data = community ? await this.api(connection).communityAnalytics(period) : await this.api(connection).analytics({ period });
    await interaction.editReply(data.availability === "insufficient_community_data"
      ? "Community analytics are hidden until the privacy threshold is met."
      : `Reports: ${data.volume.newCases} cases / ${data.volume.attempts} attempts\nSubmitted: ${data.volume.sentAttempts}\nAction rate: ${data.rates.action.percentage ?? "—"}%`);
  }

  private async settings(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    await this.requiredConnection(interaction.user.id);
    const preferences = await this.dependencies.database.updateNotificationPreferences(interaction.user.id, {
      ...(interaction.options.getBoolean("lifecycle") === null ? {} : { lifecycleEnabled: interaction.options.getBoolean("lifecycle")! }),
      ...(interaction.options.getBoolean("daily-digest") === null ? {} : { dailyDigest: interaction.options.getBoolean("daily-digest")! }),
      ...(interaction.options.getBoolean("weekly-digest") === null ? {} : { weeklyDigest: interaction.options.getBoolean("weekly-digest")! })
    });
    await interaction.editReply(`Lifecycle DMs: ${preferences.lifecycleEnabled ? "on" : "off"}; daily digest: ${preferences.dailyDigest ? "on" : "off"}; weekly digest: ${preferences.weeklyDigest ? "on" : "off"}.`);
  }

  private async admin(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!this.dependencies.config.adminUserIds.has(interaction.user.id)) throw new UserFacingError("Administrator access is required.");
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const action = interaction.options.getSubcommand();
    if (action === "account-create") {
      const account = await this.adminApi.createAccount({
        username: interaction.options.getString("username", true),
        initialCredits: interaction.options.getInteger("credits") ?? 0
      });
      await interaction.editReply(`Created **${account.username}** (${account.accountId}).`);
    } else if (action === "key-issue" || action === "key-rotate") {
      const accountId = interaction.options.getString("account-id", true);
      const issued = action === "key-issue" ? await this.adminApi.issueKey(accountId) : await this.adminApi.rotateKey(accountId);
      await interaction.editReply(`One-time API key for ${accountId}:\n\`${issued.apiKey}\``);
    } else if (action === "credits") {
      const account = await this.adminApi.adjustCredits(
        interaction.options.getString("account-id", true),
        interaction.options.getInteger("delta", true),
        interaction.options.getString("reason", true)
      );
      await interaction.editReply(`Balance updated: ${account.availableCredits} available credits.`);
    } else {
      const accountId = interaction.options.getString("account-id", true);
      const reason = interaction.options.getString("reason", true);
      const account = action === "suspend" ? await this.adminApi.suspendAccount(accountId, reason) : await this.adminApi.reinstateAccount(accountId, reason);
      await interaction.editReply(`Account ${account.accountId} is now ${account.status}.`);
    }
  }

  private async requiredConnection(discordUserId: string): Promise<ApiConnection> {
    const connection = await this.dependencies.database.connection(discordUserId);
    if (connection === null) throw new UserFacingError("Connect your personal API key with `/access connect` first.");
    return connection;
  }

  private api(connection: ApiConnection): DsaApi {
    return new DsaApi({
      baseUrl: this.dependencies.config.apiBaseUrl,
      apiKey: decryptJson<string>(connection.encrypted_api_key, this.dependencies.config.dataEncryptionKey)
    });
  }

  private async error(interaction: Interaction, error: unknown): Promise<void> {
    const message = error instanceof DsaApiError && error.status === 401
      ? "Your API key is no longer valid. Use `/access connect` with the current key."
      : error instanceof DsaApiError || error instanceof UserFacingError || error instanceof ConnectionConflictError
        ? error.message
        : "The request failed. Please try again.";
    if (!interaction.isRepliable()) return;
    if (interaction.deferred || interaction.replied) await interaction.editReply({ content: message, embeds: [] }).catch(() => undefined);
    else await interaction.reply({ content: message, flags: MessageFlags.Ephemeral }).catch(() => undefined);
  }
}

class UserFacingError extends Error {}

function row(input: TextInputBuilder): ActionRowBuilder<TextInputBuilder> {
  return new ActionRowBuilder<TextInputBuilder>().addComponents(input);
}

function field(
  id: string,
  label: string,
  required: boolean,
  minimum: number,
  maximum: number,
  style = TextInputStyle.Short
): TextInputBuilder {
  return new TextInputBuilder().setCustomId(id).setLabel(label).setStyle(style).setRequired(required).setMinLength(minimum).setMaxLength(maximum);
}

function optionalField(interaction: ModalSubmitInteraction, id: string): string | undefined {
  const value = interaction.fields.getTextInputValue(id).trim();
  return value.length === 0 ? undefined : value;
}

export function statusEmbed(report: ReportDetail): EmbedBuilder {
  const description = report.failure === null ? lifecycleDescription(report) : `${report.failure.message} (${report.failure.code})`;
  return new EmbedBuilder()
    .setTitle(`DSA report · ${titleCase(report.status)}`)
    .setDescription(description)
    .addFields(
      { name: "Report ID", value: report.reportId },
      { name: "Flow", value: report.flow, inline: true },
      { name: "Credit", value: report.creditState, inline: true }
    )
    .setTimestamp(new Date(report.updatedAt));
}

function lifecycleDescription(report: ReportDetail): string {
  if (report.discordStatus === "actioned") return "Discord actioned the report.";
  if (report.discordStatus === "closed_no_action") return report.reviewStatus === "requested" || report.reviewStatus === "received"
    ? "Discord closed the report; the automatic appeal is in progress."
    : "Discord closed the report without action.";
  if (report.discordStatus === "review_not_approved") return "Discord denied the automatic appeal.";
  return report.status === "queued" ? "Queued for API preparation."
    : report.status === "planning" ? "Planning the report."
      : report.status === "researching" ? "Researching applicable context and law."
        : report.status === "writing" ? "Writing the final report."
          : report.status === "submitted" ? "Submitted to Discord; waiting for a decision."
            : "The API is processing this report.";
}

function titleCase(value: string): string {
  return value.replaceAll("_", " ").replace(/\b\w/g, (character) => character.toUpperCase());
}
