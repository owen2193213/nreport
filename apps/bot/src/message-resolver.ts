import type { Client, Message } from "discord.js";

import type { MessageSnapshot } from "./types.js";

const MESSAGE_URL =
  /^https:\/\/(?:www\.)?discord\.com\/channels\/(?:@me|\d+)\/(\d+)\/(\d+)$/;

export function snapshotMessage(message: Message): MessageSnapshot {
  const channel = message.channel;
  return {
    messageId: message.id,
    channelId: message.channelId,
    channelName: channel && "name" in channel ? channel.name : null,
    serverId: message.guildId,
    serverName: message.guild?.name ?? null,
    authorId: message.author.id,
    authorUsername: message.author.username,
    authorDisplayName: message.member?.displayName ?? message.author.globalName,
    authorBot: message.author.bot,
    content: message.content,
    createdAt: message.createdAt.toISOString(),
    attachments: [...message.attachments.values()].map((attachment) => ({
      name: attachment.name,
      url: attachment.url,
      contentType: attachment.contentType
    })),
    embeds: message.embeds.map((embed) => ({
      title: embed.title,
      description: embed.description,
      url: embed.url
    }))
  };
}

export class MessageResolver {
  public constructor(private readonly client: Client) {}

  public async resolve(messageUrl: string): Promise<MessageSnapshot | null> {
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
