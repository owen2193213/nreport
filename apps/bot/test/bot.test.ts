import { randomBytes } from "node:crypto";

import {
  ApplicationCommandType,
  ApplicationIntegrationType,
  InteractionContextType
} from "discord.js";
import { describe, expect, it } from "vitest";

import { COMMANDS } from "../src/commands.js";
import {
  decryptJson,
  encryptJson,
  generateAccessKey,
  hashAccessKey
} from "../src/crypto.js";
import { renderNotification } from "../src/notifier.js";
import {
  buildCountryPicker,
  buildReportModal,
  buildReview,
  draftToCreateInput
} from "../src/ui.js";

describe("Discord command registration", () => {
  it("registers user-installed commands in every requested interaction context", () => {
    expect(COMMANDS).toHaveLength(6);
    for (const command of COMMANDS) {
      expect(command.integration_types).toEqual([ApplicationIntegrationType.UserInstall]);
      expect(command.contexts).toEqual([
        InteractionContextType.Guild,
        InteractionContextType.BotDM,
        InteractionContextType.PrivateChannel
      ]);
    }
  });

  it("registers Apps → Report Message as a message context command", () => {
    const command = COMMANDS.find((candidate) => candidate.name === "Report Message");
    expect(command?.type).toBe(ApplicationCommandType.Message);
  });
});

describe("bot cryptography", () => {
  it("generates one-time high-entropy keys and stores stable peppered hashes", () => {
    const generated = generateAccessKey("p".repeat(32));
    expect(generated.code).toMatch(/^dsa_[A-Za-z0-9_-]{40,}$/);
    expect(generated.hash).toBe(hashAccessKey(generated.code, "p".repeat(32)));
    expect(generated.code).not.toContain(generated.hash);
  });

  it("encrypts and authenticates sensitive report drafts", () => {
    const key = randomBytes(32);
    const encrypted = encryptJson({ context: "sensitive", country: "DE" }, key);
    expect(encrypted).not.toContain("sensitive");
    expect(decryptJson(encrypted, key)).toEqual({ context: "sensitive", country: "DE" });
    expect(() => decryptJson(`${encrypted.slice(0, -1)}A`, key)).toThrow();
  });
});

describe("report UI", () => {
  it("fits the 27-country list into paged Discord select menus", () => {
    const countries = Array.from({ length: 27 }, (_, index) => `C${index}`);
    const first = buildCountryPicker(countries, "draft-id", 0);
    const second = buildCountryPicker(countries, "draft-id", 1);
    const firstSelect = first.components[0]?.toJSON().components[0];
    const secondSelect = second.components[0]?.toJSON().components[0];
    expect(first.components[0]?.toJSON().components).toHaveLength(1);
    expect(firstSelect && "options" in firstSelect ? firstSelect.options : []).toHaveLength(24);
    expect(secondSelect && "options" in secondSelect ? secondSelect.options : []).toHaveLength(3);
  });

  it("builds flow-specific modals within Discord's five-component limit", () => {
    const message = buildReportModal("draft", { flow: "message_urf", country: "DE" }).toJSON();
    const profile = buildReportModal("draft", {
      flow: "user_urf",
      country: "DE",
      reportedUsername: "example"
    }).toJSON();
    const guild = buildReportModal("draft", { flow: "guild_urf", country: "DE" }).toJSON();
    expect(message.components.length).toBeLessThanOrEqual(5);
    expect(profile.components.length).toBeLessThanOrEqual(5);
    expect(guild.components.length).toBeLessThanOrEqual(5);
  });

  it("converts a reviewed message draft into the canonical API request", () => {
    expect(
      draftToCreateInput(
        {
          flow: "message_urf",
          country: "DE",
          reportType: "sub_other_hate_speech",
          messageUrl:
            "https://discord.com/channels/@me/123456789012345678/123456789012345679",
          context: "The message contains unlawful hate speech."
        },
        "1197857362942378017"
      )
    ).toEqual({
      flow: "message_urf",
      country: "DE",
      reportType: "sub_other_hate_speech",
      submitterDiscordUserId: "1197857362942378017",
      messageUrl: "https://discord.com/channels/@me/123456789012345678/123456789012345679",
      context: "The message contains unlawful hate speech."
    });
  });

  it("keeps review messages below Discord's content limit", () => {
    const review = buildReview("draft", {
      flow: "message_urf",
      country: "DE",
      reportType: "sub_other_hate_speech",
      messageUrl: `https://discord.com/channels/@me/${"1".repeat(18)}/${"2".repeat(18)}`,
      context: "x".repeat(4000)
    });
    expect(review.content.length).toBeLessThan(2000);
  });

  it("renders safe lifecycle DMs without target identifiers or free-text context", () => {
    const rendered = renderNotification({
      country: "DE",
      discordReportId: "1527695430949798110",
      discordStatus: "received",
      flow: "message_urf",
      internalReportId: "report-1",
      lifecycleAttempt: 1,
      reportType: "sub_other_hate_speech",
      retryable: false,
      status: "submitted",
      timestamp: "2026-07-20T00:00:00.000Z"
    });
    expect(rendered).toContain("received");
    expect(rendered).not.toContain("discord.com/channels");
    expect(rendered).not.toContain("sensitive context");
  });
});
