import type { Client, Message } from "discord.js";
import { describe, expect, it } from "vitest";

import {
  capturedMessageEvidence,
  MessageResolver,
  snapshotMessage,
  unavailableMessageEvidence
} from "../src/message-resolver.js";

describe("message snapshots", () => {
  it("captures useful report evidence without adding permanent storage", () => {
    const evidence = capturedMessageEvidence({
      id: "323456789012345678",
      channelId: "223456789012345678",
      channel: { name: "reports" },
      guildId: "123456789012345678",
      guild: { name: "Example server" },
      author: {
        id: "423456789012345678",
        username: "example",
        globalName: "Example Display",
        bot: false,
        displayAvatarURL: () => "https://cdn.discordapp.com/avatars/423/avatar.png"
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
            contentType: "image/png",
            size: 1234,
            spoiler: true
          }
        ]
      ]),
      embeds: [
        { title: "Evidence", description: "Embedded text", url: "https://example.test/e" }
      ]
    } as unknown as Message, "context_menu", "2026-07-20T00:01:00.000Z");
    expect(evidence).toMatchObject({
      source: "context_menu",
      status: "captured",
      capturedAt: "2026-07-20T00:01:00.000Z",
      snapshot: {
        content: "Message evidence",
        channelName: "reports",
        serverName: "Example server",
        authorUsername: "example",
        authorAvatarUrl: "https://cdn.discordapp.com/avatars/423/avatar.png",
        attachments: [{ size: 1234, spoiler: true }],
        embeds: [{ title: "Evidence", description: "Embedded text" }]
      }
    });
    expect(evidence.snapshot.attachments).toHaveLength(1);
  });

  it("records inaccessible pasted links without inventing an author", () => {
    expect(unavailableMessageEvidence("2026-07-20T00:01:00.000Z")).toEqual({
      source: "message_link",
      status: "unavailable",
      attemptedAt: "2026-07-20T00:01:00.000Z"
    });
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
        bot: false,
        displayAvatarURL: () => "https://cdn.discordapp.com/avatars/423/stage.png"
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
        bot: false,
        displayAvatarURL: () => "https://cdn.discordapp.com/avatars/423/stage.png"
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
        bot: false,
        displayAvatarURL: () => "https://cdn.discordapp.com/avatars/423/stage.png"
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
