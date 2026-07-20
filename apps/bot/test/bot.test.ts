import { createHash, createHmac, randomBytes } from "node:crypto";

import {
  ApplicationCommandType,
  ApplicationIntegrationType,
  InteractionContextType,
  Routes
} from "discord.js";
import type { REST } from "discord.js";
import type { Client, Guild, Interaction } from "discord.js";
import { describe, expect, it, vi } from "vitest";

import { registerGlobalCommands } from "../src/command-registration.js";
import { COMMANDS } from "../src/commands.js";
import {
  decryptJson,
  encryptJson,
  generateAccessKey,
  hashAccessKey
  ,verifyReportEventSignature
} from "../src/crypto.js";
import { renderNotification } from "../src/notifier.js";
import { matchingCountries } from "../src/countries.js";
import type { BotConfig } from "../src/config.js";
import type { BotDatabase } from "../src/database.js";
import { InteractionHandler } from "../src/interactions.js";
import { ServerResolver } from "../src/server-resolver.js";
import type { DsaApi } from "@discord-dsa/contracts";
import {
  buildCountryPicker,
  buildReportModal,
  buildReview,
  draftToCreateInput,
  reportBrowser,
  reportEmbed
} from "../src/ui.js";

function reportFixture() {
  return {
    internalReportId: "timo-schmitt-74cjy1qvc1azcxy2",
    country: "DE",
    flow: "message_urf" as const,
    reportType: "sub_other_hate_speech",
    submitterDiscordUserId: "1197857362942378017",
    pseudonym: "hidden",
    email: "hidden@example.invalid",
    locale: "de-DE",
    timezone: "Europe/Berlin",
    lifecycleAttempt: 1,
    retryable: false,
    failureStage: null,
    status: "submitted" as const,
    discordReportId: "1527695430949798110",
    discordStatus: "actioned" as const,
    discordStatusUpdatedAt: "2026-07-20T00:00:00.000Z",
    error: null,
    createdAt: "2026-07-19T00:00:00.000Z",
    updatedAt: "2026-07-20T00:00:00.000Z",
    reportedDetails: {
      kind: "message" as const,
      messageUrl: "https://discord.com/channels/@me/123456789012345678/123456789012345679",
      context: "sensitive context"
    },
    timeline: [
      {
        eventId: "1",
        type: "report_created",
        occurredAt: "2026-07-19T00:00:00.000Z",
        lifecycleAttempt: 1,
        discordStatus: null,
        errorCode: null
      },
      {
        eventId: "2",
        type: "discord_status_updated",
        occurredAt: "2026-07-20T00:00:00.000Z",
        lifecycleAttempt: 1,
        discordStatus: "actioned" as const,
        errorCode: null
      }
    ]
  };
}

describe("Discord command registration", () => {
  it("synchronizes the complete global command set", async () => {
    const put = vi.fn().mockResolvedValue([]);
    const count = await registerGlobalCommands({
      applicationId: "123456789012345678",
      rest: { put } as unknown as REST,
      token: "test-token"
    });

    expect(count).toBe(COMMANDS.length);
    expect(put).toHaveBeenCalledWith(
      Routes.applicationCommands("123456789012345678"),
      { body: COMMANDS }
    );
  });

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

  it("requires message links and autocompletes an optional country on every report flow", () => {
    const command = COMMANDS.find((candidate) => candidate.name === "report");
    const subcommands = command?.options ?? [];
    for (const subcommand of subcommands) {
      if (!("options" in subcommand)) continue;
      const country = subcommand.options?.find((option) => option.name === "country");
      expect(country).toMatchObject({ required: false, autocomplete: true });
    }
    const message = subcommands.find((subcommand) => subcommand.name === "message");
    const messageLink = message && "options" in message
      ? message.options?.find((option) => option.name === "message-link")
      : undefined;
    expect(messageLink).toMatchObject({ required: true });
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

  it("authenticates fresh API lifecycle event payloads", () => {
    const secret = "s".repeat(32);
    const timestamp = "1800000000";
    const eventId = "42";
    const body = JSON.stringify({ eventId, type: "report_submitted" });
    const bodyHash = createHash("sha256").update(body).digest("hex");
    const signature = createHmac("sha256", secret)
      .update(`${timestamp}\n${eventId}\n${bodyHash}`)
      .digest("hex");
    expect(
      verifyReportEventSignature({
        secret,
        timestamp,
        eventId,
        body,
        signature,
        now: 1_800_000_000_000
      })
    ).toBe(true);
    expect(
      verifyReportEventSignature({
        secret,
        timestamp,
        eventId,
        body: `${body}tampered`,
        signature,
        now: 1_800_000_000_000
      })
    ).toBe(false);
  });
});

describe("server resolution", () => {
  it("prefers current guild data without making a Discord REST request", async () => {
    const fetch = vi.fn();
    const client = {
      guilds: { cache: new Map(), fetch },
      fetchInvite: vi.fn(),
      fetchGuildPreview: vi.fn()
    } as unknown as Client;
    const guild = {
      id: "123456789012345678",
      name: "Example server",
      description: "Example description",
      iconURL: () => "https://cdn.example/icon.png",
      memberCount: 42,
      approximatePresenceCount: 7
    } as unknown as Guild;
    const snapshot = await new ServerResolver(client).resolve(guild.id, guild);
    expect(snapshot).toMatchObject({ name: "Example server", approximateMemberCount: 42 });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("falls back from inaccessible guild data to a discoverable preview", async () => {
    const preview = {
      id: "123456789012345678",
      name: "Preview server",
      description: null,
      iconURL: () => null,
      approximateMemberCount: 100,
      approximatePresenceCount: 10
    };
    const client = {
      guilds: { cache: new Map(), fetch: vi.fn().mockRejectedValue(new Error("forbidden")) },
      fetchInvite: vi.fn(),
      fetchGuildPreview: vi.fn().mockResolvedValue(preview)
    } as unknown as Client;
    await expect(new ServerResolver(client).resolve(preview.id)).resolves.toMatchObject({
      name: "Preview server",
      approximateMemberCount: 100
    });
  });
});

describe("report UI", () => {
  it("searches full country names and returns flags with ISO values", () => {
    expect(matchingCountries(["DE", "FR", "IE"], "ger")).toEqual([
      { name: "🇩🇪 Germany", value: "DE" }
    ]);
    expect(matchingCountries(Array.from({ length: 27 }, () => "DE"), "")).toHaveLength(25);
  });

  it("fits the 27-country list into paged Discord select menus", () => {
    const countries = [
      "AT", "BE", "BG", "CY", "CZ", "DE", "DK", "EE", "ES", "FI", "FR", "GR", "HR",
      "HU", "IE", "IT", "LT", "LU", "LV", "MT", "NL", "PL", "PT", "RO", "SE", "SI", "SK"
    ];
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

  it("keeps review embeds below Discord's embed limit", () => {
    const review = buildReview("draft", {
      flow: "message_urf",
      country: "DE",
      reportType: "sub_other_hate_speech",
      messageUrl: `https://discord.com/channels/@me/${"1".repeat(18)}/${"2".repeat(18)}`,
      context: "x".repeat(4000)
    });
    expect(JSON.stringify(review.embeds[0]?.toJSON()).length).toBeLessThan(6000);
  });

  it("builds stateless report pagination with readable status embeds", () => {
    const report = reportFixture();
    const browser = reportBrowser(report, null, 0, 2);
    const embed = browser.embeds[0]?.toJSON();
    expect(embed?.title).toBe("Message report");
    expect(embed?.description).toContain("Action taken");
    expect(browser.components[0]?.toJSON().components).toHaveLength(2);
  });

  it("keeps full maximum context and a three-attempt timeline within Discord limits", () => {
    const now = "2026-07-20T00:00:00.000Z";
    const report = reportFixture();
    report.reportedDetails.context = "x".repeat(4_000);
    report.timeline = Array.from({ length: 30 }, (_, index) => ({
      eventId: `${index + 1}`,
      type: "verification_started",
      occurredAt: now,
      lifecycleAttempt: Math.floor(index / 10) + 1,
      discordStatus: null,
      errorCode: null
    }));
    const json = reportEmbed(report).toJSON();
    const characters =
      (json.title?.length ?? 0) +
      (json.description?.length ?? 0) +
      (json.footer?.text.length ?? 0) +
      (json.fields ?? []).reduce(
        (total, field) => total + field.name.length + field.value.length,
        0
      );
    expect(characters).toBeLessThanOrEqual(6_000);
    expect(json.fields?.length).toBeLessThanOrEqual(25);
    expect(JSON.stringify(json)).toContain("Attempt 3");
  });

  it("renders lifecycle DMs with full details and the current timeline", () => {
    const rendered = renderNotification(reportFixture());
    const json = JSON.stringify(rendered.toJSON());
    expect(json).toContain("Action taken");
    expect(json).toContain("discord.com/channels");
    expect(json).toContain("sensitive context");
    expect(json).toContain("Timeline");
  });
});

describe("report interaction country precedence", () => {
  it("does not create a draft when neither an explicit nor default country exists", async () => {
    const reply = vi.fn();
    const saveDraft = vi.fn();
    const database = {
      getAccess: vi.fn().mockResolvedValue({
        credits: 0,
        defaultCountry: null,
        suspended: false,
        suspensionReason: null
      }),
      saveDraft
    } as unknown as BotDatabase;
    const config = {
      whitelistEnabled: false,
      adminUserIds: new Set<string>(),
      dataEncryptionKey: randomBytes(32)
    } as unknown as BotConfig;
    const handler = new InteractionHandler({
      api: {} as DsaApi,
      config,
      countries: ["DE", "FR"],
      database,
      serverResolver: {} as ServerResolver
    });
    const interaction = {
      isAutocomplete: () => false,
      isMessageContextMenuCommand: () => false,
      isChatInputCommand: () => true,
      isModalSubmit: () => false,
      isStringSelectMenu: () => false,
      isButton: () => false,
      isRepliable: () => true,
      commandName: "report",
      user: { id: "1197857362942378017" },
      options: {
        getSubcommand: () => "message",
        getString: (name: string) =>
          name === "message-link"
            ? "https://discord.com/channels/@me/123456789012345678/123456789012345679"
            : null
      },
      reply,
      deferred: false,
      replied: false
    } as unknown as Interaction;

    await handler.handle(interaction);

    expect(saveDraft).not.toHaveBeenCalled();
    expect(JSON.stringify(reply.mock.calls[0]?.[0])).toContain("A country is required");
  });
});
