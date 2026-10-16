import { describe, expect, it } from "vitest";

import { PayloadValidationError } from "../src/errors.js";
import { buildSubmissionPayload } from "../src/payload.js";
import type { GuildReportDraft, MessageReportDraft } from "../src/types.js";
import { createGuildMenu, createMessageMenu } from "./fixtures.js";

const draft: MessageReportDraft = {
  flow: "message_urf",
  reporter: {
    country: "DE",
    legalName: "Jason McDonell",
    username: "user3212"
  },
  messageUrl:
    "https://discord.com/channels/1273300509318578227/1526327580456779797/1527300404998832138",
  reportType: "sub_other_cybercrime",
  context: "This person is spreading malware."
};

const guildDraft: GuildReportDraft = {
  flow: "guild_urf",
  reporter: { country: "DE", legalName: "Jason McDonell" },
  guildIdOrInviteCode: "1273300509318578227",
  guildElements: ["other", "welcome_screen_description", "channel_names"],
  reportType: "sub_other_cybercrime",
  context:
    "The server spreads malware in the form of cheat exploits in .exe files -- they are python key-loggers."
};

describe("buildSubmissionPayload", () => {
  it("builds the captured message payload shape from semantic input", () => {
    const payload = buildSubmissionPayload(createMessageMenu(), draft, "token");

    expect(payload.name).toBe("message_urf");
    expect(payload.breadcrumbs).toEqual([64, 60, 147, 150, 78, 77]);
    expect(payload.elements).toMatchObject({
      reporter_country: "DE",
      reporter_legal_name: "Jason McDonell",
      reporter_username: "user3212",
      reported_message_url: draft.messageUrl,
      dsa_free_text: "This person is spreading malware.",
      confirmation_select: ["validation"]
    });
    expect(payload.email_token).toBe("token");
  });

  it("validates the message URL against the live-menu pattern", () => {
    expect(() =>
      buildSubmissionPayload(
        createMessageMenu(),
        { ...draft, messageUrl: "https://example.com/not-a-message" },
        "token"
      )
    ).toThrow(PayloadValidationError);
  });

  it("rejects an invalid country option", () => {
    expect(() =>
      buildSubmissionPayload(
        createMessageMenu(),
        { ...draft, reporter: { ...draft.reporter, country: "US" } },
        "token"
      )
    ).toThrow(PayloadValidationError);
  });

  it("matches the confirmed guild submission payload and breadcrumb path", () => {
    const payload = buildSubmissionPayload(createGuildMenu(), guildDraft, "guild-token");

    expect(payload).toEqual({
      version: "1.0",
      variant: "1",
      language: "en",
      breadcrumbs: [67, 66, 65, 155, 78, 77],
      elements: {
        reporter_country: "DE",
        reporter_legal_name: "Jason McDonell",
        reported_guild_id_or_invite_code: "1273300509318578227",
        guild_select: ["other", "welcome_screen_description", "channel_names"],
        dsa_free_text: guildDraft.context,
        confirmation_select: ["validation"]
      },
      email_token: "guild-token",
      name: "guild_urf"
    });
  });
});
