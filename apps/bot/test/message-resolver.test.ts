import type { Client, Message } from "discord.js";
import { describe, expect, it } from "vitest";

import { MessageResolver, snapshotMessage } from "../src/message-resolver.js";

describe("message snapshots", () => {
  it("captures useful report evidence without adding permanent storage", () => {
    const snapshot = snapshotMessage({
      id: "323456789012345678",
      channelId: "223456789012345678",
      channel: { name: "reports" },
      guildId: "123456789012345678",
      guild: { name: "Example server" },
      author: {
        id: "423456789012345678",
        username: "example",
        globalName: "Example Display",
        bot: false
      },
      member: null,
      content: "Message evidence",
      createdAt: new Date("2026-07-20T00:00:00.000Z"),
      attachments: new Map([
        [
          "1",
          {
            name: "evidence.png",
            url: "https://cdn.discordapp.com/evidence.png",
            contentType: "image/png"
          }
        ]
      ]),
      embeds: []
    } as unknown as Message);
    expect(snapshot).toMatchObject({
      content: "Message evidence",
      channelName: "reports",
      serverName: "Example server",
      authorUsername: "example"
    });
    expect(snapshot.attachments).toHaveLength(1);
  });

  it("preserves Stage or voice chat evidence when the channel is not cached", () => {
    const snapshot = snapshotMessage({
      id: "323456789012345679",
      channelId: "223456789012345679",
      channel: null,
      guildId: "123456789012345678",
      guild: { name: "Example server" },
      author: {
        id: "423456789012345678",
        username: "speaker",
        globalName: "Stage Speaker",
        bot: false
      },
      member: null,
      content: "Message sent in Stage chat",
      createdAt: new Date("2026-07-20T00:00:00.000Z"),
      attachments: new Map(),
      embeds: []
    } as unknown as Message);

    expect(snapshot).toMatchObject({
      channelId: "223456789012345679",
      channelName: null,
      content: "Message sent in Stage chat",
      serverName: "Example server"
    });
  });

  it("captures the name of a hydrated Stage or voice channel", () => {
    const snapshot = snapshotMessage({
      id: "323456789012345680",
      channelId: "223456789012345680",
      channel: { name: "Town Hall Stage" },
      guildId: "123456789012345678",
      guild: { name: "Example server" },
      author: {
        id: "423456789012345678",
        username: "speaker",
        globalName: null,
        bot: false
      },
      member: null,
      content: "Hydrated Stage message",
      createdAt: new Date("2026-07-20T00:00:00.000Z"),
      attachments: new Map(),
      embeds: []
    } as unknown as Message);

    expect(snapshot.channelName).toBe("Town Hall Stage");
  });

  it("resolves pasted links from a Stage or voice channel with text chat", async () => {
    const message = {
      id: "323456789012345681",
      channelId: "223456789012345681",
      channel: { name: "Town Hall Stage" },
      guildId: "123456789012345678",
      guild: { name: "Example server" },
      author: {
        id: "423456789012345678",
        username: "speaker",
        globalName: null,
        bot: false
      },
      member: null,
      content: "Stage chat evidence",
      createdAt: new Date("2026-07-20T00:00:00.000Z"),
      attachments: new Map(),
      embeds: []
    } as unknown as Message;
    const channel = {
      isTextBased: () => true,
      messages: { fetch: () => Promise.resolve(message) }
    };
    const client = {
      channels: { fetch: () => Promise.resolve(channel) }
    } as unknown as Client;

    const snapshot = await new MessageResolver(client).resolve(
      "https://discord.com/channels/123456789012345678/223456789012345681/323456789012345681"
    );

    expect(snapshot).toMatchObject({
      channelName: "Town Hall Stage",
      content: "Stage chat evidence"
    });
  });
});
