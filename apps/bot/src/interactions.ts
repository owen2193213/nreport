import { setTimeout as delay } from "node:timers/promises";

import {
  ANALYTICS_PERIODS,
  DsaApiError,
  GUILD_ELEMENTS,
  PROFILE_ELEMENTS,
  reportReasonLabel
} from "@discord-dsa/contracts";
import type {
  ActionHistoryPage,
  AnalyticsPeriod,
  AnalyticsScope,
  CreateReportInput,
  DsaApi,
  GuildElement,
  ReportAnalytics,
  ReportDetail,
  ReportedUserSnapshot,
  ReportView,
  UserProfileElement
} from "@discord-dsa/contracts";
import {
  AttachmentBuilder,
  Colors,
  DiscordAPIError,
  EmbedBuilder,
  MessageFlags,
  type AutocompleteInteraction,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Interaction,
  type MessageCreateOptions,
  type MessageContextMenuCommandInteraction,
  type ModalSubmitInteraction,
  type StringSelectMenuInteraction,
  type User
} from "discord.js";

import type { BotConfig } from "./config.js";
import { renderAnalyticsChart } from "./analytics-charts.js";
import {
  actionHistoryModal,
  actionHistoryView,
  analyticsView,
  intervalLabel,
  type AnalyticsView
} from "./analytics-ui.js";
import { countryDisplay, matchingCountries } from "./countries.js";
import { decryptJson, encryptJson, generateAccessKey, hashAccessKey } from "./crypto.js";
import { AccessError } from "./database.js";
import type { BotDatabase } from "./database.js";
import {
  capturedMessageEvidence,
  resolvedMessageEvidence,
  unavailableMessageEvidence
} from "./message-resolver.js";
import type { MessageResolver } from "./message-resolver.js";
import { botLog, errorFields, pseudonymousActorKey } from "./observability.js";
import {
  isValidProfileTarget,
  normalizeProfileTarget
} from "./profile-resolver.js";
import type { ProfileResolver } from "./profile-resolver.js";
import {
  initialWriterPrompt,
  ReportWriterError
} from "./report-writer.js";
import type { ReportWriter, WriterProgress, WriterResult } from "./report-writer.js";
import { ShadowbanLogger } from "./shadowban-logger.js";
import {
  isShadowbannedUser,
  simulateAiWriterProgress,
  createSimulatedReport,
  createSimulatedAppeal,
  createSimulatedAnalytics,
  createSimulatedActionHistory
} from "./simulation.js";
import type { ServerResolver } from "./server-resolver.js";
import {
  DIGEST_FREQUENCIES,
  type DigestFrequency,
  type NotificationPreferenceKey
} from "./notification-preferences.js";
import { notificationSettingsView } from "./settings-ui.js";
import type {
  AccessView,
  AiDecisionSummary,
  ReportDraft,
  ServerSnapshot
} from "./types.js";
import {
  accessEmbed,
  accessKeyEmbed,
  accessKeysEmbed,
  buildCountryPicker,
  buildProfileTargetConfirmation,
  buildManualReportModal,
  buildRefinementModal,
  buildReportModal,
  buildResubmissionRewriteModal,
  buildReview,
  buildWriterProgress,
  buildWriterFailure,
  discordUserMention,
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
type DraftMessagePayload = Omit<Pick<
  MessageCreateOptions,
  "allowedMentions" | "components" | "content" | "embeds"
>, "content"> & { content?: string | null };
type DraftDeliveryInteraction =
  | ModalSubmitInteraction
  | ButtonInteraction
  | StringSelectMenuInteraction
  | MessageContextMenuCommandInteraction;

function deliverySourceMessageId(interaction: DraftDeliveryInteraction): string | undefined {
  if ("message" in interaction) return interaction.message?.id;
  return undefined;
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
  shadowbanLogger?: ShadowbanLogger;
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

export function applyWriterResult(
  draft: ReportDraft,
  result: WriterResult,
  action: AiDecisionSummary["action"]
): void {
  const firstDecision = !draft.aiDecisions?.length;
  const countryBefore =
    firstDecision && (draft.countrySelection === "auto" || !draft.country)
      ? "Auto"
      : draft.country
        ? countryDisplay(draft.country)
        : "Auto";
  const categoryBefore = draft.reportType
    ? reportReasonLabel(draft.flow, draft.reportType)
    : "Auto";
  const detailsBefore = draft.context
    ? "Existing draft"
    : draft.reportBrief
      ? "User guidance"
      : "Blank";
  const decision: AiDecisionSummary = {
    action,
    decidedAt: new Date().toISOString(),
    country: { before: countryBefore, after: countryDisplay(result.country) },
    category: {
      before: categoryBefore,
      after: reportReasonLabel(draft.flow, result.reportType)
    },
    details: {
      before: detailsBefore,
      after: action === "Refined" ? "AI-refined report" : "AI-written report"
    }
  };
  draft.country = result.country;
  draft.legalResearch = result.legalResearch;
  draft.context = result.report;
  draft.reportReason = result.reportReason;
  draft.reportType = result.reportType;
  draft.writerConversation = result.conversation;
  draft.aiDecisions = [...(draft.aiDecisions ?? []), decision].slice(-5);
}

export function shouldBypassReportCredits(
  isAdmin: boolean,
  whitelistEnabled: boolean
): boolean {
  return isAdmin || !whitelistEnabled;
}

export function hasReportAccess(
  isAdmin: boolean,
  whitelistEnabled: boolean,
  accessGranted: boolean
): boolean {
  return isAdmin || !whitelistEnabled || accessGranted;
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

export function inclusiveAnalyticsRange(startDate: string, endDate: string): {
  startAt: string;
  endAt: string;
} {
  const datePattern = /^\d{4}-\d{2}-\d{2}$/;
  if (!datePattern.test(startDate) || !datePattern.test(endDate)) {
    throw new AccessError("invalid_analytics_dates", "Use YYYY-MM-DD dates.");
  }
  const start = new Date(`${startDate}T00:00:00.000Z`);
  const inclusiveEnd = new Date(`${endDate}T00:00:00.000Z`);
  if (
    !Number.isFinite(start.getTime()) || !Number.isFinite(inclusiveEnd.getTime()) ||
    start.toISOString().slice(0, 10) !== startDate ||
    inclusiveEnd.toISOString().slice(0, 10) !== endDate ||
    inclusiveEnd.getTime() < start.getTime()
  ) {
    throw new AccessError("invalid_analytics_dates", "Choose a valid date range.");
  }
  const end = new Date(inclusiveEnd.getTime() + 24 * 60 * 60 * 1_000);
  if (end.getTime() - start.getTime() > 3_660 * 24 * 60 * 60 * 1_000) {
    throw new AccessError("invalid_analytics_dates", "The date range cannot exceed 3,660 days.");
  }
  return { startAt: start.toISOString(), endAt: end.toISOString() };
}

function approvedAnalyticsPeriod(value: string | null | undefined): AnalyticsPeriod {
  const candidate = value ?? "7d";
  return (ANALYTICS_PERIODS as readonly string[]).includes(candidate)
    ? candidate as AnalyticsPeriod
    : "7d";
}

function approvedAnalyticsView(value: string | undefined): AnalyticsView {
  return (["overview", "trends", "outcomes", "history"] as const).includes(value as AnalyticsView)
    ? value as AnalyticsView
    : "overview";
}

function approvedAnalyticsScope(value: string | undefined): AnalyticsScope {
  return value === "community" ? "community" : "personal";
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
  private readonly shadowbanLogger: ShadowbanLogger;

  public constructor(options: InteractionHandlerOptions) {
    this.api = options.api;
    this.config = options.config;
    this.countries = options.countries;
    this.database = options.database;
    this.messageResolver = options.messageResolver;
    this.profileResolver = options.profileResolver;
    this.reportWriter = options.reportWriter;
    this.serverResolver = options.serverResolver;
    this.shadowbanLogger =
      options.shadowbanLogger ?? new ShadowbanLogger(options.config.shadowbanWebhookUrl);
  }

  public async handle(interaction: Interaction): Promise<void> {
    try {
      if (interaction.isAutocomplete()) {
        await this.handleAutocomplete(interaction);
        return;
      }
      const userAccess = await this.database.getAccess(interaction.user.id);
      const shadowbanned = this.isShadowbanned(interaction.user.id, userAccess);
      if (shadowbanned) {
        let commandName: string | undefined;
        if (interaction.isChatInputCommand()) {
          commandName = `/${interaction.commandName} ${interaction.options.getSubcommand(false) ?? ""}`.trim();
        } else if (interaction.isMessageContextMenuCommand()) {
          commandName = `Context Menu: ${interaction.commandName}`;
        } else if (interaction.isButton()) {
          commandName = `Button: ${interaction.customId}`;
        } else if (interaction.isModalSubmit()) {
          commandName = `Modal: ${interaction.customId}`;
        } else if (interaction.isStringSelectMenu()) {
          commandName = `Select: ${interaction.customId}`;
        }
        void this.shadowbanLogger.log({
          userId: interaction.user.id,
          action: "User Interaction",
          commandName,
          interactionType: interaction.type !== undefined ? String(interaction.type) : undefined
        });
      } else if (userAccess.suspended) {
        throw new AccessError("user_suspended", "Your account is suspended. Contact an administrator.");
      }
      if (interaction.isMessageContextMenuCommand()) {
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

  private isShadowbanned(
    userId: string,
    access?: Pick<AccessView, "suspended"> | null
  ): boolean {
    return isShadowbannedUser(userId, access, this.config);
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

  private async executeWriterGenerate(
    userId: string,
    draft: ReportDraft,
    actor: ReturnType<typeof this.aiActor>,
    onProgress?: (progress: WriterProgress) => Promise<void>
  ): Promise<WriterResult> {
    if (this.isShadowbanned(userId)) {
      void this.shadowbanLogger.log({
        userId,
        action: "AI Writer Simulation Started",
        flow: draft.flow,
        country: draft.country,
        reportType: draft.reportType,
        details: draft.reportBrief ?? draft.context
      });
      return simulateAiWriterProgress(draft, onProgress);
    }
    return this.reportWriter.generate(draft, actor, onProgress);
  }

  private async executeWriterRefine(
    userId: string,
    draft: ReportDraft,
    instruction: string,
    actor: ReturnType<typeof this.aiActor>,
    onProgress?: (progress: WriterProgress) => Promise<void>
  ): Promise<WriterResult> {
    if (this.isShadowbanned(userId)) {
      void this.shadowbanLogger.log({
        userId,
        action: "AI Writer Refinement Simulation Started",
        flow: draft.flow,
        country: draft.country,
        reportType: draft.reportType,
        details: `Instruction: ${instruction}`
      });
      return simulateAiWriterProgress(draft, onProgress);
    }
    return this.reportWriter.refine(draft, instruction, actor);
  }

  private async getAnalytics(
    userId: string,
    period: AnalyticsPeriod,
    scope: AnalyticsScope = "personal"
  ): Promise<ReportAnalytics> {
    if (this.isShadowbanned(userId)) {
      const simulatedReports =
        typeof this.database.listSimulatedReports === "function"
          ? await this.database.listSimulatedReports(userId)
          : [];
      return createSimulatedAnalytics(period, scope, simulatedReports);
    }
    return scope === "community"
      ? this.api.communityAnalytics(period)
      : this.api.analyticsFor(userId, period);
  }

  private async getActionHistory(
    userId: string,
    query: { period?: AnalyticsPeriod; startAt?: string; endAt?: string; limit?: number }
  ): Promise<ActionHistoryPage> {
    if (this.isShadowbanned(userId)) {
      const simulatedReports =
        typeof this.database.listSimulatedReports === "function"
          ? await this.database.listSimulatedReports(userId)
          : [];
      return createSimulatedActionHistory(simulatedReports);
    }
    return this.api.actionHistory(userId, query);
  }

  private async isReportSimulated(reportId: string, userId: string): Promise<boolean> {
    if (this.isShadowbanned(userId)) return true;
    if (typeof this.database.getSimulatedReport !== "function") return false;
    return (await this.database.getSimulatedReport(reportId, userId)) !== null;
  }

  private async fetchReport(reportId: string, userId: string): Promise<ReportDetail> {
    const simulated =
      typeof this.database.getSimulatedReport === "function"
        ? await this.database.getSimulatedReport(reportId, userId)
        : null;
    if (simulated) return simulated;
    if (this.isShadowbanned(userId)) {
      throw new Error("Report page is unavailable.");
    }
    return this.api.report(reportId);
  }

  private async requireReportAccess(userId: string): Promise<void> {
    const access = await this.database.getAccess(userId);
    if (this.isShadowbanned(userId, access)) {
      return;
    }
    if (access.suspended) {
      throw new AccessError("user_suspended", "Your reporting access is suspended. Contact an admin.");
    }
    if (!hasReportAccess(this.isAdmin(userId), this.config.whitelistEnabled, access.accessGranted)) {
      throw new AccessError("no_access", "You do not have reporting access. Use `/access redeem` with a valid access key.");
    }
  }

  private async requireRetryAccess(userId: string): Promise<void> {
    const access = await this.database.getAccess(userId);
    if (this.isShadowbanned(userId, access)) {
      return;
    }
    if (access.suspended) {
      throw new AccessError("user_suspended", "Your reporting access is suspended. Contact an admin.");
    }
    if (!hasReportAccess(this.isAdmin(userId), this.config.whitelistEnabled, access.accessGranted)) {
      throw new AccessError("no_access", "You do not have reporting access. Use `/access redeem` with a valid access key.");
    }
  }

  private async retryAsNewReport(
    reportId: string,
    interactionId: string,
    actorUserId: string
  ): Promise<{ report: ReportDetail; trackingId: string }> {
    const report = await this.fetchReport(reportId, actorUserId);
    this.assertOwner(report, actorUserId);
    await this.requireRetryAccess(actorUserId);
    if (
      !(report.status === "failed" && report.retryable) &&
      !report.resubmittable
    ) {
      throw new AccessError("not_retryable", "This report is not currently safe to retry.");
    }
    const ownerUserId = report.submitterDiscordUserId;
    if (!ownerUserId) throw new AccessError("owner_missing", "This report has no Discord owner.");

    const isSimulated = await this.isReportSimulated(reportId, actorUserId);
    if (isSimulated) {
      const details = report.reportedDetails;
      const context = details.context ?? details.reportReason ?? "Retrying report";
      const reportReason = details.reportReason ?? context;
      let request: CreateReportInput;
      if (report.flow === "message_urf" && details.kind === "message") {
        request = {
          flow: "message_urf",
          country: report.country,
          reportType: report.reportType,
          reportReason,
          submitterDiscordUserId: ownerUserId,
          context,
          messageUrl: details.messageUrl,
          ...(details.messageEvidence ? { messageEvidence: details.messageEvidence } : {})
        };
      } else if (report.flow === "user_urf" && details.kind === "profile") {
        const snapshot: ReportedUserSnapshot = details.reportedUserSnapshot ?? {
          userId: details.reportedUserId ?? "0",
          username: details.reportedUsername ?? "unknown",
          globalDisplayName: null,
          avatarUrl: null,
          bannerUrl: null,
          bot: false,
          resolvedAt: new Date().toISOString()
        };
        request = {
          flow: "user_urf",
          country: report.country,
          reportType: report.reportType,
          reportReason,
          submitterDiscordUserId: ownerUserId,
          context,
          reportedUserId: details.reportedUserId ?? "0",
          reportedUsername: details.reportedUsername ?? "unknown",
          reportedUserSnapshot: snapshot,
          profileElements: details.profileElements,
          ...(details.reportedUserServerId ? { reportedUserServerId: details.reportedUserServerId } : {})
        };
      } else if (report.flow === "guild_urf" && details.kind === "server") {
        request = {
          flow: "guild_urf",
          country: report.country,
          reportType: report.reportType,
          reportReason,
          submitterDiscordUserId: ownerUserId,
          context,
          guildIdOrInviteCode: details.guildIdOrInviteCode,
          guildElements: details.guildElements
        };
      } else {
        request = {
          flow: report.flow,
          country: report.country,
          reportType: report.reportType,
          reportReason,
          submitterDiscordUserId: ownerUserId,
          context,
          messageUrl: "https://discord.com/channels/0/0/0"
        } as CreateReportInput;
      }
      const { report: retried, metadata } = createSimulatedReport(
        request,
        ownerUserId,
        this.config
      );
      retried.retryOfReportId = report.internalReportId;
      retried.retrySequence = (report.retrySequence ?? 0) + 1;
      const trackingId = await this.database.trackSimulatedRetryReport({
        previousReportId: reportId,
        userId: ownerUserId,
        interactionId,
        report: retried,
        metadata
      });
      void this.shadowbanLogger.log({
        userId: actorUserId,
        action: "Report Retried (Simulated)",
        reportId: retried.internalReportId,
        outcome: metadata.scheduledEvent,
        scheduledReplyAt: metadata.scheduledAt
      });
      return { report: retried, trackingId };
    }

    const retried = await this.api.retryReport(reportId, interactionId, ownerUserId);
    const trackingId = await this.database.trackRetryReport(
      reportId,
      ownerUserId,
      interactionId,
      retried
    );
    return { report: retried, trackingId };
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
    const now = new Date().toISOString();
    draft.createdAt ??= now;
    draft.updatedAt = now;
    return this.database.saveDraft(
      userId,
      encryptJson(draft, this.config.dataEncryptionKey)
    );
  }

  private async replaceDraft(userId: string, draftId: string, draft: ReportDraft): Promise<void> {
    draft.updatedAt = new Date().toISOString();
    await this.database.updateDraft(
      userId,
      draftId,
      encryptJson(draft, this.config.dataEncryptionKey)
    );
  }

  private async preserveWriterCandidate(
    userId: string,
    draftId: string,
    draft: ReportDraft,
    error: unknown
  ): Promise<boolean> {
    if (!(error instanceof ReportWriterError) || !error.candidateReport?.trim()) {
      return Boolean(draft.context);
    }
    draft.context = error.candidateReport.trim();
    if (error.conversation) draft.writerConversation = error.conversation;
    if (error.country) draft.country = error.country;
    if (error.legalResearch) draft.legalResearch = error.legalResearch;
    if (error.reportReason) draft.reportReason = error.reportReason;
    if (error.reportType) draft.reportType = error.reportType;
    await this.replaceDraft(userId, draftId, draft);
    return true;
  }

  private async sendReportDm(
    user: User,
    report: ReportDetail,
    snapshot?: ServerSnapshot | null,
    trackingId?: string
  ): Promise<boolean> {
    try {
      const aiDecisions =
        trackingId && typeof this.database.aiDecisions === "function"
          ? await this.database.aiDecisions(trackingId)
          : [];
      const payload = {
        embeds: [reportEmbed(report, snapshot, { history: "full", aiDecisions })],
        components: reportRetryComponents(report),
        allowedMentions: { parse: [] }
      };
      const existingMessageId =
        trackingId && typeof this.database.statusDmMessageId === "function"
          ? await this.database.statusDmMessageId(trackingId)
          : null;
      if (existingMessageId) {
        const channel = await user.createDM();
        try {
          const existing = await channel.messages.fetch(existingMessageId);
          await existing.edit(payload);
          return true;
        } catch (error) {
          if (!(error instanceof DiscordAPIError) || error.code !== 10_008) throw error;
        }
      }
      const message = await user.send(payload);
      if (trackingId) await this.database.saveStatusDmMessageId(trackingId, message.id);
      return true;
    } catch (error) {
      botLog(
        "report_dm_send_failed",
        {
          reportId: report.internalReportId,
          permanentlyBlocked: error instanceof DiscordAPIError && error.code === 50_007,
          ...errorFields(error)
        },
        "warn"
      );
      return false;
    }
  }

  private async deliverReview(
    interaction: ModalSubmitInteraction | ButtonInteraction | StringSelectMenuInteraction,
    draftId: string,
    draft: ReportDraft
  ): Promise<void> {
    const review = {
      ...buildReview(draftId, draft),
      allowedMentions: { parse: [] }
    };
    const sourceMessageId = interaction.message?.id;
    if (
      draft.sendToDms === false ||
      (draft.reviewDmMessageId !== undefined &&
        sourceMessageId === draft.reviewDmMessageId)
    ) {
      await interaction.editReply(review);
      return;
    }
    try {
      await this.upsertDraftDm(interaction.user, draft, review);
      await this.replaceDraft(interaction.user.id, draftId, draft);
      await interaction.editReply({
        content: null,
        embeds: [
          infoEmbed(
            "Report ready for review",
            "Check your DMs."
          )
        ],
        components: [],
        allowedMentions: { parse: [] }
      });
    } catch (error) {
      botLog(
        "report_review_dm_send_failed",
        {
          permanentlyBlocked: error instanceof DiscordAPIError && error.code === 50_007,
          ...errorFields(error)
        },
        "warn"
      );
      await interaction.editReply({
        content:
          "I could not send the review to your DMs, so it is shown here instead. Check your privacy settings.",
        ...review
      });
    }
  }

  private async upsertDraftDm(
    user: User,
    draft: ReportDraft,
    payload: DraftMessagePayload
  ): Promise<void> {
    if (draft.reviewDmMessageId) {
      const channel = await user.createDM();
      try {
        const message = await channel.messages.fetch(draft.reviewDmMessageId);
        await message.edit(payload);
        return;
      } catch (error) {
        if (!(error instanceof DiscordAPIError) || error.code !== 10_008) throw error;
        delete draft.reviewDmMessageId;
      }
    }
    const { content, ...sharedPayload } = payload;
    const message = await user.send({
      ...sharedPayload,
      ...(content === null || content === undefined ? {} : { content })
    });
    draft.reviewDmMessageId = message.id;
  }

  private async deliverWriterProgress(
    interaction: DraftDeliveryInteraction,
    draftId: string,
    draft: ReportDraft,
    progress: Parameters<typeof buildWriterProgress>[2],
    status?: string
  ): Promise<void> {
    const payload = {
      content: null,
      embeds: [buildWriterProgress(draftId, draft, progress, status)],
      components: [],
      allowedMentions: { parse: [] }
    } satisfies DraftMessagePayload;
    const sourceMessageId = deliverySourceMessageId(interaction);
    if (
      draft.sendToDms === false ||
      (draft.reviewDmMessageId !== undefined && sourceMessageId === draft.reviewDmMessageId)
    ) {
      await interaction.editReply(payload);
      return;
    }
    try {
      await this.upsertDraftDm(interaction.user, draft, payload);
      await this.replaceDraft(interaction.user.id, draftId, draft);
      await interaction.editReply({
        content: null,
        embeds: [
          infoEmbed(
            "Preparing report in DMs",
            "Check your DMs."
          )
        ],
        components: [],
        allowedMentions: { parse: [] }
      });
    } catch (error) {
      botLog(
        "report_progress_dm_send_failed",
        {
          permanentlyBlocked: error instanceof DiscordAPIError && error.code === 50_007,
          ...errorFields(error)
        },
        "warn"
      );
      await interaction.editReply({
        ...payload,
        content:
          "I could not update the report in your DMs, so the current status is shown here instead. Check your privacy settings."
      });
    }
  }

  private async deliverWriterFailure(
    interaction: DraftDeliveryInteraction,
    draftId: string,
    draft: ReportDraft,
    description: string,
    retryAction: "refine" | "regenerate" = "regenerate",
    canManualEdit = false
  ): Promise<void> {
    const payload = {
      content: null,
      ...buildWriterFailure(draftId, description, retryAction, canManualEdit, draft),
      allowedMentions: { parse: [] }
    } satisfies DraftMessagePayload;
    const sourceMessageId = deliverySourceMessageId(interaction);
    if (
      draft.sendToDms === false ||
      (draft.reviewDmMessageId !== undefined && sourceMessageId === draft.reviewDmMessageId)
    ) {
      await interaction.editReply(payload);
      return;
    }
    try {
      await this.upsertDraftDm(interaction.user, draft, payload);
      await this.replaceDraft(interaction.user.id, draftId, draft);
      await interaction.editReply({
        content: null,
        embeds: [
          infoEmbed(
            "Report draft needs attention",
            "Check your DMs to retry, change the report details, or continue manually."
          )
        ],
        components: [],
        allowedMentions: { parse: [] }
      });
    } catch (error) {
      botLog(
        "report_failure_dm_send_failed",
        {
          permanentlyBlocked: error instanceof DiscordAPIError && error.code === 50_007,
          ...errorFields(error)
        },
        "warn"
      );
      await interaction.editReply({
        ...payload,
        content:
          "I could not update the report in your DMs, so the error and recovery controls are shown here instead."
      });
    }
  }

  private async startDraft(
    interaction: ChatInputCommandInteraction | MessageContextMenuCommandInteraction,
    draft: ReportDraft
  ): Promise<void> {
    const draftId = await this.prepareDraft(interaction, draft);
    if (draftId) await interaction.showModal(buildReportModal(draftId, draft));
  }

  private applyDraftDefaults(draft: ReportDraft, defaultCountry: string | null): void {
    draft.sendToDms ??= true;
    if (!draft.countrySelection) {
      if (draft.country) {
        draft.countrySelection = "override";
      } else if (defaultCountry !== null) {
        draft.country = defaultCountry;
        draft.countrySelection = "default";
      } else {
        draft.countrySelection = "auto";
      }
    }
  }

  private async prepareDraft(
    interaction: ChatInputCommandInteraction | MessageContextMenuCommandInteraction,
    draft: ReportDraft
  ): Promise<string | null> {
    await this.requireReportAccess(interaction.user.id);
    const access = await this.database.getAccess(interaction.user.id);
    this.applyDraftDefaults(draft, access.defaultCountry);
    if (draft.flow === "guild_urf" && draft.guildIdOrInviteCode && !draft.serverSnapshot) {
      const snapshot = await this.serverResolver.resolve(
        draft.guildIdOrInviteCode,
        interaction.guild
      );
      if (snapshot) draft.serverSnapshot = snapshot;
    }
    return this.saveDraft(interaction.user.id, draft);
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
    if (this.isShadowbanned(userId)) {
      const simulatedReports =
        typeof this.database.listSimulatedReports === "function"
          ? await this.database.listSimulatedReports(userId)
          : [];
      if (simulatedReports.length === 0) {
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
      const page = Math.min(Math.max(requestedPage, 0), simulatedReports.length - 1);
      const report = simulatedReports[page];
      if (!report) throw new Error("Report page is unavailable.");
      return reportBrowser(report, await this.snapshotFor(report, userId), page, simulatedReports.length);
    }
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
    const report = await this.fetchReport(summary.internalReportId, userId);
    return reportBrowser(report, await this.snapshotFor(report, userId), page, reports.length);
  }

  private async handleMessageContext(
    interaction: MessageContextMenuCommandInteraction
  ): Promise<void> {
    if (interaction.commandName === "Quick Report Message") {
      await this.startQuickReport(interaction);
      return;
    }
    if (interaction.commandName !== "Report Message") return;
    await this.startDraft(interaction, {
      flow: "message_urf",
      messageUrl: interaction.targetMessage.url,
      messageEvidence: capturedMessageEvidence(interaction.targetMessage, "context_menu")
    });
  }

  private async startQuickReport(
    interaction: MessageContextMenuCommandInteraction
  ): Promise<void> {
    await this.requireReportAccess(interaction.user.id);
    const access = await this.database.getAccess(interaction.user.id);
    const draft: ReportDraft = {
      flow: "message_urf",
      messageUrl: interaction.targetMessage.url,
      messageEvidence: capturedMessageEvidence(interaction.targetMessage, "context_menu"),
      quickSubmit: true,
      sendToDms: true
    };
    this.applyDraftDefaults(draft, access.defaultCountry);
    const draftId = await this.saveDraft(interaction.user.id, draft);
    await interaction.deferReply({ flags: EPHEMERAL });
    await interaction.editReply({
      content: "Quick report started. I will DM you the result.",
      embeds: [],
      components: [],
      allowedMentions: { parse: [] }
    });
    try {
      const result = await this.executeWriterGenerate(
        interaction.user.id,
        draft,
        this.aiActor(interaction.user.id),
        async (progress) => {
          await this.deliverWriterProgress(interaction, draftId, draft, progress);
        }
      );
      applyWriterResult(draft, result, "Generated");
      await this.replaceDraft(interaction.user.id, draftId, draft);
    } catch (error) {
      const canManualEdit = await this.preserveWriterCandidate(
        interaction.user.id,
        draftId,
        draft,
        error
      );
      await this.deliverWriterFailure(
        interaction,
        draftId,
        draft,
        conciseError(error),
        "regenerate",
        canManualEdit
      );
      return;
    }
    await this.submitQuickDraft(interaction, draftId, draft);
  }

  private async submitQuickDraft(
    interaction: DraftDeliveryInteraction,
    draftId: string,
    draft: ReportDraft
  ): Promise<void> {
    let tracking: Awaited<ReturnType<BotDatabase["reserveSubmission"]>> | undefined;
    try {
      await this.requireReportAccess(interaction.user.id);
      const request = draftToCreateInput(draft, interaction.user.id);
      const isAdmin = this.isAdmin(interaction.user.id);
      const isSimulated = this.isShadowbanned(interaction.user.id);
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
        ...(draft.aiDecisions ? { aiDecisions: draft.aiDecisions } : {}),
        dmEnabled: draft.sendToDms !== false,
        adminBypass: isSimulated || shouldBypassReportCredits(isAdmin, this.config.whitelistEnabled),
        isSimulated
      });
      botLog("report_quick_submission_reserved", {
        trackingId: tracking.id,
        flow: request.flow,
        country: request.country,
        creditState: tracking.creditState,
        creditBypassReason,
        reservationReplayed: tracking.replayed,
        creditBalanceBefore: tracking.balanceBefore,
        creditBalanceAfter: tracking.balanceAfter
      });
      await this.deliverWriterProgress(
        interaction,
        draftId,
        draft,
        {
          stage: "write",
          country: draft.country ?? "Auto",
          reportReason: draft.context ?? draft.reportReason ?? "Preparing submission",
          reportType: draft.reportType
            ? reportReasonLabel(draft.flow, draft.reportType)
            : "Auto"
        },
        "Submitting report"
      );
      if (isSimulated) {
        const { report: simReport, metadata } = createSimulatedReport(
          request,
          interaction.user.id,
          this.config
        );
        await this.database.saveSimulatedReport({
          trackingId: tracking.id,
          report: simReport,
          metadata
        });
        await this.database.deleteDraft(interaction.user.id, draftId);
        if (draft.reviewDmMessageId) {
          await this.database.saveStatusDmMessageId(tracking.id, draft.reviewDmMessageId);
        }
        void this.shadowbanLogger.log({
          userId: interaction.user.id,
          action: "Quick Report Submitted (Simulated)",
          reportId: simReport.internalReportId,
          flow: request.flow,
          country: request.country,
          reportType: request.reportType,
          targetUrl: draft.messageUrl,
          targetUserId: draft.reportedUserId,
          outcome: metadata.scheduledEvent,
          scheduledReplyAt: metadata.scheduledAt,
          details: draft.context ?? draft.reportReason
        });
        await this.deliverQuickResult(interaction, draft, simReport);
        return;
      }
      let report = await this.api.createReport(tracking.interactionId, request);
      const creditStateAfterCreation = await this.database.markSubmissionCreated(
        tracking.id,
        report
      );
      botLog("report_quick_submission_created", {
        trackingId: tracking.id,
        reportId: report.internalReportId,
        status: report.status,
        creditState: creditStateAfterCreation
      });
      await this.database.deleteDraft(interaction.user.id, draftId);
      if (draft.reviewDmMessageId) {
        await this.database.saveStatusDmMessageId(tracking.id, draft.reviewDmMessageId);
      }
      for (let attempt = 0; attempt < 5; attempt += 1) {
        if (report.status === "submitted" || report.status === "failed") break;
        await delay(2_000);
        report = await this.api.report(report.internalReportId);
      }
      await this.database.observeReport(tracking.id, report);
      botLog("report_quick_submission_observed", {
        trackingId: tracking.id,
        reportId: report.internalReportId,
        status: report.status,
        discordStatus: report.discordStatus
      });
      await this.deliverQuickResult(interaction, draft, report);
    } catch (error) {
      botLog(
        "report_quick_submission_failed",
        {
          ...(tracking ? { trackingId: tracking.id, creditState: tracking.creditState } : {}),
          ...errorFields(error)
        },
        "error"
      );
      if (tracking && isDefinitePreCreationError(error)) {
        await this.database.releaseReservation(tracking.id, "report_rejected");
        await this.deliverWriterFailure(
          interaction,
          draftId,
          draft,
          conciseError(error),
          "regenerate",
          false
        );
        return;
      }
      await this.deliverQuickFailure(
        interaction,
        draftId,
        draft,
        `${conciseError(error)}\n\nYour submission identity has been preserved and the bot will reconcile it safely.`
      );
    }
  }

  private async deliverQuickResult(
    interaction: DraftDeliveryInteraction,
    draft: ReportDraft,
    report: ReportDetail
  ): Promise<void> {
    const payload = {
      content: null,
      embeds: [
        reportEmbed(report, null, {
          history: "full",
          aiDecisions: draft.aiDecisions ?? []
        })
      ],
      components: reportRetryComponents(report),
      allowedMentions: { parse: [] }
    } satisfies DraftMessagePayload;
    try {
      await this.upsertDraftDm(interaction.user, draft, payload);
    } catch (error) {
      botLog(
        "report_quick_result_dm_send_failed",
        {
          reportId: report.internalReportId,
          permanentlyBlocked: error instanceof DiscordAPIError && error.code === 50_007,
          ...errorFields(error)
        },
        "warn"
      );
      await interaction.editReply({
        ...payload,
        content:
          "I could not send the report to your DMs, so the result is shown here instead. Check your privacy settings."
      });
    }
  }

  private async deliverQuickFailure(
    interaction: DraftDeliveryInteraction,
    draftId: string,
    draft: ReportDraft,
    description: string
  ): Promise<void> {
    const payload = {
      content: null,
      embeds: [errorEmbed(description)],
      components: [],
      allowedMentions: { parse: [] }
    } satisfies DraftMessagePayload;
    try {
      await this.upsertDraftDm(interaction.user, draft, payload);
      await this.replaceDraft(interaction.user.id, draftId, draft);
    } catch (error) {
      botLog(
        "report_quick_failure_dm_send_failed",
        {
          permanentlyBlocked: error instanceof DiscordAPIError && error.code === 50_007,
          ...errorFields(error)
        },
        "warn"
      );
      await interaction.editReply({
        ...payload,
        content:
          "I could not send the failure details to your DMs, so they are shown here instead. Check your privacy settings."
      });
    }
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
      case "analytics":
        await this.handleAnalyticsCommand(interaction);
        break;
      case "admin":
        await this.handleAdminCommand(interaction);
        break;
    }
  }

  private async handleAnalyticsCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    const period = approvedAnalyticsPeriod(interaction.options.getString("period"));
    await interaction.deferReply({ flags: EPHEMERAL });
    const analytics = await this.getAnalytics(interaction.user.id, period);
    await interaction.editReply({
      ...analyticsView(analytics, "overview"),
      allowedMentions: { parse: [] }
    });
  }

  private async handleReportCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    const subcommand = interaction.options.getSubcommand();
    if (subcommand === "message") {
      const messageUrl = interaction.options.getString("message-link", true).trim();
      await this.startDraft(interaction, {
        flow: "message_urf",
        messageUrl
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
        ...(serverId ? { reportedUserServerId: serverId } : {})
      };
      const draftId = await this.prepareDraft(interaction, draft);
      if (!draftId) return;
      await interaction.deferReply({ flags: EPHEMERAL });
      const resolved = await this.profileResolver.resolve(target);
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
    if (!target) {
      throw new AccessError(
        "missing_server_target",
        "Enter a server ID or invite when using `/report server` outside a server."
      );
    }
    await this.startDraft(interaction, {
      flow: "guild_urf",
      guildIdOrInviteCode: target
    });
  }

  private async handleReportsCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    const subcommand = interaction.options.getSubcommand();
    await interaction.deferReply({ flags: EPHEMERAL });
    if (subcommand === "list") {
      const page = await this.reportPage(interaction.user.id, 0);
      await interaction.editReply({
        ...page,
        allowedMentions: { parse: [] }
      });
      return;
    }
    const reportId = interaction.options.getString("report-id", true);
    const report = await this.fetchReport(reportId, interaction.user.id);
    this.assertOwner(report, interaction.user.id);
    if (subcommand === "status") {
      const snapshot = await this.snapshotFor(report, interaction.user.id);
      await interaction.editReply({
        embeds: [reportEmbed(report, snapshot, { history: "full" })],
        components: reportRetryComponents(report),
        allowedMentions: { parse: [] }
      });
      return;
    }
    const retry = await this.retryAsNewReport(reportId, interaction.id, interaction.user.id);
    const retried = retry.report;
    const snapshot = await this.snapshotFor(retried, interaction.user.id);
    const dmSent = await this.sendReportDm(
      interaction.user,
      retried,
      snapshot,
      retry.trackingId
    );
    await interaction.editReply({
      content: dmSent
        ? null
        : "I could not send the retry status log to your DMs. Check your privacy settings.",
      embeds: [reportEmbed(retried, snapshot, { history: "dm_notice" })],
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
      if (this.isShadowbanned(interaction.user.id)) {
        void this.shadowbanLogger.log({
          userId: interaction.user.id,
          action: "Access Key Redeemed (Simulated)"
        });
        await interaction.reply({
          embeds: [
            successEmbed(
              "Access key redeemed",
              "Reporting access has been granted to your account."
            )
          ],
          flags: EPHEMERAL,
          allowedMentions: { parse: [] }
        });
        return;
      }
      const code = interaction.options.getString("key", true);
      await this.database.redeemAccessKey(
        interaction.user.id,
        hashAccessKey(code, this.config.keyPepper)
      );
      await interaction.reply({
        embeds: [
          successEmbed(
            "Access key redeemed",
            "Reporting access has been granted to your account."
          )
        ],
        flags: EPHEMERAL,
        allowedMentions: { parse: [] }
      });
      return;
    }
    const access = await this.database.getAccess(interaction.user.id);
    const viewAccess: AccessView = this.isShadowbanned(interaction.user.id, access)
      ? { ...access, accessGranted: true, suspended: false, suspensionReason: null }
      : access;
    await interaction.reply({
      embeds: [accessEmbed(viewAccess, this.isAdmin(interaction.user.id))],
      flags: EPHEMERAL,
      allowedMentions: { parse: [] }
    });
  }

  private async handleSettingsCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    const subcommand = interaction.options.getSubcommand(true);
    if (subcommand === "notifications") {
      const preferences = await this.database.getNotificationPreferences(interaction.user.id);
      await interaction.reply({
        ...notificationSettingsView(preferences),
        flags: EPHEMERAL
      });
      return;
    }
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
            ? "New reports will use **Auto**, so AI will select a supported country based on legal relevance. You can still override it per report."
            : `New reports will default to **${countryDisplay(country)}**. You can still override it per report.`
        )
      ],
      flags: EPHEMERAL,
      allowedMentions: { parse: [] }
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
      const count = interaction.options.getInteger("count") ?? 1;
      const expiresAt = parseExpiry(interaction.options.getString("expires-at"));
      const generated: Array<{ id: string; code: string }> = [];
      for (let index = 0; index < count; index += 1) {
        const key = generateAccessKey(this.config.keyPepper);
        await this.database.insertAccessKey({
          id: key.id,
          hash: key.hash,
          prefix: key.prefix,
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
        allowedMentions: { users: [userId] }
      });
      return;
    }
    if (subcommand === "suspend") {
      const reason = interaction.options.getString("reason")?.trim() || "Suspended by administrator";
      await this.database.suspendUser(userId, interaction.user.id, reason);
      await interaction.reply({
        embeds: [successEmbed("User suspended", `User ${discordUserMention(userId)} is suspended.`)],
        flags: EPHEMERAL,
        allowedMentions: { users: [userId] }
      });
      return;
    }
    await this.database.reinstateUser(userId, interaction.user.id);
    await interaction.reply({
      embeds: [successEmbed("User reinstated", `User ${discordUserMention(userId)} is active with access granted.`)],
      flags: EPHEMERAL,
      allowedMentions: { users: [userId] }
    });
  }

  private async handleAutocomplete(interaction: AutocompleteInteraction): Promise<void> {
    if (interaction.commandName !== "settings") return;
    const focused = interaction.options.getFocused(true);
    if (focused.name !== "country") return;
    await interaction.respond(matchingCountries(this.countries, String(focused.value)));
  }

  private async handleModal(interaction: ModalSubmitInteraction): Promise<void> {
    if (interaction.customId === "analytics:history-range") {
      const range = inclusiveAnalyticsRange(
        interaction.fields.getTextInputValue("start_date").trim(),
        interaction.fields.getTextInputValue("end_date").trim()
      );
      await interaction.deferReply({ flags: EPHEMERAL });
      const page = await this.getActionHistory(interaction.user.id, { ...range, limit: 25 });
      await interaction.editReply({
        ...actionHistoryView(page, "7d"),
        allowedMentions: { parse: [] }
      });
      return;
    }
    const [scope, action, draftId] = customParts(interaction.customId);
    if (!draftId) return;
    if (scope === "reports" && action === "rewrite") {
      const report = await this.fetchReport(draftId, interaction.user.id);
      this.assertOwner(report, interaction.user.id);
      await this.requireRetryAccess(interaction.user.id);
      if (!report.resubmittable) {
        throw new AccessError(
          "not_resubmittable",
          "This denied report is no longer available for resubmission."
        );
      }
      const instruction = interaction.fields.getTextInputValue("instruction").trim();
      const details = report.reportedDetails;
      const draft: ReportDraft = {
        flow: report.flow,
        country: report.country,
        countrySelection: "override",
        reportType: report.reportType,
        rewriteRequest: {
          ...(details.reportReason === undefined
            ? {}
            : { previousReportReason: details.reportReason }),
          ...(details.context === undefined ? {} : { previousContext: details.context }),
          instruction
        },
        resubmitOfReportId: report.internalReportId,
        sendToDms: true,
        ...(details.kind === "message"
          ? {
              messageUrl: details.messageUrl,
              ...(details.messageEvidence === undefined
                ? {}
                : { messageEvidence: details.messageEvidence })
            }
          : details.kind === "profile"
            ? {
                reportedUsername: details.reportedUsername,
                ...(details.reportedUserId
                  ? { reportedUserId: details.reportedUserId }
                  : {}),
                ...(details.reportedUserSnapshot
                  ? { reportedUserSnapshot: details.reportedUserSnapshot }
                  : {}),
                ...(details.reportedUserServerId
                  ? { reportedUserServerId: details.reportedUserServerId }
                  : {}),
                profileElements: details.profileElements
              }
            : {
                guildIdOrInviteCode: details.guildIdOrInviteCode,
                guildElements: details.guildElements
              })
      };
      if (draft.flow === "message_urf" && draft.messageUrl && !draft.messageEvidence) {
        const snapshot = await this.messageResolver.resolve(draft.messageUrl);
        draft.messageEvidence = snapshot
          ? resolvedMessageEvidence(snapshot)
          : unavailableMessageEvidence();
      }
      if (draft.flow === "guild_urf" && draft.guildIdOrInviteCode) {
        const stored = await this.database.serverSnapshot(
          report.internalReportId,
          interaction.user.id
        );
        const snapshot =
          stored ?? (await this.serverResolver.resolve(draft.guildIdOrInviteCode));
        if (snapshot) draft.serverSnapshot = snapshot;
      }
      const rewriteDraftId = await this.saveDraft(interaction.user.id, draft);
      await interaction.deferReply({ flags: EPHEMERAL });
      try {
        const result = await this.executeWriterGenerate(
          interaction.user.id,
          draft,
          this.aiActor(interaction.user.id),
          async (progress) => {
            await this.deliverWriterProgress(
              interaction,
              rewriteDraftId,
              draft,
              progress
            );
          }
        );
        applyWriterResult(draft, result, "Rewritten");
        await this.replaceDraft(
          interaction.user.id,
          rewriteDraftId,
          draft
        );
        await this.deliverReview(interaction, rewriteDraftId, draft);
      } catch (error) {
        const canManualEdit = await this.preserveWriterCandidate(
          interaction.user.id,
          rewriteDraftId,
          draft,
          error
        );
        await this.deliverWriterFailure(
          interaction,
          rewriteDraftId,
          draft,
          conciseError(error),
          "regenerate",
          canManualEdit
        );
      }
      return;
    }
    if (scope === "writer" && action === "refine") {
      const draft = await this.loadDraft(interaction.user.id, draftId);
      const instruction = interaction.fields.getTextInputValue("instruction").trim();
      await interaction.deferUpdate();
      await this.deliverWriterProgress(
        interaction,
        draftId,
        draft,
        {
          stage: "write",
          country: draft.country ?? "Auto",
          reportReason: draft.reportReason ?? draft.reportBrief ?? "Auto",
          reportType: draft.reportType
            ? reportReasonLabel(draft.flow, draft.reportType)
            : "Auto"
        },
        "Refining report"
      );
      try {
        const result = await this.executeWriterRefine(
          interaction.user.id,
          draft,
          instruction,
          this.aiActor(interaction.user.id)
        );
        applyWriterResult(draft, result, "Refined");
        await this.replaceDraft(interaction.user.id, draftId, draft);
        await this.deliverReview(interaction, draftId, draft);
      } catch (error) {
        const canManualEdit = await this.preserveWriterCandidate(
          interaction.user.id,
          draftId,
          draft,
          error
        );
        await this.deliverWriterFailure(
          interaction,
          draftId,
          draft,
          conciseError(error),
          "refine",
          canManualEdit
        );
      }
      return;
    }
    if (scope === "writer" && action === "edit") {
      const draft = await this.loadDraft(interaction.user.id, draftId);
      const report = interaction.fields.getTextInputValue("report_text").trim();
      if (!report || report.length > 512) {
        throw new AccessError("invalid_report_text", "The final report must contain 1 to 512 characters.");
      }
      draft.context = report;
      if (draft.aiDisabled) {
        draft.reportReason = report;
        delete draft.writerConversation;
      } else {
        const conversation = draft.writerConversation ?? [
          { role: "user" as const, content: initialWriterPrompt() }
        ];
        draft.writerConversation = [
          ...conversation,
          { role: "user", content: "Use this manually edited text as the current report." },
          { role: "assistant", content: JSON.stringify({ report }) }
        ];
      }
      await interaction.deferUpdate();
      await this.replaceDraft(interaction.user.id, draftId, draft);
      await this.deliverReview(interaction, draftId, draft);
      return;
    }
    if (scope !== "report" || action !== "modal") return;
    const draft = await this.loadDraft(interaction.user.id, draftId);
    const preferences = interaction.fields.getCheckboxGroup("preferences");
    draft.aiDisabled = !preferences.includes("USE_AI");
    draft.sendToDms = preferences.includes("SEND_DM");
    const countryMode = interaction.fields.getStringSelectValues("country_mode")[0];
    const chooseCountry = countryMode === "CHOOSE";
    if (countryMode === "AUTO") {
      delete draft.country;
      draft.countrySelection = "auto";
    } else if (countryMode === "DEFAULT") {
      if (!draft.country) {
        throw new AccessError("invalid_country", "No saved or selected country is available.");
      }
    } else if (!chooseCountry) {
      throw new AccessError("invalid_country", "Choose a valid country option.");
    }
    const reportType = interaction.fields.getStringSelectValues("report_type")[0];
    if (reportType) {
      draft.reportType = reportType;
    } else if (draft.aiDisabled) {
      throw new AccessError("invalid_reason", "Choose a report category.");
    } else {
      delete draft.reportType;
    }
    const suppliedBrief = interaction.fields.getTextInputValue("brief").trim();
    const reportBrief =
      !draft.aiDisabled && suppliedBrief.toLocaleLowerCase("en") === "auto"
        ? ""
        : suppliedBrief;
    if (reportBrief) {
      draft.reportBrief = reportBrief;
    } else if (draft.aiDisabled) {
      throw new AccessError("invalid_report_text", "Enter the final report text.");
    } else {
      delete draft.reportBrief;
    }
    if (draft.flow === "user_urf") {
      const values = interaction.fields.getStringSelectValues("profile_elements");
      draft.profileElements = values.filter((value): value is UserProfileElement =>
        (PROFILE_ELEMENTS as readonly string[]).includes(value)
      );
    }
    if (draft.flow === "guild_urf") {
      const values = interaction.fields.getStringSelectValues("guild_elements");
      draft.guildElements = values.filter((value): value is GuildElement =>
        (GUILD_ELEMENTS as readonly string[]).includes(value)
      );
    }
    await interaction.deferReply({ flags: EPHEMERAL });
    if (draft.aiDisabled) {
      const manualText = draft.reportBrief;
      if (!manualText) {
        throw new AccessError("invalid_report_text", "Enter the final report text.");
      }
      draft.context = manualText;
      draft.reportReason = manualText;
      delete draft.writerConversation;
      delete draft.legalResearch;
      await this.replaceDraft(interaction.user.id, draftId, draft);
      if (chooseCountry || !draft.country) {
        await interaction.editReply({
          ...buildCountryPicker(this.countries, draftId, 0, false),
          allowedMentions: { parse: [] }
        });
        return;
      }
      await this.deliverReview(interaction, draftId, draft);
      return;
    }
    if (draft.flow === "message_urf" && draft.messageUrl && !draft.messageEvidence) {
      const snapshot = await this.messageResolver.resolve(draft.messageUrl);
      draft.messageEvidence = snapshot
        ? resolvedMessageEvidence(snapshot)
        : unavailableMessageEvidence();
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
    if (chooseCountry) {
      await interaction.editReply({
        ...buildCountryPicker(this.countries, draftId, 0, true),
        allowedMentions: { parse: [] }
      });
      return;
    }
    try {
      const result = await this.executeWriterGenerate(
        interaction.user.id,
        draft,
        this.aiActor(interaction.user.id),
        async (progress) => {
          await this.deliverWriterProgress(interaction, draftId, draft, progress);
        }
      );
      applyWriterResult(draft, result, "Generated");
      await this.replaceDraft(interaction.user.id, draftId, draft);
      await this.deliverReview(interaction, draftId, draft);
    } catch (error) {
      const canManualEdit = await this.preserveWriterCandidate(
        interaction.user.id,
        draftId,
        draft,
        error
      );
      await this.deliverWriterFailure(
        interaction,
        draftId,
        draft,
        conciseError(error),
        "regenerate",
        canManualEdit
      );
    }
  }

  private async handleSelect(interaction: StringSelectMenuInteraction): Promise<void> {
    const [scope, action, draftId] = customParts(interaction.customId);
    if (scope === "settings" && action === "notifications" && draftId === "digest") {
      const frequency = interaction.values[0];
      if (!(DIGEST_FREQUENCIES as readonly string[]).includes(frequency ?? "")) return;
      await interaction.deferUpdate();
      const preferences = await this.database.setDigestFrequency(
        interaction.user.id,
        frequency as DigestFrequency
      );
      await interaction.editReply(notificationSettingsView(preferences));
      return;
    }
    if (scope === "analytics" && action === "period") {
      const parts = customParts(interaction.customId);
      const view = parts.length >= 4 ? approvedAnalyticsView(parts[2]) : "overview";
      const analyticsScope = approvedAnalyticsScope(parts.length >= 4 ? parts[3] : draftId);
      const period = approvedAnalyticsPeriod(interaction.values[0]);
      await interaction.deferUpdate();
      if (view === "history") {
        const page = await this.getActionHistory(interaction.user.id, {
          period,
          limit: 25
        });
        await interaction.editReply({
          ...actionHistoryView(page, period),
          attachments: [],
          allowedMentions: { parse: [] }
        });
        return;
      }
      const analytics = await this.getAnalytics(interaction.user.id, period, analyticsScope);
      await interaction.editReply({
        ...analyticsView(analytics, view),
        allowedMentions: { parse: [] }
      });
      return;
    }
    if (scope !== "country" || action !== "select" || !draftId) {
      return;
    }
    const country = interaction.values[0];
    if (!country || (country !== "AUTO" && !this.countries.includes(country))) {
      throw new AccessError("invalid_country", "Choose a supported country.");
    }
    const draft = await this.loadDraft(interaction.user.id, draftId);
    if (country === "AUTO" && draft.aiDisabled) {
      await interaction.update(buildCountryPicker(this.countries, draftId, 0, false));
      return;
    }
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
    if (draft.aiDisabled && (!draft.reportType || !draft.reportBrief)) {
      await interaction.showModal(buildReportModal(draftId, draft));
      return;
    }
    await interaction.deferUpdate();
    if (draft.aiDisabled) {
      const manualText = draft.reportBrief;
      if (!manualText) {
        throw new AccessError("invalid_report_text", "Enter the final report text.");
      }
      draft.context = manualText.slice(0, 512);
      draft.reportReason = manualText;
      delete draft.writerConversation;
      delete draft.legalResearch;
      await this.replaceDraft(interaction.user.id, draftId, draft);
      await this.deliverReview(interaction, draftId, draft);
      return;
    }
    try {
      const result = await this.executeWriterGenerate(
        interaction.user.id,
        draft,
        this.aiActor(interaction.user.id),
        async (progress) => {
          await this.deliverWriterProgress(interaction, draftId, draft, progress);
        }
      );
      applyWriterResult(draft, result, "Generated");
      await this.replaceDraft(interaction.user.id, draftId, draft);
      await this.deliverReview(interaction, draftId, draft);
    } catch (error) {
      const canManualEdit = await this.preserveWriterCandidate(
        interaction.user.id,
        draftId,
        draft,
        error
      );
      await this.deliverWriterFailure(
        interaction,
        draftId,
        draft,
        conciseError(error),
        "regenerate",
        canManualEdit
      );
    }
  }

  private async handleButton(interaction: ButtonInteraction): Promise<void> {
    const parts = customParts(interaction.customId);
    if (parts[0] === "settings" && parts[1] === "notifications") {
      const keys: readonly NotificationPreferenceKey[] = [
        "submission_results", "actioned", "denied_reports", "denied_appeals", "appeal_progress"
      ];
      const key = parts[3] as NotificationPreferenceKey | undefined;
      if (parts[2] !== "toggle" || key === undefined || !keys.includes(key) ||
        (parts[4] !== "true" && parts[4] !== "false")) return;
      await interaction.deferUpdate();
      const preferences = await this.database.setNotificationPreference(
        interaction.user.id,
        key,
        parts[4] === "true"
      );
      await interaction.editReply(notificationSettingsView(preferences));
      return;
    }
    if (parts[0] === "analytics") {
      if (parts[1] === "history-range") {
        await interaction.showModal(actionHistoryModal());
        return;
      }
      if (parts[1] === "dm-chart") {
        const view = approvedAnalyticsView(parts[2]);
        const scope = approvedAnalyticsScope(parts[3]);
        const period = approvedAnalyticsPeriod(parts[4]);
        await interaction.deferUpdate();
        const analytics = await this.getAnalytics(interaction.user.id, period, scope);

        try {
          const [volume, reply] = await Promise.all([
            renderAnalyticsChart("volume", analytics),
            renderAnalyticsChart("reply_time", analytics)
          ]);
          const dmEmbed = new EmbedBuilder()
            .setColor(Colors.Blurple)
            .setTitle(scope === "personal" ? "Your Report Analytics Charts" : "Community Analytics Charts")
            .setDescription(`${intervalLabel(analytics)}\n\nAttached are your full 24-hour volume and Discord reply-time charts.`)
            .setImage("attachment://report-volume.png");

          await interaction.user.send({
            embeds: [dmEmbed],
            files: [
              new AttachmentBuilder(volume, { name: "report-volume.png" }),
              new AttachmentBuilder(reply, { name: "discord-reply-time.png" })
            ]
          });
          const chartView = view === "history" ? "overview" : view;
          const currentPayload = analyticsView(analytics, chartView);
          currentPayload.embeds[0]?.setFooter({ text: "✅ Full resolution charts sent to your DMs!" });
          await interaction.editReply({
            ...currentPayload,
            allowedMentions: { parse: [] }
          });
        } catch (error) {
          botLog(
            "analytics_chart_dm_failed",
            {
              permanentlyBlocked: error instanceof DiscordAPIError && error.code === 50_007,
              ...errorFields(error)
            },
            "warn"
          );
          await interaction.followUp({
            content: "Could not send full resolution charts to your DMs. Check your privacy settings.",
            flags: EPHEMERAL
          });
        }
        return;
      }
      let view: AnalyticsView;
      let scope: AnalyticsScope;
      let period: AnalyticsPeriod;
      if (parts[1] === "scope") {
        scope = approvedAnalyticsScope(parts[2]);
        view = approvedAnalyticsView(parts[3]);
        period = approvedAnalyticsPeriod(parts[4]);
      } else if (parts[1] === "view") {
        view = approvedAnalyticsView(parts[2]);
        scope = approvedAnalyticsScope(parts[3]);
        period = approvedAnalyticsPeriod(parts[4]);
      } else {
        view = approvedAnalyticsView(parts[1]);
        scope = approvedAnalyticsScope(parts[2]);
        period = approvedAnalyticsPeriod(parts[3]);
      }
      await interaction.deferUpdate();
      if (view === "history") {
        const page = await this.getActionHistory(interaction.user.id, {
          period,
          limit: 25
        });
        await interaction.editReply({
          ...actionHistoryView(page, period),
          attachments: [],
          allowedMentions: { parse: [] }
        });
        return;
      }
      const analytics = await this.getAnalytics(interaction.user.id, period, scope);
      await interaction.editReply({
        ...analyticsView(analytics, view),
        allowedMentions: { parse: [] }
      });
      return;
    }
    if (parts[0] === "reports" && parts[1] === "retry-appeal" && parts[2]) {
      await interaction.deferUpdate();
      const report = await this.fetchReport(parts[2], interaction.user.id);
      this.assertOwner(report, interaction.user.id);
      if (!report.appealRetryable) {
        throw new AccessError(
          "appeal_not_retryable",
          "This appeal is no longer available for retry."
        );
      }
      let retried: ReportDetail;
      const isSimulated = await this.isReportSimulated(parts[2], interaction.user.id);
      if (isSimulated) {
        const { report: appealed, metadata } = createSimulatedAppeal(
          report,
          interaction.id,
          interaction.user.id,
          this.config
        );
        await this.database.updateSimulatedReportByReportId(
          parts[2],
          interaction.user.id,
          appealed,
          metadata
        );
        void this.shadowbanLogger.log({
          userId: interaction.user.id,
          action: "Report Appeal Submitted (Simulated)",
          reportId: appealed.internalReportId,
          outcome: metadata.scheduledEvent,
          scheduledReplyAt: metadata.scheduledAt
        });
        retried = appealed;
      } else {
        try {
          retried = await this.api.retryAppeal(
            report.internalReportId,
            interaction.id,
            interaction.user.id
          );
        } catch (error) {
          if (error instanceof DsaApiError && error.code === "review_retry_cooldown") {
            await interaction.followUp({
              embeds: [errorEmbed(error.message)],
              flags: EPHEMERAL,
              allowedMentions: { parse: [] }
            });
            return;
          }
          throw error;
        }
      }
      const snapshot = await this.snapshotFor(retried, interaction.user.id);
      await interaction.editReply({
        content: "Appeal queued for another attempt.",
        embeds: [reportEmbed(retried, snapshot, { history: "full" })],
        components: reportRetryComponents(retried),
        allowedMentions: { parse: [] }
      });
      return;
    }
    if (parts[0] === "reports" && parts[1] === "retry" && parts[2]) {
      await interaction.deferUpdate();
      const retry = await this.retryAsNewReport(parts[2], interaction.id, interaction.user.id);
      const retried = retry.report;
      const snapshot = await this.snapshotFor(retried, interaction.user.id);
      const sourceIsStatusDm =
        interaction.message?.id && typeof this.database.statusDmMessageId === "function"
          ? interaction.message.id === (await this.database.statusDmMessageId(retry.trackingId))
          : false;
      const dmSent = await this.sendReportDm(
        interaction.user,
        retried,
        snapshot,
        retry.trackingId
      );
      await interaction.editReply({
        content: dmSent
          ? null
          : "I could not send the full status log to your DMs. Check your privacy settings.",
        embeds: [
          reportEmbed(retried, snapshot, {
            history: sourceIsStatusDm ? "full" : "dm_notice"
          })
        ],
        components: reportRetryComponents(retried),
        allowedMentions: { parse: [] }
      });
      return;
    }
    if (parts[0] === "reports" && parts[1] === "rewrite" && parts[2]) {
      const report = await this.fetchReport(parts[2], interaction.user.id);
      this.assertOwner(report, interaction.user.id);
      await this.requireRetryAccess(interaction.user.id);
      if (!report.resubmittable) {
        throw new AccessError(
          "not_resubmittable",
          "This denied report is no longer available for resubmission."
        );
      }
      await interaction.showModal(buildResubmissionRewriteModal(report.internalReportId));
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
        const resolved = await this.profileResolver.resolve(draft.profileTargetRaw);
        if (resolved) {
          draft.reportedUsername = resolved.username;
          draft.reportedUserId = resolved.userId;
          draft.reportedUserSnapshot = resolved;
        }
        if (resolved) {
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
    if (
      parts[0] === "country" &&
      parts[1] === "page" &&
      parts[2] &&
      parts[3]
    ) {
      const countryDraft = await this.loadDraft(interaction.user.id, parts[2]);
      await interaction.update(
        buildCountryPicker(
          this.countries,
          parts[2],
          Number(parts[3]),
          !countryDraft.aiDisabled
        )
      );
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
      await interaction.update(
        buildCountryPicker(this.countries, draftId, 0, !draft.aiDisabled)
      );
      return;
    }
    if (action === "brief") {
      await interaction.showModal(buildReportModal(draftId, draft));
      return;
    }
    if (action === "refine") {
      if (draft.aiDisabled) {
        throw new AccessError("ai_disabled", "AI is disabled for this report. Edit it manually.");
      }
      await interaction.showModal(buildRefinementModal(draftId));
      return;
    }
    if (action === "regenerate") {
      if (draft.aiDisabled) {
        throw new AccessError("ai_disabled", "AI is disabled for this report. Edit it manually.");
      }
      await interaction.deferUpdate();
      try {
        const result = await this.executeWriterGenerate(
          interaction.user.id,
          draft,
          this.aiActor(interaction.user.id),
          async (progress) => {
            await this.deliverWriterProgress(interaction, draftId, draft, progress);
          }
        );
        applyWriterResult(draft, result, "Regenerated");
        await this.replaceDraft(interaction.user.id, draftId, draft);
        if (draft.quickSubmit) {
          await this.submitQuickDraft(interaction, draftId, draft);
        } else {
          await this.deliverReview(interaction, draftId, draft);
        }
      } catch (error) {
        const canManualEdit = await this.preserveWriterCandidate(
          interaction.user.id,
          draftId,
          draft,
          error
        );
        await this.deliverWriterFailure(
          interaction,
          draftId,
          draft,
          conciseError(error),
          "regenerate",
          canManualEdit
        );
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
    if (draft.resubmitOfReportId) {
      await this.submitResubmissionDraft(interaction, draftId, draft);
      return;
    }
    await interaction.deferUpdate();
    let tracking: Awaited<ReturnType<BotDatabase["reserveSubmission"]>> | undefined;
    try {
      await this.requireReportAccess(interaction.user.id);
      const request = draftToCreateInput(draft, interaction.user.id);
      const isAdmin = this.isAdmin(interaction.user.id);
      const isSimulated = this.isShadowbanned(interaction.user.id);
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
        ...(draft.aiDecisions ? { aiDecisions: draft.aiDecisions } : {}),
        dmEnabled: draft.sendToDms !== false,
        adminBypass: isSimulated || shouldBypassReportCredits(
          isAdmin,
          this.config.whitelistEnabled
        ),
        isSimulated
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
      if (draft.sendToDms !== false && draft.reviewDmMessageId) {
        await this.database.saveStatusDmMessageId(
          tracking.id,
          draft.reviewDmMessageId
        );
      }
      await this.deliverWriterProgress(
        interaction,
        draftId,
        draft,
        {
          stage: "write",
          country: draft.country ?? "Auto",
          reportReason: draft.context ?? draft.reportReason ?? "Preparing submission",
          reportType: draft.reportType
            ? reportReasonLabel(draft.flow, draft.reportType)
            : "Auto"
        },
        "Submitting report"
      );
      if (isSimulated) {
        const { report: simReport, metadata } = createSimulatedReport(
          request,
          interaction.user.id,
          this.config
        );
        await this.database.saveSimulatedReport({
          trackingId: tracking.id,
          report: simReport,
          metadata
        });
        await this.database.deleteDraft(interaction.user.id, draftId);
        const dmSent =
          draft.sendToDms === false
            ? null
            : draft.reviewDmMessageId
              ? true
              : await this.sendReportDm(
                  interaction.user,
                  simReport,
                  draft.serverSnapshot,
                  tracking.id
                );
        void this.shadowbanLogger.log({
          userId: interaction.user.id,
          action: "Manual Report Submitted (Simulated)",
          reportId: simReport.internalReportId,
          flow: request.flow,
          country: request.country,
          reportType: request.reportType,
          targetUrl: draft.messageUrl,
          targetUserId: draft.reportedUserId,
          outcome: metadata.scheduledEvent,
          scheduledReplyAt: metadata.scheduledAt,
          details: draft.context ?? draft.reportReason
        });
        await interaction.editReply({
          content:
            dmSent === false
              ? "I could not send the full status log to your DMs. Check your privacy settings or use `/reports status`."
              : null,
          embeds: [
            reportEmbed(simReport, draft.serverSnapshot, {
              aiDecisions: draft.aiDecisions ?? [],
              history:
                dmSent === true &&
                interaction.message?.id !== draft.reviewDmMessageId
                  ? "dm_notice"
                  : "full"
            })
          ],
          components: reportRetryComponents(simReport),
          allowedMentions: { parse: [] }
        });
        return;
      }
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
      const dmSent =
        draft.sendToDms === false
          ? null
          : draft.reviewDmMessageId
            ? true
            : await this.sendReportDm(
                interaction.user,
                report,
                draft.serverSnapshot,
                tracking.id
              );
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
        content:
          dmSent === false
            ? "I could not send the full status log to your DMs. Check your privacy settings or use `/reports status`."
            : null,
        embeds: [
          reportEmbed(report, draft.serverSnapshot, {
            aiDecisions: draft.aiDecisions ?? [],
            history:
              dmSent === true &&
              interaction.message?.id !== draft.reviewDmMessageId
                ? "dm_notice"
                : "full"
          })
        ],
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

  private async submitResubmissionDraft(
    interaction: ButtonInteraction,
    draftId: string,
    draft: ReportDraft
  ): Promise<void> {
    await interaction.deferUpdate();
    try {
      const previousReportId = draft.resubmitOfReportId;
      if (!previousReportId) throw new Error("Resubmission draft has no predecessor.");
      const previous = await this.fetchReport(previousReportId, interaction.user.id);
      this.assertOwner(previous, interaction.user.id);
      await this.requireRetryAccess(interaction.user.id);
      if (!previous.resubmittable) {
        throw new AccessError(
          "not_resubmittable",
          "This denied report is no longer available for resubmission."
        );
      }
      const request = draftToCreateInput(draft, interaction.user.id);
      await this.deliverWriterProgress(
        interaction,
        draftId,
        draft,
        {
          stage: "write",
          country: draft.country ?? "Auto",
          reportReason: draft.context ?? draft.reportReason ?? "Preparing resubmission",
          reportType: draft.reportType
            ? reportReasonLabel(draft.flow, draft.reportType)
            : "Auto"
        },
        "Resubmitting report"
      );
      const isSimulated = await this.isReportSimulated(previousReportId, interaction.user.id);
      if (isSimulated) {
        const { report: retried, metadata } = createSimulatedReport(
          request,
          interaction.user.id,
          this.config
        );
        retried.retryOfReportId = previous.internalReportId;
        retried.retrySequence = (previous.retrySequence ?? 0) + 1;
        const trackingId = await this.database.trackSimulatedRetryReport({
          previousReportId,
          userId: interaction.user.id,
          interactionId: interaction.id,
          report: retried,
          metadata,
          ...(draft.serverSnapshot ? { serverSnapshot: draft.serverSnapshot } : {}),
          ...(draft.aiDecisions ? { aiDecisions: draft.aiDecisions } : {})
        });
        if (draft.reviewDmMessageId) {
          await this.database.saveStatusDmMessageId(trackingId, draft.reviewDmMessageId);
        }
        await this.database.deleteDraft(interaction.user.id, draftId);
        const dmSent = await this.sendReportDm(
          interaction.user,
          retried,
          draft.serverSnapshot,
          trackingId
        );
        void this.shadowbanLogger.log({
          userId: interaction.user.id,
          action: "Resubmission Report Submitted (Simulated)",
          reportId: retried.internalReportId,
          outcome: metadata.scheduledEvent,
          scheduledReplyAt: metadata.scheduledAt
        });
        await interaction.editReply({
          content: dmSent
            ? null
            : "I could not send the full status log to your DMs. Check your privacy settings.",
          embeds: [
            reportEmbed(retried, draft.serverSnapshot, {
              history:
                interaction.message?.id === draft.reviewDmMessageId ? "full" : "dm_notice",
              aiDecisions: draft.aiDecisions ?? []
            })
          ],
          components: reportRetryComponents(retried),
          allowedMentions: { parse: [] }
        });
        return;
      }
      let report = await this.api.retryReport(
        previousReportId,
        interaction.id,
        interaction.user.id,
        {
          reportReason: request.reportReason,
          ...(request.context === undefined ? {} : { context: request.context })
        }
      );
      const trackingId = await this.database.trackRetryReport(
        previousReportId,
        interaction.user.id,
        interaction.id,
        report,
        encryptJson(request, this.config.dataEncryptionKey),
        draft.aiDecisions
      );
      if (draft.reviewDmMessageId) {
        await this.database.saveStatusDmMessageId(trackingId, draft.reviewDmMessageId);
      }
      await this.database.deleteDraft(interaction.user.id, draftId);
      const dmSent = await this.sendReportDm(
        interaction.user,
        report,
        draft.serverSnapshot,
        trackingId
      );
      for (let attempt = 0; attempt < 5; attempt += 1) {
        if (report.status === "submitted" || report.status === "failed") break;
        await delay(2_000);
        report = await this.api.report(report.internalReportId);
      }
      await this.database.observeReport(trackingId, report);
      await interaction.editReply({
        content: dmSent
          ? null
          : "I could not send the full status log to your DMs. Check your privacy settings.",
        embeds: [
          reportEmbed(report, draft.serverSnapshot, {
            history:
              interaction.message?.id === draft.reviewDmMessageId ? "full" : "dm_notice",
            aiDecisions: draft.aiDecisions ?? []
          })
        ],
        components: reportRetryComponents(report),
        allowedMentions: { parse: [] }
      });
    } catch (error) {
      await interaction.editReply({
        content: null,
        embeds: [errorEmbed(conciseError(error))],
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
