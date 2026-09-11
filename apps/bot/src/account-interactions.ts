import {
  DsaAdminApi,
  DsaApi,
  DsaApiError,
  type CreateReportInput,
  type ReportDetail,
  type MessageEvidence,
  type ReportTarget,
  type ReportedMessageSnapshot,
  type RetryReportInput
} from "@nreport/contracts";
import {
  ActionRowBuilder,
  MessageFlags,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ChatInputCommandInteraction,
  type ButtonInteraction,
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
import type { ServerResolver } from "./server-resolver.js";
import {
  buildManualRetryModal,
  buildReportModal,
  parseReportModalValues,
  statusMessageOptions,
  targetContextFromReport,
  visibleStatusHash,
  type TargetDisplayContext
} from "./report-ui.js";

interface Dependencies {
  client: Client;
  config: BotConfig;
  database: AccountBotDatabase;
  messageResolver: MessageResolver;
  profileResolver: ProfileResolver;
  serverResolver: ServerResolver;
}

type PendingTarget =
  | { flow: "message"; messageUrl: string; evidence?: MessageEvidence; display?: TargetDisplayContext }
  | { flow: "profile"; userId: string; serverId?: string; snapshot?: Awaited<ReturnType<ProfileResolver["resolve"]>>; display?: TargetDisplayContext }
  | { flow: "server"; serverOrInvite: string; display?: TargetDisplayContext };

type PendingManualRetry = { kind: "manual-retry"; reportId: string; flow: "message" | "profile" | "server" };

export class AccountInteractionHandler {
  private readonly adminApi: DsaAdminApi;

  public constructor(private readonly dependencies: Dependencies) {
    this.adminApi = new DsaAdminApi({ baseUrl: dependencies.config.apiBaseUrl, adminKey: dependencies.config.adminApiKey });
  }

  public async handle(interaction: Interaction): Promise<void> {
    try {
      if (interaction.isModalSubmit()) await this.modal(interaction);
      else if (interaction.isButton()) await this.button(interaction);
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
    if (interaction.customId.startsWith("report-edit-submit:")) {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const pendingId = interaction.customId.slice("report-edit-submit:".length);
      const encrypted = await this.dependencies.database.pendingForm(pendingId, interaction.user.id);
      if (encrypted === null) throw new UserFacingError("This replacement form expired. Start again from the status card.");
      const pending = decryptJson<PendingManualRetry>(encrypted, this.dependencies.config.dataEncryptionKey);
      const connection = await this.requiredConnection(interaction.user.id);
      const countries = await this.supportedCountries(connection);
      const values = this.parseModalValues(pending.flow, {
        mode: "manual",
        country: interaction.fields.getTextInputValue("country"),
        categories: interaction.fields.getStringSelectValues("category"),
        details: interaction.fields.getTextInputValue("report-details"),
        ...(pending.flow === "profile" ? { profileElements: interaction.fields.getStringSelectValues("profile-elements") } : {}),
        ...(pending.flow === "server" ? { guildElements: interaction.fields.getStringSelectValues("server-elements") } : {})
      }, countries);
      const retry: RetryReportInput = {
        mode: "edit_manual", country: values.country!, category: values.category!, finalText: values.finalText!,
        ...(values.profileElements ? { profileElements: values.profileElements } : {}),
        ...(values.guildElements ? { guildElements: values.guildElements } : {})
      };
      await this.submitRetry(interaction, pending.reportId, retry, pendingId);
      return;
    }
    if (!interaction.customId.startsWith("report:")) return;
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const [, pendingId] = interaction.customId.split(":");
    if (pendingId === undefined) throw new UserFacingError("Report form is invalid.");
    const encrypted = await this.dependencies.database.pendingForm(pendingId, interaction.user.id);
    if (encrypted === null) throw new UserFacingError("This report form expired. Start again.");
    const pending = decryptJson<PendingTarget>(encrypted, this.dependencies.config.dataEncryptionKey);
    const input = await this.createInput(interaction, pending);
    await this.submit(interaction, input, `create:${interaction.id}`, pendingId, pending.display);
  }

  private async button(interaction: ButtonInteraction): Promise<void> {
    if (interaction.customId.startsWith("report-retry-reuse:")) {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      await this.submitRetry(interaction, interaction.customId.slice("report-retry-reuse:".length), { mode: "reuse" });
      return;
    }
    if (interaction.customId.startsWith("report-retry-regenerate:")) {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      await this.submitRetry(interaction, interaction.customId.slice("report-retry-regenerate:".length), { mode: "regenerate" });
      return;
    }
    if (interaction.customId.startsWith("report-rewrite:")) {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      await this.submitRetry(interaction, interaction.customId.slice("report-rewrite:".length), { mode: "rewrite_ai" });
      return;
    }
    if (!interaction.customId.startsWith("report-edit:")) return;
    const reportId = interaction.customId.slice("report-edit:".length);
    const connection = await this.requiredConnection(interaction.user.id);
    const report = await this.api(connection).report(reportId);
    if (!report.retryableModes.includes("edit_manual") || report.successorReportId !== null) throw new UserFacingError("Manual replacement is no longer available for this report.");
    const pendingId = await this.dependencies.database.savePendingForm(interaction.user.id, encryptJson({ kind: "manual-retry", reportId, flow: report.flow }, this.dependencies.config.dataEncryptionKey));
    await interaction.showModal(buildManualRetryModal(`report-edit-submit:${pendingId}`, report));
  }

  private async reportCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    const flow = interaction.options.getSubcommand();
    let pending: PendingTarget;
    if (flow === "message") {
      pending = { flow, messageUrl: interaction.options.getString("message-link", true) };
    } else if (flow === "profile") {
      const serverId = interaction.options.getString("server-id") ?? undefined;
      pending = { flow, userId: interaction.options.getString("target", true), ...(serverId === undefined ? {} : { serverId }) };
    } else {
      pending = { flow: "server", serverOrInvite: interaction.options.getString("server-or-invite") ?? interaction.guildId ?? "" };
    }
    await this.showReportModal(interaction, pending);
  }

  private async contextMenu(interaction: MessageContextMenuCommandInteraction): Promise<void> {
    const pending: PendingTarget = {
      flow: "message",
      messageUrl: interaction.targetMessage.url,
      evidence: capturedMessageEvidence(interaction.targetMessage, "context_menu"),
      display: messageSnapshotDisplay(capturedMessageEvidence(interaction.targetMessage, "context_menu").snapshot)
    };
    if (interaction.commandName === "Quick Report Message") {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      await this.submit(interaction, {
        flow: "message",
        useAi: true,
        target: { messageUrl: pending.messageUrl, ...(pending.evidence === undefined ? {} : { messageEvidence: pending.evidence }) }
      }, `create:${interaction.id}`, undefined, pending.display);
    } else await this.showReportModal(interaction, pending);
  }

  private async showReportModal(
    interaction: ChatInputCommandInteraction | MessageContextMenuCommandInteraction,
    pending: PendingTarget
  ): Promise<void> {
    const resolved = await this.resolvePending(pending);
    const pendingId = await this.dependencies.database.savePendingForm(
      interaction.user.id,
      encryptJson(resolved, this.dependencies.config.dataEncryptionKey)
    );
    const targetLabel = resolved.display?.handle ?? resolved.display?.name ?? (resolved.flow === "message" ? "@username's message" : resolved.flow === "profile" ? "@username" : "server");
    await interaction.showModal(buildReportModal(`report:${pendingId}`, resolved.flow, targetLabel));
  }

  private async createInput(interaction: ModalSubmitInteraction, pending: PendingTarget): Promise<CreateReportInput> {
    const mode = interaction.fields.getRadioGroup("writer-mode");
    if (mode !== "ai" && mode !== "manual") throw new UserFacingError("Choose how the report should be written.");
    const parsed = this.parseModalValues(pending.flow, {
      mode,
      country: interaction.fields.getTextInputValue("country"),
      categories: interaction.fields.getStringSelectValues("category"),
      details: interaction.fields.getTextInputValue("report-details"),
      ...(pending.flow === "profile" ? { profileElements: interaction.fields.getStringSelectValues("profile-elements") } : {}),
      ...(pending.flow === "server" ? { guildElements: interaction.fields.getStringSelectValues("server-elements") } : {})
    }, await this.supportedCountries(await this.requiredConnection(interaction.user.id)));
    let target: ReportTarget;
    if (pending.flow === "message") {
      const evidence = pending.evidence ?? await this.dependencies.messageResolver.resolve(pending.messageUrl)
        .then((snapshot) => snapshot === null ? unavailableMessageEvidence() : resolvedMessageEvidence(snapshot));
      target = { messageUrl: pending.messageUrl, ...(evidence === undefined ? {} : { messageEvidence: evidence }) };
    } else if (pending.flow === "profile") {
      const snapshot = pending.snapshot ?? await this.dependencies.profileResolver.resolve(pending.userId);
      if (snapshot === null) throw new UserFacingError("That Discord profile could not be resolved.");
      target = {
        reportedUsername: snapshot.username,
        reportedUserId: pending.userId,
        reportedUserSnapshot: snapshot,
        profileElements: parsed.profileElements!,
        ...(pending.serverId === undefined ? {} : { reportedUserServerId: pending.serverId })
      };
    } else {
      if (!pending.serverOrInvite) throw new UserFacingError("A server ID or invite is required.");
      target = { guildIdOrInviteCode: pending.serverOrInvite, guildElements: parsed.guildElements! };
    }
    if (parsed.useAi) {
      return { flow: pending.flow, useAi: true, target, ...(parsed.country ? { country: parsed.country } : {}), ...(parsed.category ? { category: parsed.category } : {}), ...(parsed.description ? { description: parsed.description } : {}) };
    }
    return { flow: pending.flow, useAi: false, target, country: parsed.country!, category: parsed.category!, finalText: parsed.finalText!, ...(parsed.description ? { description: parsed.description } : {}) };
  }

  private async submit(
    interaction: ModalSubmitInteraction | MessageContextMenuCommandInteraction,
    input: CreateReportInput,
    idempotencyKey: string,
    pendingId?: string,
    display?: TargetDisplayContext
  ): Promise<void> {
    const connection = await this.requiredConnection(interaction.user.id);
    const linkId = await this.dependencies.database.beginReportLink(
      interaction.user.id,
      connection.account_id,
      idempotencyKey,
      encryptJson(input, this.dependencies.config.dataEncryptionKey),
      display ? encryptJson(display, this.dependencies.config.dataEncryptionKey) : undefined
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
        const context = display ?? targetContextFromReport(report);
        const message = await interaction.user.send(statusMessageOptions(report, context));
        await this.dependencies.database.setDmMapping(report.reportId, message.channelId, message.id);
        await this.dependencies.database.completeCardUpdate(report.reportId, visibleStatusHash(report, context));
      } catch (error) {
        await this.dependencies.database.releaseDmCard(report.reportId);
        await this.dependencies.database.rescheduleCardRepair(report.reportId, 5);
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

  private async submitRetry(
    interaction: ModalSubmitInteraction | ButtonInteraction,
    predecessorReportId: string,
    input: RetryReportInput,
    pendingId?: string
  ): Promise<void> {
    const connection = await this.requiredConnection(interaction.user.id);
    const predecessor = await this.api(connection).report(predecessorReportId);
    if (!predecessor.retryableModes.includes(input.mode) || predecessor.successorReportId !== null) throw new UserFacingError("That replacement option is no longer available.");
    const idempotencyKey = `retry:${interaction.id}`;
    const encryptedContext = await this.dependencies.database.reportTargetContext(predecessorReportId);
    const linkId = await this.dependencies.database.beginReportLink(
      interaction.user.id, connection.account_id, idempotencyKey,
      encryptJson({ reportId: predecessorReportId, input }, this.dependencies.config.dataEncryptionKey),
      encryptedContext ?? undefined
    );
    let report: ReportDetail;
    try { report = await this.api(connection).retryReport(predecessorReportId, idempotencyKey, input); }
    catch (error) {
      if (error instanceof DsaApiError && error.status < 500) await this.dependencies.database.abandonReportLink(linkId);
      throw error;
    }
    await this.dependencies.database.completeReplacementLink(linkId, report.reportId, predecessorReportId);
    if (pendingId) await this.dependencies.database.deletePendingForm(pendingId, interaction.user.id);
    await interaction.editReply(`Replacement report **${report.reportId}** is queued. The existing private status card will continue updating.`);
  }

  private async resolvePending(pending: PendingTarget): Promise<PendingTarget> {
    if (pending.flow === "message") {
      if (pending.evidence) return pending.evidence.status === "captured"
        ? { ...pending, display: pending.display ?? messageSnapshotDisplay(pending.evidence.snapshot) }
        : { ...pending, display: pending.display ?? { flow: "message", name: "Reported message", kind: "Discord message", metadata: [] } };
      const snapshot = await this.dependencies.messageResolver.resolve(pending.messageUrl);
      return snapshot === null
        ? { ...pending, evidence: unavailableMessageEvidence(), display: { flow: "message", name: "Reported message", kind: "Discord message", metadata: [] } }
        : { ...pending, evidence: resolvedMessageEvidence(snapshot), display: messageSnapshotDisplay(snapshot) };
    }
    if (pending.flow === "profile") {
      const snapshot = pending.snapshot ?? await this.dependencies.profileResolver.resolve(pending.userId);
      if (snapshot === null) throw new UserFacingError("That Discord profile could not be resolved.");
      return { ...pending, snapshot, display: {
        flow: "profile", name: snapshot.globalDisplayName ?? snapshot.username, handle: `@${snapshot.username}`,
        ...(snapshot.avatarUrl ? { imageUrl: snapshot.avatarUrl } : {}), kind: snapshot.bot ? "Bot account" : "User account",
        metadata: [["User ID", snapshot.userId], ...(pending.serverId ? [["Observed server", pending.serverId] as [string, string]] : [])]
      } };
    }
    const snapshot = await this.dependencies.serverResolver.resolve(pending.serverOrInvite);
    return snapshot === null
      ? { ...pending, display: pending.display ?? { flow: "server", name: pending.serverOrInvite, kind: "Discord server", metadata: [["Server or invite", pending.serverOrInvite]] } }
      : { ...pending, serverOrInvite: snapshot.idOrInvite, display: {
        flow: "server", name: snapshot.name, ...(snapshot.imageUrl ? { imageUrl: snapshot.imageUrl } : {}), kind: "Discord server",
        ...(snapshot.description ? { excerpt: snapshot.description.slice(0, 300) } : {}),
        metadata: [["Server ID", snapshot.idOrInvite], ...(snapshot.memberCount === null ? [] : [["Members", String(snapshot.memberCount)] as [string, string]]), ...(snapshot.presenceCount === null ? [] : [["Online", String(snapshot.presenceCount)] as [string, string]])]
      } };
  }

  private async supportedCountries(connection: ApiConnection): Promise<string[]> {
    const catalog = await this.api(connection).catalog();
    const countries = catalog.countries;
    if (!Array.isArray(countries) || countries.some((country) => typeof country !== "string")) throw new Error("API country catalog is invalid.");
    return countries as string[];
  }

  private parseModalValues(
    flow: ReportDetail["flow"],
    values: Parameters<typeof parseReportModalValues>[1],
    countries: readonly string[]
  ): ReturnType<typeof parseReportModalValues> {
    try {
      return parseReportModalValues(flow, values, countries);
    } catch (error) {
      throw new UserFacingError(error instanceof Error ? error.message : "The report form contains invalid values.");
    }
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
      await interaction.editReply(statusMessageOptions(report, targetContextFromReport(report)));
    } else {
      const reportId = interaction.options.getString("report-id", true);
      const mode = interaction.options.getString("mode", true) as "reuse" | "regenerate";
      const idempotencyKey = `retry:${interaction.id}`;
      const linkId = await this.dependencies.database.beginReportLink(interaction.user.id, connection.account_id, idempotencyKey, encryptJson({ reportId, input: { mode } }, this.dependencies.config.dataEncryptionKey));
      let report: ReportDetail;
      try {
        report = await api.retryReport(reportId, idempotencyKey, { mode });
      } catch (error) {
        if (error instanceof DsaApiError && error.status < 500) await this.dependencies.database.abandonReportLink(linkId);
        throw error;
      }
      await this.dependencies.database.completeReportLink(linkId, report.reportId);
      let warning = "";
      if (await this.dependencies.database.claimDmCard(report.reportId)) {
        try {
          const context = targetContextFromReport(report);
          const message = await interaction.user.send(statusMessageOptions(report, context));
          await this.dependencies.database.setDmMapping(report.reportId, message.channelId, message.id);
          await this.dependencies.database.completeCardUpdate(report.reportId, visibleStatusHash(report, context));
        } catch {
          await this.dependencies.database.releaseDmCard(report.reportId);
          await this.dependencies.database.rescheduleCardRepair(report.reportId, 5);
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
      ...(interaction.options.getBoolean("decisions") === null ? {} : { decisionEnabled: interaction.options.getBoolean("decisions")! }),
      ...(interaction.options.getBoolean("report-denied") === null ? {} : { reportDeniedEnabled: interaction.options.getBoolean("report-denied")! }),
      ...(interaction.options.getBoolean("problems") === null ? {} : { problemEnabled: interaction.options.getBoolean("problems")! }),
      ...(interaction.options.getBoolean("daily-digest") === null ? {} : { dailyDigest: interaction.options.getBoolean("daily-digest")! }),
      ...(interaction.options.getBoolean("weekly-digest") === null ? {} : { weeklyDigest: interaction.options.getBoolean("weekly-digest")! })
    });
    await interaction.editReply(`Decision DMs: ${preferences.decisionEnabled ? "on" : "off"}; report-denied DM: ${preferences.reportDeniedEnabled ? "on" : "off"}; problem DMs: ${preferences.problemEnabled ? "on" : "off"}; daily digest: ${preferences.dailyDigest ? "on" : "off"}; weekly digest: ${preferences.weeklyDigest ? "on" : "off"}.`);
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

function messageSnapshotDisplay(snapshot: ReportedMessageSnapshot): TargetDisplayContext {
  const location = [snapshot.channelName ? `#${snapshot.channelName}` : null, snapshot.serverName].filter(Boolean).join(" · ");
  return {
    flow: "message",
    name: snapshot.authorDisplayName ?? snapshot.authorUsername,
    handle: `@${snapshot.authorUsername}`,
    ...(snapshot.authorAvatarUrl ? { imageUrl: snapshot.authorAvatarUrl } : {}),
    kind: snapshot.authorBot ? "Bot account" : "User account",
    ...(snapshot.content ? { excerpt: snapshot.content.slice(0, 300) } : {}),
    metadata: [
      ["Location", location || "Unknown channel"],
      ["Posted", snapshot.createdAt],
      ["Attachments", String(snapshot.attachments.length)],
      ["User ID", snapshot.authorId],
      ["Message", `https://discord.com/channels/${snapshot.serverId ?? "@me"}/${snapshot.channelId}/${snapshot.messageId}`]
    ]
  };
}
