import type { Message } from "discord.js";
import { describe, expect, it } from "vitest";

import { snapshotMessage } from "../src/message-resolver.js";

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
});
