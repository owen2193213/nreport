import type {
  CapturedMessageEvidence,
  ReportedMessageSnapshot,
  ReportedReferencedMessageSnapshot,
  UnavailableMessageEvidence
} from "@nreport/contracts";
import type { Client, Message } from "discord.js";


const MESSAGE_URL =
  /^https:\/\/(?:www\.)?discord\.com\/channels\/(?:@me|\d+)\/(\d+)\/(\d+)$/;

function snapshotReferencedMessage(
  referenced: Message | null | undefined
): ReportedReferencedMessageSnapshot | null {
  if (!referenced || !referenced.author) return null;
  const attachments = referenced.attachments
    ? [...referenced.attachments.values()].map((attachment) => ({
        name: attachment.name,
        contentType: attachment.contentType,
        size: attachment.size,
        spoiler: attachment.spoiler
      }))
    : [];
  return {
    messageId: referenced.id,
    authorId: referenced.author.id,
    authorUsername: referenced.author.username,
    authorDisplayName:
      referenced.member?.displayName ?? referenced.author.globalName ?? null,
    authorBot: referenced.author.bot,
    content: referenced.content,
    attachments
  };
}

export function snapshotMessage(message: Message): ReportedMessageSnapshot {
  const channel = message.channel;
  const referenced = (message as { referencedMessage?: Message | null }).referencedMessage;
  const referencedMessage = snapshotReferencedMessage(referenced);
  return {
    messageId: message.id,
    channelId: message.channelId,
    channelName: channel && "name" in channel ? channel.name : null,
    serverId: message.guildId,
    serverName: message.guild?.name ?? null,
    authorId: message.author.id,
    authorUsername: message.author.username,
    authorDisplayName: message.member?.displayName ?? message.author.globalName,
    authorAvatarUrl:
      typeof message.author.displayAvatarURL === "function"
        ? message.author.displayAvatarURL()
        : null,
    authorBot: message.author.bot,
    content: message.content,
    createdAt: message.createdAt.toISOString(),
    attachments: [...message.attachments.values()].map((attachment) => ({
      name: attachment.name,
      url: attachment.url,
      contentType: attachment.contentType,
      size: attachment.size,
      spoiler: attachment.spoiler
    })),
    embeds: message.embeds.map((embed) => ({
      title: embed.title,
      description: embed.description,
      url: embed.url
    })),
    ...(referencedMessage ? { referencedMessage } : {})
  };
}

export function capturedMessageEvidence(
  message: Message,
  source: CapturedMessageEvidence["source"],
  capturedAt = new Date().toISOString()
): CapturedMessageEvidence {
  return { source, status: "captured", capturedAt, snapshot: snapshotMessage(message) };
}

export function unavailableMessageEvidence(
  attemptedAt = new Date().toISOString()
): UnavailableMessageEvidence {
  return { source: "message_link", status: "unavailable", attemptedAt };
}

export function resolvedMessageEvidence(
  snapshot: ReportedMessageSnapshot,
  capturedAt = new Date().toISOString()
): CapturedMessageEvidence {
  return { source: "message_link", status: "captured", capturedAt, snapshot };
}

export class MessageResolver {
  public constructor(private readonly client: Client) {}

  public async resolve(messageUrl: string): Promise<ReportedMessageSnapshot | null> {
    const match = messageUrl.match(MESSAGE_URL);
    const channelId = match?.[1];
    const messageId = match?.[2];
    if (!channelId || !messageId) return null;
    const channel = await this.client.channels.fetch(channelId).catch(() => null);
    if (!channel?.isTextBased() || !("messages" in channel)) return null;
    const message = await channel.messages.fetch(messageId).catch(() => null);
    return message ? snapshotMessage(message) : null;
  }
}
