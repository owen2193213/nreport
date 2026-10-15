import { describe, expect, it } from "vitest";
import { Client, MessageContextMenuCommandInteraction } from "discord.js";
import { ApplicationCommandType, InteractionType } from "discord-api-types/v10";

const channelId = "123456789012345678";
const messageId = "123456789012345679";
const userId = "123456789012345680";

const resolvedMessage = {
  id: messageId,
  channel_id: channelId,
  author: { id: userId, username: "test", discriminator: "0", avatar: null },
  type: 0,
  content: "",
  attachments: [],
  embeds: [],
  components: [],
  flags: 0,
  poll: {
    question: { text: "Test question?" },
    answers: [
      { answer_id: 1, poll_media: { text: "Yes" } },
      { answer_id: 2, poll_media: { text: "No" } }
    ],
    expiry: "2026-10-02T00:00:00.000Z",
    allow_multiselect: false,
    layout_type: 1
  }
};

describe("discord.js poll messages with uncached channels", () => {
  it("constructs a message context-menu target and preserves its channel and poll", async () => {
    const client = new Client({ intents: [] });
    try {
      const interaction = Reflect.construct(MessageContextMenuCommandInteraction, [client, {
        type: InteractionType.ApplicationCommand,
        id: "123456789012345681",
        application_id: "123456789012345682",
        token: "test-token",
        version: 1,
        app_permissions: "0",
        locale: "en-US",
        entitlements: [],
        authorizing_integration_owners: {},
        data: {
          id: "123456789012345683",
          name: "Report message",
          type: ApplicationCommandType.Message,
          target_id: messageId,
          resolved: { messages: { [messageId]: resolvedMessage } }
        },
        user: { id: userId, username: "test", discriminator: "0", avatar: null }
      } as never]) as MessageContextMenuCommandInteraction;

      const target = interaction.options.getMessage("message", true);

      expect(target.id).toBe(messageId);
      expect(target.channelId).toBe(channelId);
      expect(target.poll).not.toBeNull();
      expect(target.poll?.channelId).toBe(channelId);
      expect([...target.poll!.answers.keys()]).toEqual([1, 2]);
      expect(target.poll?.channel ?? null).toBeNull();
    } finally {
      await client.destroy();
    }
  });
});
