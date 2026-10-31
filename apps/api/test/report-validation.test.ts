import { describe, expect, it } from "vitest";

import { parseCreateReportInput, parseRetryReportInput, toReportDraft } from "../src/validation.js";

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

  it.each(["", "   "])("preserves intentionally blank manual report text (%j)", (finalText) => {
    const input = parseCreateReportInput({
      flow: "message",
      useAi: false,
      country: "DE",
      category: "sub_other_hate_speech",
      finalText,
      target: { messageUrl: "https://discord.com/channels/@me/123456789012345678/123456789012345679" }
    });
    expect(input).toMatchObject({ useAi: false, finalText: "", description: "" });
    expect(toReportDraft({ request: input, country: "DE", category: "sub_other_hate_speech", description: "", finalText: "" }, "Reporter")).toMatchObject({ context: "" });
  });

  it("allows an edit_manual retry to clear the report text", () => {
    expect(parseRetryReportInput({
      mode: "edit_manual", country: "DE", category: "sub_other_hate_speech", finalText: ""
    })).toEqual({ mode: "edit_manual", country: "DE", category: "sub_other_hate_speech", finalText: "" });
  });

  it.each([undefined, null, 1, "x".repeat(513)])("rejects missing, non-string, or oversized manual text (%j)", (finalText) => {
    const fields = { country: "DE", category: "sub_other_hate_speech", finalText };
    expect(() => parseCreateReportInput({
      ...fields, flow: "message", useAi: false,
      target: { messageUrl: "https://discord.com/channels/@me/123456789012345678/123456789012345679" }
    })).toThrow(/finalText/);
    expect(() => parseRetryReportInput({ ...fields, mode: "edit_manual" })).toThrow(/finalText/);
  });

  it("still forbids even empty client-written finalText in AI mode", () => {
    expect(() => parseCreateReportInput({
      flow: "message", useAi: true, finalText: "",
      target: { messageUrl: "https://discord.com/channels/@me/123456789012345678/123456789012345679" }
    })).toThrow(/finalText.*useAi/i);
  });
});
