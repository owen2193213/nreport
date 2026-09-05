import { describe, expect, it } from "vitest";

import { parseCreateReportInput } from "../src/validation.js";

describe("account-owned report input", () => {
  it("accepts unresolved AI hints and rejects client-supplied final text", () => {
    expect(
      parseCreateReportInput({
        flow: "server",
        useAi: true,
        target: { guildIdOrInviteCode: "discord-developers", guildElements: ["name"] },
        description: "A potentially illegal server name."
      })
    ).toMatchObject({ flow: "server", useAi: true });

    expect(() =>
      parseCreateReportInput({
        flow: "server",
        useAi: true,
        target: { guildIdOrInviteCode: "discord-developers", guildElements: ["name"] },
        finalText: "Client-written text"
      })
    ).toThrow(/finalText.*useAi/i);
  });

  it("requires all resolved manual fields and defaults description to finalText", () => {
    expect(
      parseCreateReportInput({
        flow: "message",
        useAi: false,
        country: "de",
        category: "sub_other_hate_speech",
        finalText: "This message appears to violate German law.",
        target: {
          messageUrl: "https://discord.com/channels/@me/123456789012345678/123456789012345679"
        }
      })
    ).toMatchObject({
      country: "DE",
      description: "This message appears to violate German law."
    });

    expect(() =>
      parseCreateReportInput({
        flow: "message",
        useAi: false,
        country: "DE",
        category: "sub_other_hate_speech",
        target: {
          messageUrl: "https://discord.com/channels/@me/123456789012345678/123456789012345679"
        }
      })
    ).toThrow(/finalText/);
  });

  it("rejects submitter identity and mismatched target shapes", () => {
    expect(() =>
      parseCreateReportInput({
        flow: "message",
        useAi: true,
        submitterDiscordUserId: "123456789012345678",
        target: {
          messageUrl: "https://discord.com/channels/@me/123456789012345678/123456789012345679"
        }
      })
    ).toThrow(/submitterDiscordUserId/);

    expect(() =>
      parseCreateReportInput({
        flow: "profile",
        useAi: true,
        target: { guildIdOrInviteCode: "invite", guildElements: ["name"] }
      })
    ).toThrow(/reportedUsername/);
  });
});
