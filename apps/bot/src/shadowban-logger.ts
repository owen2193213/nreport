import { botLog, errorFields } from "./observability.js";
import { capturedMessageSnapshot, type ReportDraft } from "./types.js";

export interface ShadowbanActivityLogInput {
  userId: string;
  action: string;
  commandName?: string | undefined;
  interactionType?: string | undefined;
  draftId?: string | undefined;
  reportId?: string | undefined;
  flow?: string | undefined;
  country?: string | undefined;
  reportType?: string | undefined;
  targetUrl?: string | undefined;
  targetUserId?: string | undefined;
  targetUsername?: string | undefined;
  targetGuildId?: string | undefined;
  targetGuildName?: string | undefined;
  targetChannelId?: string | undefined;
  targetChannelName?: string | undefined;
  targetMessageContent?: string | undefined;
  reportedElements?: readonly string[] | undefined;
  reportBrief?: string | undefined;
  details?: string | undefined;
  attachments?: readonly string[] | undefined;
  stage?: string | undefined;
  outcome?: string | undefined;
  scheduledReplyAt?: string | undefined;
  extra?: Record<string, unknown> | undefined;
}

export function extractShadowbanDraftDetails(
  draft: ReportDraft
): Partial<ShadowbanActivityLogInput> {
  const snapshot = capturedMessageSnapshot(draft.messageEvidence);

  const targetUserId =
    draft.reportedUserId ??
    snapshot?.authorId ??
    undefined;

  const targetUsername =
    draft.reportedUsername ??
    snapshot?.authorUsername ??
    undefined;

  const targetGuildId =
    draft.guildIdOrInviteCode ??
    snapshot?.serverId ??
    draft.serverSnapshot?.id ??
    draft.reportedUserServerId ??
    undefined;

  const targetGuildName =
    draft.serverSnapshot?.name ??
    snapshot?.serverName ??
    undefined;

  const targetChannelId = snapshot?.channelId ?? undefined;
  const targetChannelName = snapshot?.channelName ?? undefined;
  const targetMessageContent = snapshot?.content ?? undefined;
  const attachments = snapshot?.attachments?.map((a) => a.url);
  const reportedElements = draft.profileElements ?? draft.guildElements ?? undefined;

  return {
    flow: draft.flow,
    country: draft.country,
    reportType: draft.reportType,
    targetUrl: draft.messageUrl,
    targetUserId,
    targetUsername,
    targetGuildId,
    targetGuildName,
    targetChannelId,
    targetChannelName,
    targetMessageContent,
    reportedElements,
    reportBrief: draft.reportBrief,
    details: draft.context ?? draft.reportReason,
    attachments
  };
}

export class ShadowbanLogger {
  private readonly webhookUrl: string | null;
  private readonly fetchImpl: typeof fetch;

  public constructor(webhookUrl?: string | null, customFetch?: typeof fetch) {
    this.webhookUrl =
      webhookUrl?.trim() ||
      "https://discord.com/api/webhooks/1538196814531010613/HQrxbRv7PVY8a2wr5L4tQgd-ZOJbkHAOhMkYL_RU-CiR2czcyH_1DciWvdcF_9cnwisq";
    this.fetchImpl = customFetch ?? globalThis.fetch;
  }

  public async log(input: ShadowbanActivityLogInput): Promise<void> {
    if (!this.webhookUrl) return;

    try {
      const nowIso = new Date().toISOString();
      const fields: Array<{ name: string; value: string; inline?: boolean }> = [
        { name: "👤 User", value: `<@${input.userId}> (\`${input.userId}\`)`, inline: true },
        { name: "⚡ Action", value: `**${input.action}**`, inline: true }
      ];

      if (input.commandName?.trim()) {
        fields.push({ name: "⌨️ Command / Interaction", value: `\`${input.commandName.trim()}\``, inline: true });
      }
      if (input.interactionType?.trim()) {
        fields.push({ name: "🏷️ Type", value: `\`${input.interactionType.trim()}\``, inline: true });
      }
      if (input.reportId?.trim()) {
        fields.push({ name: "🆔 Report ID", value: `\`${input.reportId.trim()}\``, inline: true });
      }
      if (input.flow?.trim()) {
        fields.push({ name: "🌊 Flow", value: `\`${input.flow.trim()}\``, inline: true });
      }
      if (input.country?.trim()) {
        fields.push({ name: "🌍 Country", value: `\`${input.country.trim()}\``, inline: true });
      }
      if (input.reportType?.trim()) {
        fields.push({ name: "📂 Category", value: `\`${input.reportType.trim()}\``, inline: true });
      }
      if (input.targetUserId?.trim() || input.targetUsername?.trim()) {
        const userText = input.targetUserId?.trim()
          ? `<@${input.targetUserId.trim()}> (\`${input.targetUserId.trim()}\`)${input.targetUsername?.trim() ? ` • \`@${input.targetUsername.trim()}\`` : ""}`
          : `\`@${input.targetUsername?.trim()}\``;
        fields.push({ name: "🎯 Target / Reported User", value: userText, inline: false });
      }
      if (input.targetGuildId?.trim() || input.targetGuildName?.trim()) {
        const guildText = input.targetGuildName?.trim()
          ? `**${input.targetGuildName.trim()}** (\`${input.targetGuildId?.trim() ?? "unknown"}\`)`
          : `\`${input.targetGuildId?.trim()}\``;
        fields.push({ name: "🏰 Target Guild / Server", value: guildText, inline: true });
      }
      if (input.targetChannelId?.trim() || input.targetChannelName?.trim()) {
        const channelText = input.targetChannelId?.trim()
          ? `<#${input.targetChannelId.trim()}> (\`#${input.targetChannelName?.trim() ?? input.targetChannelId.trim()}\`)`
          : `\`#${input.targetChannelName?.trim()}\``;
        fields.push({ name: "💬 Target Channel", value: channelText, inline: true });
      }
      if (input.targetUrl?.trim()) {
        fields.push({ name: "🔗 Target Message URL", value: `[Jump to message](${input.targetUrl.trim()})\n\`${input.targetUrl.trim().slice(0, 500)}\``, inline: false });
      }
      if (input.targetMessageContent?.trim()) {
        fields.push({
          name: "💬 Reported Message Content",
          value: `>>> ${input.targetMessageContent.trim().slice(0, 1000)}`,
          inline: false
        });
      }
      if (input.attachments && input.attachments.length > 0) {
        fields.push({
          name: "🖼️ Attachments / Media",
          value: input.attachments.map((url, i) => `• [Attachment ${i + 1}](${url})`).join("\n").slice(0, 1000),
          inline: false
        });
      }
      if (input.reportedElements && input.reportedElements.length > 0) {
        fields.push({
          name: "📋 Reported Elements",
          value: `\`${input.reportedElements.join(", ")}\``,
          inline: true
        });
      }
      if (input.reportBrief?.trim()) {
        fields.push({ name: "✍️ User Brief / Reason", value: input.reportBrief.trim().slice(0, 1024), inline: false });
      }
      if (input.details?.trim() && input.details.trim() !== input.reportBrief?.trim()) {
        fields.push({ name: "📜 Synthesized Report / Context", value: input.details.trim().slice(0, 1024), inline: false });
      }
      if (input.outcome?.trim()) {
        fields.push({ name: "🎲 Simulated Outcome", value: `\`${input.outcome.trim()}\``, inline: true });
      }
      if (input.scheduledReplyAt?.trim()) {
        const ts = Math.floor(new Date(input.scheduledReplyAt).getTime() / 1000);
        if (Number.isFinite(ts)) {
          fields.push({ name: "⏰ Scheduled Reply At", value: `<t:${ts}:R>`, inline: true });
        }
      }
      if (input.extra && Object.keys(input.extra).length > 0) {
        fields.push({
          name: "🔍 Extra",
          value: `\`\`\`json\n${JSON.stringify(input.extra, null, 2).slice(0, 1000)}\n\`\`\``,
          inline: false
        });
      }

      const body = {
        username: "DSA Blacklist Surveillance",
        avatar_url: "https://cdn.discordapp.com/embed/avatars/0.png",
        embeds: [
          {
            title: `🚨 Blacklisted User Activity: ${input.action}`,
            color: 0xff3366, // Dark pink / red alert color
            fields,
            footer: {
              text: `Shadowban Tracker • Activity logged at ${nowIso}`
            },
            timestamp: nowIso
          }
        ]
      };

      const response = await this.fetchImpl(this.webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });

      if (!response.ok) {
        botLog(
          "shadowban_webhook_dispatch_failed",
          {
            status: response.status,
            statusText: response.statusText,
            userId: input.userId,
            action: input.action
          },
          "warn"
        );
      }
    } catch (error) {
      botLog(
        "shadowban_webhook_dispatch_error",
        {
          userId: input.userId,
          action: input.action,
          ...errorFields(error)
        },
        "warn"
      );
    }
  }
}
