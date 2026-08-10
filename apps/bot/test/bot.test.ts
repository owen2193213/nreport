import { Buffer } from "node:buffer";
import { createHash, createHmac, randomBytes } from "node:crypto";

import {
  ApplicationCommandType,
  ApplicationIntegrationType,
  InteractionContextType,
  MessageFlags,
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
import {
  lifecycleReplyText,
  NotificationWorker,
  renderNotification
} from "../src/notifier.js";
import { matchingCountries } from "../src/countries.js";
import type { BotConfig } from "../src/config.js";
import type { BotDatabase } from "../src/database.js";
import {
  ACTIVE_REPORT_POLL_SECONDS,
  creditBalanceAfterReservation,
  jsonbParameter,
  nextReportPollDelaySeconds,
  notificationEventKey,
  observedNotificationTypes,
  reportEventTrackingResult,
  REPORT_TRACKING_RETENTION_DAYS,
  shouldNotifyLifecycleType
} from "../src/database.js";
import {
  conciseError,
  InteractionHandler,
  shouldBypassReportCredits
} from "../src/interactions.js";
import { reportEventIngestionStatus } from "../src/health.js";
import type { MessageResolver } from "../src/message-resolver.js";
import {
  isValidProfileTarget,
  ProfileResolver,
  normalizeProfileTarget
} from "../src/profile-resolver.js";
import type { ReportWriter } from "../src/report-writer.js";
import { ServerResolver } from "../src/server-resolver.js";
import { DsaApiError, USER_MESSAGE_REPORT_REASONS } from "@discord-dsa/contracts";
import type { DsaApi, ReportDetail } from "@discord-dsa/contracts";
import {
  buildCountryPicker,
  accessEmbed,
  buildManualReportModal,
  buildRefinementModal,
  buildReportModal,
  buildReview,
  buildWriterProgress,
  accessKeyEmbed,
  accessKeysEmbed,
  draftToCreateInput,
  generatedKeysEmbed,
  reportBrowser,
  reportEmbed,
  reportRetryComponents
} from "../src/ui.js";

function reportFixture(): ReportDetail {
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
    retryOfReportId: null,
    retriedAsReportId: null,
    retrySequence: 0,
    failureStage: null,
    status: "submitted" as const,
    discordReportId: "1527695430949798110",
    discordStatus: "actioned" as const,
    discordStatusUpdatedAt: "2026-07-20T00:00:00.000Z",
    reviewStatus: null,
    reviewStatusUpdatedAt: null,
    reviewError: null,
    appealRetryable: false,
    resubmittable: false,
    error: null,
    createdAt: "2026-07-19T00:00:00.000Z",
    updatedAt: "2026-07-20T00:00:00.000Z",
    reportedDetails: {
      kind: "message" as const,
      messageUrl: "https://discord.com/channels/@me/123456789012345678/123456789012345679",
      reportReason: "The message contains hateful content.",
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

describe("interaction error messages", () => {
  it("does not expose unexpected JavaScript exception text to users", () => {
    expect(conciseError(new TypeError("Cannot use 'in' operator on null"))).toBe(
      "An unexpected error occurred."
    );
  });
});

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
    expect(COMMANDS).toHaveLength(9);
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

  it("registers Apps → Quick Report Message as a message context command", () => {
    const command = COMMANDS.find((candidate) => candidate.name === "Quick Report Message");
    expect(command?.type).toBe(ApplicationCommandType.Message);
  });

  it("registers both experimental batch reports as message context commands", () => {
    for (const name of [
      "Experimental 10x Same Category",
      "Experimental All Categories"
    ]) {
      const command = COMMANDS.find((candidate) => candidate.name === name);
      expect(command?.type).toBe(ApplicationCommandType.Message);
      expect(name.length).toBeLessThanOrEqual(32);
    }
  });

  it("keeps targets in report commands and moves report preferences into modals", () => {
    const command = COMMANDS.find((candidate) => candidate.name === "report");
    const subcommands = command?.options ?? [];
    for (const subcommand of subcommands) {
      if (!("options" in subcommand)) continue;
      expect(subcommand.options?.find((option) => option.name === "country")).toBeUndefined();
      expect(subcommand.options?.find((option) => option.name === "dont-use-ai")).toBeUndefined();
    }
    const message = subcommands.find((subcommand) => subcommand.name === "message");
    const messageLink = message && "options" in message
      ? message.options?.find((option) => option.name === "message-link")
      : undefined;
    expect(messageLink).toMatchObject({ required: true });
    const profile = subcommands.find((subcommand) => subcommand.name === "profile");
    const target = profile && "options" in profile
      ? profile.options?.find((option) => option.name === "target")
      : undefined;
    expect(target).toMatchObject({
      required: true,
      description: "Raw Discord user ID",
      min_length: 15,
      max_length: 22
    });
    const serverId = profile && "options" in profile
      ? profile.options?.find((option) => option.name === "server-id")
      : undefined;
    expect(serverId).toMatchObject({ required: false });
    const server = subcommands.find((subcommand) => subcommand.name === "server");
    const serverOrInvite = server && "options" in server
      ? server.options?.find((option) => option.name === "server-or-invite")
      : undefined;
    expect(serverOrInvite).toMatchObject({ required: false });
  });

  it("allows access keys to grant any positive integer number of credits", () => {
    const command = COMMANDS.find((candidate) => candidate.name === "admin");
    const keyGroup = command?.options?.find((option) => option.name === "key");
    const create = keyGroup && "options" in keyGroup
      ? keyGroup.options?.find((option) => option.name === "create")
      : undefined;
    const credits = create && "options" in create
      ? create.options?.find((option) => option.name === "credits")
      : undefined;

    expect(credits).toMatchObject({ required: true, min_value: 1 });
    expect(credits && "max_value" in credits ? credits.max_value : undefined).toBeUndefined();
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
    const tampered = Buffer.from(encrypted, "base64url");
    tampered[12] = tampered[12]! ^ 1;
    expect(() => decryptJson(tampered.toString("base64url"), key)).toThrow();
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

describe("access key administration views", () => {
  const redeemedKey = {
    id: "internal-key-id",
    code_prefix: "dsa_example",
    credits_total: 250,
    status: "redeemed" as const,
    expires_at: null,
    created_by: "100000000000000001",
    created_at: new Date("2026-07-20T00:00:00.000Z"),
    redeemed_by: "100000000000000002",
    redeemed_at: new Date("2026-07-20T01:00:00.000Z"),
    revoked_by: null,
    revoked_at: null,
    revoke_reason: null
  };

  it("shows only plaintext keys, not internal IDs, immediately after generation", () => {
    const json = JSON.stringify(
      generatedKeysEmbed([{ id: "internal-key-id", code: "dsa_plaintext-secret" }]).toJSON()
    );
    expect(json).toContain("dsa_plaintext-secret");
    expect(json).not.toContain("internal-key-id");
  });

  it("mentions the redeemer in key list and inspection output", () => {
    const list = JSON.stringify(accessKeysEmbed([redeemedKey]).toJSON());
    const detail = JSON.stringify(accessKeyEmbed(redeemedKey).toJSON());
    for (const output of [list, detail]) {
      expect(output).toContain("<@100000000000000002>");
      expect(output).toContain("Redeemed");
    }
  });

  it("does not add DM-delivery options to report-history commands", () => {
    const command = COMMANDS.find((candidate) => candidate.name === "reports");
    expect(command?.options).toHaveLength(3);
    for (const subcommand of command?.options ?? []) {
      if (!("options" in subcommand)) throw new Error("Expected a reports subcommand.");
      expect(subcommand.options?.find((option) => option.name === "send-to-dms")).toBeUndefined();
    }
  });

  it("charges normal users only when credit enforcement is enabled", () => {
    expect(shouldBypassReportCredits(false, true)).toBe(false);
    expect(shouldBypassReportCredits(true, true)).toBe(true);
    expect(shouldBypassReportCredits(false, false)).toBe(true);
  });

  it("deducts exactly one credit from large balances unless bypassed", () => {
    expect(creditBalanceAfterReservation(9_999, false)).toBe(9_998);
    expect(creditBalanceAfterReservation(9_999, true)).toBe(9_999);
  });

  it("serializes AI decision arrays as JSONB parameters", () => {
    expect(jsonbParameter([])).toBe("[]");
    expect(jsonbParameter([{ action: "Generated" }])).toBe(
      '[{"action":"Generated"}]'
    );
  });

  it("labels key credits as the original grant rather than a live balance", () => {
    const output = JSON.stringify(accessKeyEmbed(redeemedKey).toJSON());
    expect(output).toContain("Credits granted");
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
      bannerURL: () => null,
      splashURL: () => null,
      discoverySplashURL: () => null,
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
      splashURL: () => null,
      discoverySplashURL: () => null,
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

describe("profile resolution", () => {
  it("accepts only raw Discord user IDs", () => {
    expect(normalizeProfileTarget("  123456789012345678  ")).toBe("123456789012345678");
    expect(isValidProfileTarget("example.user")).toBe(false);
    expect(isValidProfileTarget("123456789012345678")).toBe(true);
    expect(isValidProfileTarget("<@123456789012345678>")).toBe(false);
    expect(isValidProfileTarget("Example Display")).toBe(false);
  });

  it("resolves an immutable public user snapshot from a raw user ID", async () => {
    const fetchUser = vi.fn().mockResolvedValue({
      id: "123456789012345678",
      username: "example",
      globalName: "Example Display",
      bot: false,
      displayAvatarURL: () => "https://cdn.discordapp.com/avatar.png",
      bannerURL: () => "https://cdn.discordapp.com/banner.png"
    });
    const client = {
      users: { fetch: fetchUser },
      guilds: { fetch: vi.fn() }
    } as unknown as Client;
    await expect(new ProfileResolver(client).resolve("123456789012345678")).resolves.toMatchObject({
      userId: "123456789012345678",
      username: "example",
      globalDisplayName: "Example Display",
      avatarUrl: "https://cdn.discordapp.com/avatar.png",
      bannerUrl: "https://cdn.discordapp.com/banner.png"
    });
    expect(fetchUser).toHaveBeenCalledWith("123456789012345678", { force: true });
  });

});

describe("report UI", () => {
  it("shows cumulative AI usage without an estimated provider cost", () => {
    const embed = accessEmbed(
      {
        aiCostCredits: 0.012345,
        aiInputTokens: 1_000,
        aiOutputTokens: 200,
        aiReasoningTokens: 100,
        aiRequestCount: 4,
        aiSearchRequests: 2,
        credits: 3,
        defaultCountry: null,
        suspended: false,
        suspensionReason: null
      },
      false
    );
    const text = JSON.stringify(embed.toJSON());
    expect(text).toContain("AI usage");
    expect(text).toContain("1,000");
    expect(text).toContain("200");
    expect(text).not.toContain("OpenRouter cost");
    expect(text).not.toContain("0.012345 credits");
  });

  it("mentions the selected user in the administrator access view", () => {
    const text = JSON.stringify(
      accessEmbed(
        {
          aiCostCredits: 0,
          aiInputTokens: 0,
          aiOutputTokens: 0,
          aiReasoningTokens: 0,
          aiRequestCount: 0,
          aiSearchRequests: 0,
          credits: 3,
          defaultCountry: null,
          suspended: false,
          suspensionReason: null
        },
        false,
        "100000000000000002"
      ).toJSON()
    );

    expect(text).toContain("Discord user: <@100000000000000002>");
  });

  it("searches full country names and returns flags with ISO values", () => {
    expect(matchingCountries(["DE", "FR", "IE"], "ger")).toEqual([
      { name: "🇩🇪 Germany", value: "DE" }
    ]);
    expect(matchingCountries(["DE", "FR"], "auto")).toEqual([
      { name: "✨ Auto — AI chooses", value: "AUTO" }
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
    expect(secondSelect && "options" in secondSelect ? secondSelect.options : []).toHaveLength(4);

    const manual = buildCountryPicker(countries, "draft-id", 0, false);
    const manualSelect = manual.components[0]?.toJSON().components[0];
    const manualOptions = manualSelect && "options" in manualSelect ? manualSelect.options : [];
    expect(manualOptions.some((option) => option.value === "AUTO")).toBe(false);
    expect(JSON.stringify(manual.embeds[0]?.toJSON())).toContain("AI is disabled");
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
    expect(message.components).toHaveLength(4);
    expect(profile.components).toHaveLength(5);
    expect(guild.components).toHaveLength(5);

    const manual = buildReportModal("draft", {
      flow: "message_urf",
      country: "DE",
      aiDisabled: true
    }).toJSON();
    const automaticJson = JSON.stringify(message);
    const manualJson = JSON.stringify(manual);
    expect(automaticJson).toContain('"custom_id":"report_type","required":false');
    expect(automaticJson).toContain('"min_values":0');
    expect(automaticJson).toContain('"placeholder":"Auto"');
    expect(automaticJson).toContain(
      '"description":"If blank, AI will automatically choose this field when Use AI is enabled."'
    );
    expect(automaticJson).toContain(
      '"description":"If blank, AI will automatically write this field when Use AI is enabled. Maximum 512 characters."'
    );
    expect(automaticJson.indexOf('"custom_id":"report_type"')).toBeLessThan(
      automaticJson.indexOf('"custom_id":"brief"')
    );
    expect(automaticJson.indexOf('"custom_id":"brief"')).toBeLessThan(
      automaticJson.indexOf('"custom_id":"country_mode"')
    );
    expect(automaticJson.indexOf('"custom_id":"country_mode"')).toBeLessThan(
      automaticJson.indexOf('"custom_id":"preferences"')
    );
    expect(manualJson).toContain('"custom_id":"report_type","required":false');
    expect(manualJson).toContain('"custom_id":"brief","style":2,"required":false');
    expect(manualJson).toContain('"max_length":512');
  });

  it("includes default-on AI and DM review options in the combined modal", () => {
    const setup = buildReportModal("draft", {
      flow: "message_urf",
      country: "DE",
      countrySelection: "default"
    }).toJSON();
    const json = JSON.stringify(setup);
    expect(setup.custom_id).toBe("report:modal:draft");
    expect(setup.components).toHaveLength(4);
    expect(json).toContain('"custom_id":"preferences"');
    expect(json).toContain('"label":"Use AI","value":"USE_AI"');
    expect(json).toContain(
      '"description":"Infer missing details and write the final report.","default":true'
    );
    expect(json).toContain('"label":"Send review to DMs","value":"SEND_DM"');
    expect(json).toContain(
      '"description":"Send the generated review and confirmation buttons to DMs.","default":true'
    );
    expect(json).toContain('"label":"Saved default:');
    expect(json).toContain('"value":"DEFAULT","default":true');
    expect(json).toContain('"value":"CHOOSE"');

    const disabled = JSON.stringify(
      buildReportModal("draft", {
        flow: "message_urf",
        aiDisabled: true,
        sendToDms: false,
        countrySelection: "auto"
      }).toJSON()
    );
    expect(disabled).toContain(
      '"description":"Infer missing details and write the final report.","default":false'
    );
    expect(disabled).toContain(
      '"description":"Send the generated review and confirmation buttons to DMs.","default":false'
    );
    expect(disabled).toContain('"value":"AUTO","default":true');
  });

  it("converts a reviewed message draft into the canonical API request", () => {
    expect(
      draftToCreateInput(
        {
          flow: "message_urf",
          country: "DE",
          reportReason: "The message contains hateful content.",
          reportType: "sub_other_hate_speech",
          messageUrl:
            "https://discord.com/channels/@me/123456789012345678/123456789012345679",
          context: "[Basic Law Article 1] The message contains unlawful hate speech.",
          legalResearch: {
            country: "DE",
            summary: "Basic Law Article 1 protects human dignity.",
            sources: [{ title: "Basic Law", url: "https://www.gesetze-im-internet.de/gg/" }],
            researchedAt: "2026-07-20T00:00:00.000Z",
            searchRequests: 1
          }
        },
        "1197857362942378017"
      )
    ).toEqual({
      flow: "message_urf",
      country: "DE",
      reportReason: "The message contains hateful content.",
      reportType: "sub_other_hate_speech",
      submitterDiscordUserId: "1197857362942378017",
      messageUrl: "https://discord.com/channels/@me/123456789012345678/123456789012345679",
      context: "[Basic Law Article 1] The message contains unlawful hate speech."
    });
  });

  it("reviews and submits a manual report without AI research", () => {
    const draft = {
      aiDisabled: true,
      flow: "message_urf" as const,
      country: "DE",
      countrySelection: "override" as const,
      reportReason: "I am reporting this message because it contains abusive language.",
      reportType: "sub_other_hate_speech",
      messageUrl:
        "https://discord.com/channels/@me/123456789012345678/123456789012345679",
      context: "I am reporting this message because it contains abusive language."
    };

    const review = buildReview("draft", draft);
    const buttons = JSON.stringify(review.components[0]?.toJSON());
    expect(buttons).not.toContain("Refine");
    expect(buttons).not.toContain("Regenerate");
    expect(buttons).toContain("Edit manually");
    expect(draftToCreateInput(draft, "1197857362942378017")).toMatchObject({
      country: "DE",
      context: draft.context,
      reportType: "sub_other_hate_speech"
    });
  });

  it("preserves a resolved profile ID and snapshot in the API request", () => {
    const snapshot = {
      userId: "123456789012345678",
      username: "example",
      globalDisplayName: "Example Display",
      avatarUrl: "https://cdn.discordapp.com/avatar.png",
      bannerUrl: null,
      bot: false,
      resolvedAt: "2026-07-20T00:00:00.000Z"
    };
    expect(
      draftToCreateInput(
        {
          flow: "user_urf",
          country: "DE",
          reportReason: "The profile contains hateful content.",
          reportType: "sub_other_hate_speech",
          reportedUsername: "example",
          reportedUserId: snapshot.userId,
          reportedUserSnapshot: snapshot,
          profileElements: ["name"],
          context: "[Basic Law Article 1] The profile name contains unlawful hate speech.",
          legalResearch: {
            country: "DE",
            summary: "Basic Law Article 1 protects human dignity.",
            sources: [{ title: "Basic Law", url: "https://www.gesetze-im-internet.de/gg/" }],
            researchedAt: "2026-07-20T00:00:00.000Z",
            searchRequests: 1
          }
        },
        "1197857362942378017"
      )
    ).toMatchObject({
      reportedUsername: "example",
      reportedUserId: snapshot.userId,
      reportedUserSnapshot: snapshot
    });
  });

  it("accepts manually repaired text without requiring the researched law reference", () => {
    const input = draftToCreateInput(
      {
        flow: "message_urf",
        country: "DE",
        reportReason: "The message contains hateful content.",
        reportType: "sub_other_hate_speech",
        messageUrl:
          "https://discord.com/channels/@me/123456789012345678/123456789012345679",
        context: "The report no longer contains its legal basis.",
        legalResearch: {
          country: "DE",
          lawReference: "Basic Law Article 1",
          summary: "Basic Law Article 1 protects human dignity.",
          sources: [],
          researchedAt: "2026-07-20T00:00:00.000Z",
          searchRequests: 1
        }
      },
      "1197857362942378017"
    );
    expect(input.context).toBe("The report no longer contains its legal basis.");
  });

  it("keeps review embeds below Discord's embed limit", () => {
    const review = buildReview("draft", {
      flow: "message_urf",
      country: "DE",
      reportReason: "The message contains hateful content.",
      reportType: "sub_other_hate_speech",
      messageUrl: `https://discord.com/channels/@me/${"1".repeat(18)}/${"2".repeat(18)}`,
      context: `[Basic Law]${"x".repeat(501)}`,
      countrySelection: "auto",
      legalResearch: {
        country: "DE",
        summary: "Research",
        sources: [{ title: "Basic Law", url: "https://www.gesetze-im-internet.de/gg/" }],
        researchedAt: "2026-07-20T00:00:00.000Z",
        searchRequests: 1
      }
    });
    expect(JSON.stringify(review.embeds[0]?.toJSON()).length).toBeLessThan(6000);
    const buttons = review.components[0]?.toJSON().components ?? [];
    expect(buttons).toHaveLength(5);
    expect(JSON.stringify(buttons)).toContain("Refine");
    expect(JSON.stringify(buttons)).toContain("Regenerate");
    expect(JSON.stringify(buttons)).toContain("Edit manually");
    const reviewJson = JSON.stringify(review.embeds[0]?.toJSON());
    expect(reviewJson).toContain("512/512 characters");
    expect(reviewJson).toContain("Auto-selected");
    expect(reviewJson).not.toContain("DeepSeek");
    expect(review.embeds[0]?.toJSON().description).toBeUndefined();
    expect(review.embeds[0]?.toJSON().fields?.map((field) => field.name)).toEqual([
      "Item",
      "Status",
      "Category",
      "Country",
      "Details",
      "AI decisions",
      "References",
      "Dates",
      "Appeal"
    ]);
    expect(review.embeds[0]?.toJSON().fields?.find((field) => field.name === "Details")?.value)
      .toMatch(/^```\n[\s\S]*\n```$/);
    expect(reviewJson).not.toContain("https://www.gesetze-im-internet.de/gg/");
    expect(JSON.stringify(review.components[1]?.toJSON())).toContain("Change country");
  });

  it("builds refinement and manual-edit modals with bounded inputs", () => {
    const refinement = buildRefinementModal("draft").toJSON();
    const overlengthCandidate = "c".repeat(600);
    const manual = buildManualReportModal("draft", {
      flow: "message_urf",
      reportBrief: "Original reason",
      context: overlengthCandidate
    }).toJSON();
    expect(refinement.custom_id).toBe("writer:refine:draft");
    expect(manual.custom_id).toBe("writer:edit:draft");
    expect(JSON.stringify(manual)).toContain("AI draft to repair");
    expect(JSON.stringify(manual)).toContain("c".repeat(513));
    expect(JSON.stringify(manual)).not.toContain('"value":"c');
    expect(JSON.stringify(manual)).toContain("paste up to 512 characters here");
    expect(JSON.stringify(manual)).toContain('"max_length":512');
    expect(JSON.stringify(refinement)).toContain('"max_length":512');
    const report = buildReportModal("draft", {
      flow: "message_urf",
      country: "DE"
    }).toJSON();
    expect(JSON.stringify(report)).toContain('"custom_id":"brief"');
    expect(JSON.stringify(report)).toContain('"max_length":512');
  });

  it("builds stateless report pagination with readable status embeds", () => {
    const report = reportFixture();
    const browser = reportBrowser(report, null, 0, 2);
    const embed = browser.embeds[0]?.toJSON();
    expect(embed?.title).toBe("Message report");
    expect(embed?.fields?.find((field) => field.name === "Status")?.value).toBe(
      "Report accepted"
    );
    expect(embed?.fields?.some((field) => field.name === "Reason")).toBe(false);
    expect(embed?.fields?.find((field) => field.name === "Appeal")?.value).toBe(
      "Not available"
    );
    expect(embed?.fields?.find((field) => field.name === "History")?.value).toBe(
      "Check your DMs for the full status log."
    );
    expect(browser.components[0]?.toJSON().components).toHaveLength(2);
  });

  it("keeps full maximum context and a three-attempt timeline within Discord limits", () => {
    const now = "2026-07-20T00:00:00.000Z";
    const report = reportFixture();
    report.reportedDetails.context = "x".repeat(4_000);
    report.lifecycleAttempt = 3;
    report.timeline = Array.from({ length: 30 }, (_, index) => ({
      eventId: `${index + 1}`,
      type: index % 10 === 9 ? "report_submitted" : "verification_started",
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
    expect(JSON.stringify(json)).toContain("Attempt 1");
    expect(JSON.stringify(json)).not.toContain("Verification started");
  });

  it("renders lifecycle DMs with full details and the current timeline", () => {
    const report = reportFixture();
    report.timeline = [
      {
        eventId: "1",
        type: "report_api_request_sent",
        occurredAt: "2026-07-19T00:00:00.000Z",
        lifecycleAttempt: 1,
        discordStatus: null,
        errorCode: null
      },
      {
        eventId: "2",
        type: "verification_requested",
        occurredAt: "2026-07-19T00:00:01.000Z",
        lifecycleAttempt: 1,
        discordStatus: null,
        errorCode: null
      },
      {
        eventId: "3",
        type: "verification_email_received",
        occurredAt: "2026-07-19T00:00:02.000Z",
        lifecycleAttempt: 1,
        discordStatus: null,
        errorCode: null
      },
      {
        eventId: "4",
        type: "report_submitted",
        occurredAt: "2026-07-19T00:00:03.000Z",
        lifecycleAttempt: 1,
        discordStatus: null,
        errorCode: null
      },
      {
        eventId: "5",
        type: "discord_status_updated",
        occurredAt: "2026-07-20T00:00:00.000Z",
        lifecycleAttempt: 1,
        discordStatus: "actioned",
        errorCode: null
      }
    ];
    const rendered = renderNotification(report);
    const json = JSON.stringify(rendered.toJSON());
    expect(json).toContain("Report accepted");
    expect(json).toContain("discord.com/channels");
    expect(json).toContain("sensitive context");
    expect(json).toContain("History");
    expect(json).toContain("Report submitted");
    expect(json).toContain("**Report accepted**");
    expect(json).not.toContain("Report requested");
    expect(json).not.toContain("Verification email requested");
    expect(json).not.toContain("Verification completed");
    expect(json).not.toContain("pending");
    expect(json).not.toContain("code processed");
    expect(json).not.toContain("ABCD12");
    expect(
      rendered
        .toJSON()
        .fields?.find((field) => field.name === "History")
        ?.value
    ).toMatch(/^• <t:\d+:R> /);
  });

  it("uses the shared report structure with the full history in lifecycle DMs", () => {
    const report = reportFixture();
    report.discordStatus = "received";
    report.timeline[1]!.discordStatus = "received";
    const json = renderNotification(report, null, "discord:received").toJSON();
    expect(json.title).toBe("Message report");
    expect(json.description).toBeUndefined();
    expect(json.fields?.find((field) => field.name === "Status")?.value).toBe(
      "Report received"
    );
    expect(json.fields?.find((field) => field.name === "History")?.value).toContain("<t:");
    expect(json.fields?.find((field) => field.name === "History")?.value).not.toContain("```");
    expect(json.fields?.find((field) => field.name === "History")?.value).not.toContain(
      "Check your DMs"
    );
  });

  it("separates the original result from the current appeal stage", () => {
    const report = reportFixture();
    report.discordStatus = "closed_no_action";
    report.reviewStatus = "received";
    report.reviewStatusUpdatedAt = "2026-07-20T00:02:00.000Z";
    report.timeline = [
      {
        eventId: "1",
        type: "report_submitted",
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
        discordStatus: "closed_no_action",
        errorCode: null
      },
      {
        eventId: "3",
        type: "review_received",
        occurredAt: "2026-07-20T00:01:00.000Z",
        lifecycleAttempt: 1,
        discordStatus: "closed_no_action",
        errorCode: null
      }
    ];
    const history = reportEmbed(report)
      .toJSON()
      .fields?.find((field) => field.name === "History")?.value;
    expect(history).toContain("Report submitted");
    expect(history).toContain("Report closed");
    expect(history).toContain("Appeal submitted");
    expect(history).toMatch(/<t:\d+:R> \*\*Appeal received\*\*/);
    expect(history).not.toContain("Verification");
  });

  it("labels a denied appeal as the final bold stage", () => {
    const report = reportFixture();
    report.discordStatus = "review_not_approved";
    report.reviewStatus = "not_approved";
    report.reviewStatusUpdatedAt = "2026-07-20T00:03:00.000Z";
    report.timeline = [
      {
        eventId: "1",
        type: "report_submitted",
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
        discordStatus: "closed_no_action",
        errorCode: null
      },
      {
        eventId: "3",
        type: "review_received",
        occurredAt: "2026-07-20T00:01:00.000Z",
        lifecycleAttempt: 1,
        discordStatus: "closed_no_action",
        errorCode: null
      },
      {
        eventId: "4",
        type: "discord_status_updated",
        occurredAt: "2026-07-20T00:03:00.000Z",
        lifecycleAttempt: 1,
        discordStatus: "review_not_approved",
        errorCode: null
      }
    ];
    const history = reportEmbed(report)
      .toJSON()
      .fields?.find((field) => field.name === "History")?.value;
    expect(history).toContain("Report closed");
    expect(history).toContain("Appeal submitted");
    expect(history).toMatch(
      /<t:\d+:R> \*\*Appeal denied\*\*/
    );
    expect(history).not.toContain("Result: Appeal denied");
  });

  it("renders Discord review ineligibility as a first-class terminal outcome", () => {
    const report = reportFixture();
    report.discordStatus = "closed_no_action";
    report.reviewStatus = "ineligible";
    report.reviewStatusUpdatedAt = "2026-07-20T00:03:00.000Z";
    report.reviewError = {
      code: "discord_review_ineligible",
      message: "Discord says this DSA report is ineligible for review."
    };
    report.appealRetryable = true;
    report.timeline = [
      {
        eventId: "1",
        type: "discord_status_updated",
        occurredAt: "2026-07-20T00:00:00.000Z",
        lifecycleAttempt: 1,
        discordStatus: "closed_no_action",
        errorCode: null
      },
      {
        eventId: "2",
        type: "review_ineligible",
        occurredAt: "2026-07-20T00:03:00.000Z",
        lifecycleAttempt: 1,
        discordStatus: "closed_no_action",
        errorCode: "discord_review_ineligible"
      }
    ];

    const json = reportEmbed(report).toJSON();
    expect(json.fields?.find((field) => field.name === "Status")?.value).toBe(
      "Appeal ineligible"
    );
    expect(json.fields?.find((field) => field.name === "Appeal")?.value).toContain(
      "Discord says this DSA report is ineligible for review."
    );
    expect(json.fields?.find((field) => field.name === "History")?.value).toMatch(
      /\*\*Appeal ineligible\*\*/
    );
    expect(reportRetryComponents(report)[0]?.components[0]?.data).toMatchObject({
      custom_id: `reports:retry-appeal:${report.internalReportId}`,
      label: "Retry appeal"
    });
    expect(lifecycleReplyText("review_ineligible", report)).toBe(
      "Report ineligible for review. No appeal sent."
    );
  });

  it("renders each writer stage with the durable report field structure", () => {
    const draft = {
      flow: "message_urf" as const,
      messageUrl: "https://discord.com/channels/@me/123/456",
      reportBrief: "The message contains hateful content.",
      createdAt: "2026-07-20T00:00:00.000Z",
      updatedAt: "2026-07-20T00:00:00.000Z"
    };
    const research = buildWriterProgress("draft-id", draft, {
      stage: "research",
      country: "Auto",
      reportReason: "Auto",
      reportType: "Auto"
    }).toJSON();
    const writing = buildWriterProgress("draft-id", draft, {
      stage: "write",
      country: "DE",
      reportReason: "The message contains hateful content.",
      reportType: "Other: hate speech"
    }).toJSON();
    expect(research.title).toBe("Message report");
    expect(research.fields?.map((field) => field.name)).toEqual([
      "Item",
      "Status",
      "Category",
      "Country",
      "Details",
      "AI decisions",
      "References",
      "Dates",
      "Appeal"
    ]);
    expect(writing.fields?.find((field) => field.name === "Country")?.value).toBe(
      "🇩🇪 Germany"
    );
    expect(writing.fields?.find((field) => field.name === "Category")?.value).toBe(
      "Other: hate speech"
    );
    expect(writing.fields?.find((field) => field.name === "Status")?.value).toBe(
      "Writing report"
    );
    expect(writing.fields?.some((field) => field.name === "Reason")).toBe(false);
    expect(
      writing.fields?.find((field) => field.name === "AI decisions")?.value
    ).toContain("Country: Auto →");
  });

  it("includes completed AI field decisions in review and lifecycle DM cards", () => {
    const aiDecisions = [
      {
        action: "Generated" as const,
        decidedAt: "2026-07-20T00:00:00.000Z",
        country: { before: "Auto", after: "🇩🇪 Germany" },
        category: { before: "Auto", after: "Other: hate speech" },
        details: { before: "Blank", after: "AI-written report" }
      }
    ];
    const report = reportFixture();
    const lifecycle = renderNotification(report, null, "discord:actioned", aiDecisions).toJSON();
    const field = lifecycle.fields?.find((candidate) => candidate.name === "AI decisions");
    expect(field?.value).toContain("Country: Auto → 🇩🇪 Germany");
    expect(field?.value).toContain("Category: Auto → Other: hate speech");
    expect(field?.value).toMatch(/\*\*Generated\*\* <t:\d+:R>/);
  });

  it("uses plain reply notifications for final Discord decisions", () => {
    const report = reportFixture();
    expect(lifecycleReplyText("discord:actioned", report)).toContain("accepted");
    expect(lifecycleReplyText("discord:closed_no_action", report)).toContain("denied");
    expect(lifecycleReplyText("discord:received", report)).toBeNull();
  });
});

describe("lifecycle notification deduplication", () => {
  it("polls only active processing and bounds the tracking lifetime", () => {
    const report = reportFixture();
    report.status = "submitted";
    expect(nextReportPollDelaySeconds(report)).toBeNull();

    report.status = "failed";
    expect(nextReportPollDelaySeconds(report)).toBeNull();

    report.status = "verifying";
    report.discordStatus = null;
    expect(nextReportPollDelaySeconds(report)).toBe(ACTIVE_REPORT_POLL_SECONDS);
    expect(ACTIVE_REPORT_POLL_SECONDS).toBe(30);
    expect(REPORT_TRACKING_RETENTION_DAYS).toBe(60);
  });

  it("deduplicates equal Discord states even when the API event IDs differ", () => {
    const base = {
      internalReportId: "report-1",
      submitterDiscordUserId: "1197857362942378017",
      occurredAt: "2026-07-20T00:00:00.000Z",
      lifecycleAttempt: 1
    };
    expect(notificationEventKey({ ...base, eventId: "41", type: "discord:received" })).toBe(
      notificationEventKey({ ...base, eventId: "42", type: "discord:received" })
    );
    expect(notificationEventKey({ ...base, eventId: "43", type: "discord:actioned" })).not.toBe(
      notificationEventKey({ ...base, eventId: "42", type: "discord:received" })
    );
    expect(
      notificationEventKey({
        ...base,
        lifecycleAttempt: 2,
        eventId: "44",
        type: "discord:received"
      })
    ).not.toBe(notificationEventKey({ ...base, eventId: "42", type: "discord:received" }));
  });

  it("uses submission as the only acknowledgement notification", () => {
    const submitted = reportFixture();
    submitted.status = "submitted";
    submitted.discordStatus = null;
    expect(observedNotificationTypes("submitting", null, submitted)).toEqual([
      "report_submitted"
    ]);

    submitted.discordStatus = "received";
    expect(observedNotificationTypes("submitted", null, submitted)).toEqual([
      "discord:received"
    ]);
    expect(shouldNotifyLifecycleType("report_submitted")).toBe(true);
    expect(shouldNotifyLifecycleType("discord:received")).toBe(true);
    expect(shouldNotifyLifecycleType("discord:actioned")).toBe(true);
    expect(shouldNotifyLifecycleType("review_ineligible")).toBe(true);
  });

  it("edits the saved status DM and replies when Discord makes a decision", async () => {
    const report = reportFixture();
    const edit = vi.fn().mockResolvedValue(undefined);
    const reply = vi.fn().mockResolvedValue(undefined);
    const send = vi.fn();
    const statusMessage = { edit, reply };
    const user = {
      createDM: vi.fn().mockResolvedValue({
        messages: { fetch: vi.fn().mockResolvedValue(statusMessage) }
      }),
      send
    };
    const completeNotification = vi.fn().mockResolvedValue(undefined);
    const database = {
      claimDueTrackings: vi.fn().mockResolvedValue([]),
      reconciliationCursor: vi.fn().mockResolvedValue("0"),
      setReconciliationCursor: vi.fn(),
      claimNotifications: vi.fn().mockResolvedValue([
        {
          id: "1",
          tracking_id: "tracking-1",
          discord_user_id: "1197857362942378017",
          payload: {
            eventId: "42",
            eventType: "discord:actioned",
            internalReportId: report.internalReportId,
            occurredAt: report.updatedAt
          },
          attempts: 0
        }
      ]),
      statusDmMessageId: vi.fn().mockResolvedValue("dm-message-1"),
      aiDecisions: vi.fn().mockResolvedValue([]),
      completeNotification
    } as unknown as BotDatabase;
    const api = {
      lifecycleEvents: vi.fn().mockResolvedValue({ events: [] }),
      report: vi.fn().mockResolvedValue(report)
    } as unknown as DsaApi;
    const client = {
      users: { fetch: vi.fn().mockResolvedValue(user) }
    } as unknown as Client;
    const worker = new NotificationWorker(
      database,
      api,
      client,
      {} as BotConfig,
      {} as ServerResolver
    );

    await worker.tick();

    expect(edit).toHaveBeenCalledOnce();
    expect(reply).toHaveBeenCalledOnce();
    const replyPayload = reply.mock.calls[0]?.[0] as { content: string } | undefined;
    expect(replyPayload?.content).toContain("accepted");
    expect(send).not.toHaveBeenCalled();
    expect(completeNotification).toHaveBeenCalledWith("1");
  });

  it("uses the same full report embed for pre-submission failure DMs", async () => {
    const report = reportFixture();
    report.status = "failed";
    report.discordReportId = null;
    report.discordStatus = null;
    report.retryable = true;
    report.error = { code: "verification_email_timeout", message: "Verification timed out." };
    const send = vi.fn().mockResolvedValue({ id: "failure-status-message" });
    const completeNotification = vi.fn().mockResolvedValue(undefined);
    const saveStatusDmMessageId = vi.fn().mockResolvedValue(undefined);
    const database = {
      claimDueTrackings: vi.fn().mockResolvedValue([]),
      reconciliationCursor: vi.fn().mockResolvedValue("0"),
      setReconciliationCursor: vi.fn(),
      claimNotifications: vi.fn().mockResolvedValue([
        {
          id: "2",
          tracking_id: "tracking-2",
          discord_user_id: "1197857362942378017",
          payload: {
            eventId: "43",
            eventType: "report_failed",
            internalReportId: report.internalReportId,
            occurredAt: report.updatedAt
          },
          attempts: 0
        }
      ]),
      statusDmMessageId: vi.fn().mockResolvedValue(null),
      aiDecisions: vi.fn().mockResolvedValue([]),
      saveStatusDmMessageId,
      completeNotification
    } as unknown as BotDatabase;
    const worker = new NotificationWorker(
      database,
      {
        lifecycleEvents: vi.fn().mockResolvedValue({ events: [] }),
        report: vi.fn().mockResolvedValue(report)
      } as unknown as DsaApi,
      {
        users: { fetch: vi.fn().mockResolvedValue({ send }) }
      } as unknown as Client,
      {} as BotConfig,
      {} as ServerResolver
    );

    await worker.tick();

    expect(send).toHaveBeenCalledOnce();
    const payload = send.mock.calls[0]?.[0] as
      | { content?: string; embeds?: unknown[] }
      | undefined;
    expect(payload?.content).toBeUndefined();
    expect(payload?.embeds).toHaveLength(1);
    expect(JSON.stringify(payload?.embeds)).toContain("Verification timed out.");
    expect(JSON.stringify(payload?.embeds)).toContain("History");
    expect(saveStatusDmMessageId).toHaveBeenCalledWith(
      "tracking-2",
      "failure-status-message"
    );
    expect(completeNotification).toHaveBeenCalledWith("2");
  });

  it("shows a new-report retry button only for safely retryable failures", () => {
    const failed = reportFixture();
    failed.status = "failed";
    failed.retryable = true;
    failed.retrySequence = 1;
    expect(reportRetryComponents(failed)[0]?.components[0]?.data).toMatchObject({
      custom_id: `reports:retry:${failed.internalReportId}`,
      label: "Retry as new report"
    });

    failed.retrySequence = 2;
    expect(reportRetryComponents(failed)[0]?.components[0]?.data).toMatchObject({
      custom_id: `reports:retry:${failed.internalReportId}`,
      label: "Retry as new report"
    });

    failed.retrySequence = 50;
    expect(reportRetryComponents(failed)).not.toEqual([]);
  });

  it("shows resend and rewrite controls after a denied appeal", () => {
    const denied = reportFixture();
    denied.discordStatus = "review_not_approved";
    denied.reviewStatus = "not_approved";
    denied.resubmittable = true;

    const controls = reportRetryComponents(denied)[0]?.components.map(
      (component) => component.data
    );
    expect(controls).toEqual([
      expect.objectContaining({
        custom_id: `reports:retry:${denied.internalReportId}`,
        label: "Resend same report"
      }),
      expect.objectContaining({
        custom_id: `reports:rewrite:${denied.internalReportId}`,
        label: "Rewrite & resend"
      })
    ]);
  });

  it("retries unlinked events but acknowledges accepted and expired events", () => {
    expect(reportEventTrackingResult(undefined)).toBe("not_tracked_yet");
    expect(reportEventTrackingResult({ tracking_expired: false })).toBe("accepted");
    expect(reportEventTrackingResult({ tracking_expired: true })).toBe("expired");
    expect(reportEventIngestionStatus("not_tracked_yet")).toBe(409);
    expect(reportEventIngestionStatus("accepted")).toBe(202);
    expect(reportEventIngestionStatus("expired")).toBe(202);
  });

  it("reconciles existing lifecycle events when no cursor has been stored yet", async () => {
    const event = {
      eventId: "42",
      internalReportId: "report-1",
      submitterDiscordUserId: "1197857362942378017",
      type: "report_submitted",
      occurredAt: "2026-07-20T00:00:00.000Z",
      lifecycleAttempt: 1
    };
    const ingestLifecycleEvent = vi.fn().mockResolvedValue("accepted");
    const setReconciliationCursor = vi.fn().mockResolvedValue(undefined);
    const database = {
      claimDueTrackings: vi.fn().mockResolvedValue([]),
      reconciliationCursor: vi.fn().mockResolvedValue(null),
      setReconciliationCursor,
      ingestLifecycleEvent,
      claimNotifications: vi.fn().mockResolvedValue([])
    } as unknown as BotDatabase;
    const lifecycleEvents = vi
      .fn()
      .mockResolvedValueOnce({ events: [event] })
      .mockResolvedValueOnce({ events: [] });
    const worker = new NotificationWorker(
      database,
      { lifecycleEvents } as unknown as DsaApi,
      {} as Client,
      {} as BotConfig,
      {} as ServerResolver
    );

    await worker.tick();

    expect(setReconciliationCursor).toHaveBeenCalledWith("0");
    expect(ingestLifecycleEvent).toHaveBeenCalledWith(event);
    expect(setReconciliationCursor).toHaveBeenLastCalledWith("42");
  });
});

describe("report component responsiveness", () => {
  it("retries an owned ineligible appeal and refreshes the private status", async () => {
    const ineligible = reportFixture();
    ineligible.discordStatus = "closed_no_action";
    ineligible.reviewStatus = "ineligible";
    ineligible.appealRetryable = true;
    const queued = reportFixture();
    queued.discordStatus = "closed_no_action";
    queued.reviewStatus = "queued";
    queued.appealRetryable = false;
    const retryAppeal = vi.fn().mockResolvedValue(queued);
    const report = vi.fn().mockResolvedValue(ineligible);
    const deferUpdate = vi.fn().mockResolvedValue(undefined);
    const editReply = vi.fn().mockResolvedValue(undefined);
    const handler = new InteractionHandler({
      api: { report, retryAppeal } as unknown as DsaApi,
      config: {
        adminUserIds: new Set<string>(),
        whitelistEnabled: false
      } as unknown as BotConfig,
      countries: ["DE"],
      database: {} as BotDatabase,
      messageResolver: {} as MessageResolver,
      profileResolver: {} as ProfileResolver,
      reportWriter: {} as ReportWriter,
      serverResolver: {} as ServerResolver
    });
    const interaction = {
      id: "interaction-1",
      isAutocomplete: () => false,
      isMessageContextMenuCommand: () => false,
      isChatInputCommand: () => false,
      isModalSubmit: () => false,
      isStringSelectMenu: () => false,
      isButton: () => true,
      isRepliable: () => true,
      customId: `reports:retry-appeal:${ineligible.internalReportId}`,
      user: { id: "1197857362942378017" },
      deferUpdate,
      editReply,
      deferred: false,
      replied: false
    } as unknown as Interaction;

    await handler.handle(interaction);

    expect(deferUpdate).toHaveBeenCalledOnce();
    expect(report).toHaveBeenCalledWith(ineligible.internalReportId);
    expect(retryAppeal).toHaveBeenCalledWith(
      ineligible.internalReportId,
      "interaction-1",
      "1197857362942378017"
    );
    const payload = editReply.mock.calls[0]?.[0] as
      | { content?: string; components?: unknown[]; embeds?: unknown[] }
      | undefined;
    expect(payload?.content).toBe("Appeal queued for another attempt.");
    expect(JSON.stringify(payload)).not.toContain("reports:retry-appeal");
  });

  it("keeps the report card and offers a private cooldown message", async () => {
    const ineligible = reportFixture();
    ineligible.discordStatus = "closed_no_action";
    ineligible.reviewStatus = "ineligible";
    ineligible.appealRetryable = true;
    const retryAppeal = vi.fn().mockRejectedValue(
      new DsaApiError(409, "review_retry_cooldown", "Wait 30 seconds before trying again.")
    );
    const deferUpdate = vi.fn().mockResolvedValue(undefined);
    const editReply = vi.fn().mockResolvedValue(undefined);
    const followUp = vi.fn().mockResolvedValue(undefined);
    const handler = new InteractionHandler({
      api: {
        report: vi.fn().mockResolvedValue(ineligible),
        retryAppeal
      } as unknown as DsaApi,
      config: {
        adminUserIds: new Set<string>(),
        whitelistEnabled: false
      } as unknown as BotConfig,
      countries: ["DE"],
      database: {} as BotDatabase,
      messageResolver: {} as MessageResolver,
      profileResolver: {} as ProfileResolver,
      reportWriter: {} as ReportWriter,
      serverResolver: {} as ServerResolver
    });
    const interaction = {
      id: "interaction-2",
      isAutocomplete: () => false,
      isMessageContextMenuCommand: () => false,
      isChatInputCommand: () => false,
      isModalSubmit: () => false,
      isStringSelectMenu: () => false,
      isButton: () => true,
      isRepliable: () => true,
      customId: `reports:retry-appeal:${ineligible.internalReportId}`,
      user: { id: "1197857362942378017" },
      deferUpdate,
      editReply,
      followUp,
      deferred: false,
      replied: false
    } as unknown as Interaction;

    await handler.handle(interaction);

    expect(deferUpdate).toHaveBeenCalledOnce();
    expect(editReply).not.toHaveBeenCalled();
    expect(followUp).toHaveBeenCalledOnce();
    expect(followUp.mock.calls[0]?.[0]).toMatchObject({ flags: MessageFlags.Ephemeral });
    expect(JSON.stringify(followUp.mock.calls[0]?.[0])).toContain(
      "Wait 30 seconds before trying again."
    );
  });

  it("keeps report status ephemeral without sending a duplicate DM", async () => {
    const report = reportFixture();
    const send = vi.fn().mockResolvedValue({ id: "dm-message" });
    const deferReply = vi.fn().mockResolvedValue(undefined);
    const editReply = vi.fn().mockResolvedValue(undefined);
    const handler = new InteractionHandler({
      api: { report: vi.fn().mockResolvedValue(report) } as unknown as DsaApi,
      config: {
        adminUserIds: new Set<string>(),
        whitelistEnabled: false
      } as unknown as BotConfig,
      countries: ["DE"],
      database: {} as BotDatabase,
      messageResolver: {} as MessageResolver,
      profileResolver: {} as ProfileResolver,
      reportWriter: {} as ReportWriter,
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
      commandName: "reports",
      user: { id: "1197857362942378017", send },
      options: {
        getSubcommand: () => "status",
        getString: (name: string) =>
          name === "report-id" ? report.internalReportId : null
      },
      deferReply,
      editReply,
      deferred: false,
      replied: false
    } as unknown as Interaction;

    await handler.handle(interaction);

    expect(deferReply).toHaveBeenCalledWith({ flags: MessageFlags.Ephemeral });
    expect(send).not.toHaveBeenCalled();
    const replyJson = JSON.stringify(editReply.mock.calls[0]?.[0]);
    expect(replyJson).toContain("History");
    expect(replyJson).not.toContain("Check your DMs for the full status log.");
  });

  it("contains a secondary response failure after the original interaction error", async () => {
    const reply = vi.fn().mockRejectedValue(Object.assign(new Error("Unknown interaction"), {
      code: 10_062,
      status: 404
    }));
    const handler = new InteractionHandler({
      api: {} as DsaApi,
      config: {
        adminUserIds: new Set<string>(),
        whitelistEnabled: true
      } as unknown as BotConfig,
      countries: ["DE"],
      database: {
        getAccess: vi.fn().mockRejectedValue(new Error("Database unavailable"))
      } as unknown as BotDatabase,
      messageResolver: {} as MessageResolver,
      profileResolver: {} as ProfileResolver,
      reportWriter: {} as ReportWriter,
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
      commandName: "access",
      user: { id: "1197857362942378017" },
      options: { getSubcommand: () => "status" },
      reply,
      deferred: false,
      replied: false
    } as unknown as Interaction;

    await expect(handler.handle(interaction)).resolves.toBeUndefined();
    expect(reply).toHaveBeenCalledOnce();
  });

  it("defers report pagination before fetching the next report", async () => {
    const report = reportFixture();
    const deferUpdate = vi.fn().mockResolvedValue(undefined);
    const editReply = vi.fn().mockResolvedValue(undefined);
    const update = vi.fn();
    const api = {
      reportsFor: vi.fn().mockResolvedValue({ reports: [report] }),
      report: vi.fn().mockResolvedValue(report)
    } as unknown as DsaApi;
    const handler = new InteractionHandler({
      api,
      config: {
        adminUserIds: new Set<string>(),
        whitelistEnabled: false
      } as unknown as BotConfig,
      countries: ["DE"],
      database: {} as BotDatabase,
      messageResolver: {} as MessageResolver,
      profileResolver: {} as ProfileResolver,
      reportWriter: {} as ReportWriter,
      serverResolver: {} as ServerResolver
    });
    const interaction = {
      isAutocomplete: () => false,
      isMessageContextMenuCommand: () => false,
      isChatInputCommand: () => false,
      isModalSubmit: () => false,
      isStringSelectMenu: () => false,
      isButton: () => true,
      isRepliable: () => true,
      customId: "reports:page:0",
      user: { id: "1197857362942378017" },
      deferUpdate,
      editReply,
      update,
      deferred: false,
      replied: false
    } as unknown as Interaction;

    await handler.handle(interaction);

    expect(deferUpdate).toHaveBeenCalledOnce();
    expect(editReply).toHaveBeenCalledOnce();
    expect(update).not.toHaveBeenCalled();
  });
});

describe("report interaction country precedence", () => {
  it("stores combined-modal preferences and keeps review ephemeral when DM is off", async () => {
    const dataEncryptionKey = randomBytes(32);
    const updateDraft = vi.fn();
    const database = {
      getDraft: vi.fn().mockResolvedValue(
        encryptJson(
          {
            flow: "message_urf",
            messageUrl:
              "https://discord.com/channels/@me/123456789012345678/123456789012345679",
            country: "DE",
            countrySelection: "default",
            sendToDms: true
          },
          dataEncryptionKey
        )
      ),
      updateDraft
    } as unknown as BotDatabase;
    const handler = new InteractionHandler({
      api: {} as DsaApi,
      config: {
        whitelistEnabled: false,
        adminUserIds: new Set<string>(),
        dataEncryptionKey,
        keyPepper: "test-key-pepper"
      } as unknown as BotConfig,
      countries: ["DE"],
      database,
      messageResolver: {} as MessageResolver,
      profileResolver: {} as ProfileResolver,
      reportWriter: {} as ReportWriter,
      serverResolver: {} as ServerResolver
    });
    const deferReply = vi.fn();
    const editReply = vi.fn();
    const send = vi.fn();
    const interaction = {
      isAutocomplete: () => false,
      isMessageContextMenuCommand: () => false,
      isChatInputCommand: () => false,
      isModalSubmit: () => true,
      isStringSelectMenu: () => false,
      isButton: () => false,
      isRepliable: () => true,
      customId: "report:modal:draft-id",
      user: { id: "1197857362942378017", send },
      fields: {
        getCheckboxGroup: () => [],
        getStringSelectValues: (name: string) =>
          name === "country_mode"
            ? ["DEFAULT"]
            : name === "report_type"
              ? ["sub_other_hate_speech"]
              : [],
        getTextInputValue: (name: string) =>
          name === "brief" ? "I am reporting this message for abusive language." : ""
      },
      deferReply,
      editReply,
      deferred: false,
      replied: false
    } as unknown as Interaction;

    await handler.handle(interaction);

    const encrypted = String(updateDraft.mock.calls.at(-1)?.[2]);
    expect(decryptJson(encrypted, dataEncryptionKey)).toMatchObject({
      aiDisabled: true,
      countrySelection: "default",
      sendToDms: false
    });
    expect(deferReply).toHaveBeenCalledWith({ flags: MessageFlags.Ephemeral });
    expect(JSON.stringify(editReply.mock.calls.at(-1)?.[0])).toContain("Submit DSA Report");
    expect(send).not.toHaveBeenCalled();
  });

  it("resolves a profile before showing the account confirmation", async () => {
    const deferReply = vi.fn();
    const editReply = vi.fn();
    const showModal = vi.fn();
    const saveDraft = vi.fn().mockResolvedValue("draft-id");
    const database = {
      getAccess: vi.fn().mockResolvedValue({
        credits: 0,
        defaultCountry: "DE",
        suspended: false,
        suspensionReason: null
      }),
      saveDraft,
      updateDraft: vi.fn()
    } as unknown as BotDatabase;
    const resolveProfile = vi.fn().mockResolvedValue({
      userId: "123456789012345678",
      username: "example",
      globalDisplayName: "Example Display",
      avatarUrl: "https://cdn.discordapp.com/avatar.png",
      bannerUrl: null,
      bot: false,
      resolvedAt: "2026-07-20T00:00:00.000Z"
    });
    const profileResolver = {
      resolve: resolveProfile
    } as unknown as ProfileResolver;
    const config = {
      whitelistEnabled: false,
      adminUserIds: new Set<string>(),
      dataEncryptionKey: randomBytes(32)
    } as unknown as BotConfig;
    const handler = new InteractionHandler({
      api: {} as DsaApi,
      config,
      countries: ["DE"],
      database,
      messageResolver: {} as MessageResolver,
      profileResolver,
      reportWriter: {} as ReportWriter,
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
      guild: null,
      options: {
        getSubcommand: () => "profile",
        getString: (name: string) =>
          name === "target" ? "123456789012345678" : null
      },
      deferReply,
      editReply,
      showModal,
      deferred: false,
      replied: false
    } as unknown as Interaction;

    await handler.handle(interaction);

    expect(resolveProfile).toHaveBeenCalledWith("123456789012345678");
    expect(
      decryptJson(String(saveDraft.mock.calls[0]?.[1]), config.dataEncryptionKey)
    ).toMatchObject({ country: "DE", countrySelection: "default", sendToDms: true });
    expect(deferReply).toHaveBeenCalledWith({ flags: MessageFlags.Ephemeral });
    expect(JSON.stringify(editReply.mock.calls[0]?.[0])).toContain("Resolved account");
    expect(JSON.stringify(editReply.mock.calls[0]?.[0])).toContain("Example Display");
    expect(showModal).not.toHaveBeenCalled();
  });

  it("uses Auto when neither an explicit nor saved country exists", async () => {
    const showModal = vi.fn();
    const saveDraft = vi.fn().mockResolvedValue("draft-id");
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
      messageResolver: {} as MessageResolver,
      profileResolver: {} as ProfileResolver,
      reportWriter: {} as ReportWriter,
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
      showModal,
      deferred: false,
      replied: false
    } as unknown as Interaction;

    await handler.handle(interaction);

    expect(saveDraft).toHaveBeenCalledOnce();
    const encrypted: unknown = saveDraft.mock.calls[0]?.[1] as unknown;
    expect(typeof encrypted).toBe("string");
    expect(decryptJson(String(encrypted), config.dataEncryptionKey)).toMatchObject({
      countrySelection: "auto"
    });
    expect(showModal).toHaveBeenCalledOnce();
  });

  it("skips AI providers when a manual report modal is submitted", async () => {
    const dataEncryptionKey = randomBytes(32);
    const draft = {
      aiDisabled: true,
      flow: "message_urf" as const,
      country: "DE",
      countrySelection: "override" as const,
      messageUrl:
        "https://discord.com/channels/@me/123456789012345678/123456789012345679"
    };
    const updateDraft = vi.fn();
    const database = {
      getDraft: vi.fn().mockResolvedValue(encryptJson(draft, dataEncryptionKey)),
      updateDraft
    } as unknown as BotDatabase;
    const generate = vi.fn();
    const handler = new InteractionHandler({
      api: {} as DsaApi,
      config: {
        whitelistEnabled: false,
        adminUserIds: new Set<string>(),
        dataEncryptionKey,
        keyPepper: "test-key-pepper"
      } as unknown as BotConfig,
      countries: ["DE"],
      database,
      messageResolver: {} as MessageResolver,
      profileResolver: {} as ProfileResolver,
      reportWriter: { generate } as unknown as ReportWriter,
      serverResolver: {} as ServerResolver
    });
    const deferReply = vi.fn();
    const editReply = vi.fn();
    const send = vi.fn().mockResolvedValue({ id: "review-dm-id" });
    const interaction = {
      isAutocomplete: () => false,
      isMessageContextMenuCommand: () => false,
      isChatInputCommand: () => false,
      isModalSubmit: () => true,
      isStringSelectMenu: () => false,
      isButton: () => false,
      isRepliable: () => true,
      customId: "report:modal:draft-id",
      user: { id: "1197857362942378017", send },
      fields: {
        getCheckboxGroup: () => ["SEND_DM"],
        getStringSelectValues: (name: string) =>
          name === "country_mode"
            ? ["DEFAULT"]
            : name === "report_type"
              ? ["sub_other_hate_speech"]
              : [],
        getTextInputValue: (name: string) =>
          name === "brief" ? "I am reporting this message for abusive language." : ""
      },
      deferReply,
      editReply,
      deferred: false,
      replied: false
    } as unknown as Interaction;

    await handler.handle(interaction);

    expect(generate).not.toHaveBeenCalled();
    expect(deferReply).toHaveBeenCalledWith({ flags: MessageFlags.Ephemeral });
    const encrypted = String(updateDraft.mock.calls.at(-1)?.[2]);
    expect(decryptJson(encrypted, dataEncryptionKey)).toMatchObject({
      aiDisabled: true,
      context: "I am reporting this message for abusive language.",
      reportType: "sub_other_hate_speech",
      reviewDmMessageId: "review-dm-id",
      sendToDms: true
    });
    expect(JSON.stringify(send.mock.calls[0]?.[0])).toContain("Submit DSA Report");
    expect(JSON.stringify(editReply.mock.calls.at(-1)?.[0])).toContain(
      "Check your DMs."
    );
  });

  it("creates one drafting DM and edits it through progress and review", async () => {
    const dataEncryptionKey = randomBytes(32);
    const draft = {
      flow: "message_urf" as const,
      country: "DE",
      countrySelection: "default" as const,
      messageUrl:
        "https://discord.com/channels/@me/123456789012345678/123456789012345679"
    };
    const updateDraft = vi.fn();
    const database = {
      getDraft: vi.fn().mockResolvedValue(encryptJson(draft, dataEncryptionKey)),
      updateDraft
    } as unknown as BotDatabase;
    const editDm = vi.fn().mockResolvedValue(undefined);
    const dmMessage = { id: "draft-dm-id", edit: editDm };
    const send = vi.fn().mockResolvedValue(dmMessage);
    const fetchDm = vi.fn().mockResolvedValue(dmMessage);
    const generate = vi.fn().mockImplementation(
      async (
        _draft: unknown,
        _actor: unknown,
        progress: (value: {
          stage: "research" | "write";
          country: string;
          reportReason: string;
          reportType: string;
        }) => Promise<void>
      ) => {
        await progress({
          stage: "research",
          country: "DE",
          reportReason: "The message contains hateful content.",
          reportType: "Other: hate speech"
        });
        await progress({
          stage: "write",
          country: "DE",
          reportReason: "The message contains hateful content.",
          reportType: "Other: hate speech"
        });
        return {
          country: "DE",
          legalResearch: {
            country: "DE",
            summary: "Relevant law.",
            sources: [],
            researchedAt: "2026-07-20T00:00:00.000Z",
            searchRequests: 0
          },
          report: "The final report details.",
          reportReason: "The message contains hateful content.",
          reportType: "sub_other_hate_speech",
          conversation: []
        };
      }
    );
    const handler = new InteractionHandler({
      api: {} as DsaApi,
      config: {
        whitelistEnabled: false,
        adminUserIds: new Set<string>(),
        dataEncryptionKey,
        keyPepper: "test-key-pepper"
      } as unknown as BotConfig,
      countries: ["DE"],
      database,
      messageResolver: { resolve: vi.fn().mockResolvedValue(null) } as unknown as MessageResolver,
      profileResolver: {} as ProfileResolver,
      reportWriter: { generate } as unknown as ReportWriter,
      serverResolver: {} as ServerResolver
    });
    const editReply = vi.fn().mockResolvedValue(undefined);
    const interaction = {
      isAutocomplete: () => false,
      isMessageContextMenuCommand: () => false,
      isChatInputCommand: () => false,
      isModalSubmit: () => true,
      isStringSelectMenu: () => false,
      isButton: () => false,
      isRepliable: () => true,
      customId: "report:modal:draft-id",
      user: {
        id: "1197857362942378017",
        send,
        createDM: vi.fn().mockResolvedValue({ messages: { fetch: fetchDm } })
      },
      fields: {
        getCheckboxGroup: () => ["USE_AI", "SEND_DM"],
        getStringSelectValues: (name: string) =>
          name === "country_mode" ? ["DEFAULT"] : [],
        getTextInputValue: () => ""
      },
      deferReply: vi.fn(),
      editReply,
      deferred: false,
      replied: false
    } as unknown as Interaction;

    await handler.handle(interaction);

    expect(generate).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledOnce();
    expect(editDm).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(send.mock.calls[0]?.[0])).toContain("Researching report");
    expect(JSON.stringify(editDm.mock.calls[0]?.[0])).toContain("Writing report");
    expect(JSON.stringify(editDm.mock.calls[1]?.[0])).toContain("Ready for review");
    expect(JSON.stringify(editDm.mock.calls[1]?.[0])).toContain("Submit DSA Report");
    expect(JSON.stringify(editReply.mock.calls.at(-1)?.[0])).toContain(
      "Check your DMs."
    );
    expect(
      decryptJson(String(updateDraft.mock.calls.at(-1)?.[2]), dataEncryptionKey)
    ).toMatchObject({ reviewDmMessageId: "draft-dm-id", sendToDms: true });
  });
});

describe("quick report message context flow", () => {
  function quickTargetMessage() {
    return {
      id: "123456789012345679",
      channelId: "123456789012345678",
      channel: { name: "general" },
      guildId: null,
      guild: null,
      member: null,
      author: { id: "999", username: "reported-user", globalName: null, bot: false },
      content: "hateful content",
      createdAt: new Date("2026-07-19T00:00:00.000Z"),
      attachments: { values: () => [] },
      embeds: [],
      url: "https://discord.com/channels/1/123456789012345678/123456789012345679"
    };
  }

  function quickInteraction(overrides: {
    send: ReturnType<typeof vi.fn>;
    createDM?: ReturnType<typeof vi.fn>;
    deferReply: ReturnType<typeof vi.fn>;
    editReply: ReturnType<typeof vi.fn>;
    reply?: ReturnType<typeof vi.fn>;
  }) {
    return {
      isAutocomplete: () => false,
      isMessageContextMenuCommand: () => true,
      isChatInputCommand: () => false,
      isModalSubmit: () => false,
      isStringSelectMenu: () => false,
      isButton: () => false,
      isRepliable: () => true,
      commandName: "Quick Report Message",
      id: "interaction-id",
      user: {
        id: "1197857362942378017",
        send: overrides.send,
        ...(overrides.createDM ? { createDM: overrides.createDM } : {})
      },
      targetMessage: quickTargetMessage(),
      deferReply: overrides.deferReply,
      editReply: overrides.editReply,
      ...(overrides.reply ? { reply: overrides.reply } : {}),
      deferred: false,
      replied: false
    } as unknown as Interaction;
  }

  it("generates and submits without confirmation, delivering the result to DMs", async () => {
    const report = reportFixture();
    const dataEncryptionKey = randomBytes(32);
    const saveDraft = vi.fn().mockResolvedValue("draft-id");
    const updateDraft = vi.fn().mockResolvedValue(undefined);
    const reserveSubmission = vi.fn().mockResolvedValue({
      id: "tracking-id",
      interactionId: "interaction-id",
      creditState: "reserved",
      replayed: false,
      balanceBefore: 1,
      balanceAfter: 0
    });
    const markSubmissionCreated = vi.fn().mockResolvedValue("consumed");
    const deleteDraft = vi.fn().mockResolvedValue(undefined);
    const saveStatusDmMessageId = vi.fn().mockResolvedValue(undefined);
    const observeReport = vi.fn().mockResolvedValue(undefined);
    const database = {
      getAccess: vi.fn().mockResolvedValue({
        credits: 1,
        suspended: false,
        defaultCountry: "DE"
      }),
      saveDraft,
      updateDraft,
      reserveSubmission,
      markSubmissionCreated,
      deleteDraft,
      saveStatusDmMessageId,
      observeReport
    } as unknown as BotDatabase;
    const createReport = vi.fn().mockResolvedValue(report);
    const generate = vi.fn().mockResolvedValue({
      conversation: [],
      country: "DE",
      legalResearch: {
        country: "DE",
        summary: "Legal summary.",
        sources: [],
        researchedAt: "2026-07-19T00:00:00.000Z",
        searchRequests: 0
      },
      report: "AI-written report text.",
      reportReason: "The message contains hateful content.",
      reportType: "sub_other_hate_speech"
    });
    const handler = new InteractionHandler({
      api: { createReport } as unknown as DsaApi,
      config: {
        whitelistEnabled: true,
        adminUserIds: new Set<string>(),
        dataEncryptionKey,
        keyPepper: "test-key-pepper"
      } as unknown as BotConfig,
      countries: ["DE"],
      database,
      messageResolver: {} as MessageResolver,
      profileResolver: {} as ProfileResolver,
      reportWriter: { generate } as unknown as ReportWriter,
      serverResolver: {} as ServerResolver
    });
    const send = vi.fn().mockResolvedValue({ id: "progress-dm-id" });
    const editDm = vi.fn().mockResolvedValue(undefined);
    const createDM = vi.fn().mockResolvedValue({
      messages: { fetch: vi.fn().mockResolvedValue({ edit: editDm }) }
    });
    const deferReply = vi.fn().mockResolvedValue(undefined);
    const editReply = vi.fn().mockResolvedValue(undefined);
    const interaction = quickInteraction({ send, createDM, deferReply, editReply });

    await handler.handle(interaction);

    expect(deferReply).toHaveBeenCalledWith({ flags: MessageFlags.Ephemeral });
    expect(JSON.stringify(editReply.mock.calls[0]?.[0])).toContain("Quick report started");
    expect(generate).toHaveBeenCalledOnce();
    expect(
      decryptJson(String(saveDraft.mock.calls[0]?.[1]), dataEncryptionKey)
    ).toMatchObject({
      flow: "message_urf",
      country: "DE",
      countrySelection: "default",
      sendToDms: true
    });
    expect(createReport).toHaveBeenCalledWith(
      "interaction-id",
      expect.objectContaining({
        flow: "message_urf",
        country: "DE",
        messageUrl: "https://discord.com/channels/1/123456789012345678/123456789012345679"
      })
    );
    expect(reserveSubmission).toHaveBeenCalledOnce();
    expect(deleteDraft).toHaveBeenCalledWith("1197857362942378017", "draft-id");
    expect(saveStatusDmMessageId).toHaveBeenCalledWith("tracking-id", "progress-dm-id");
    expect(observeReport).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledOnce();
    expect(editDm).toHaveBeenCalledOnce();
    expect(JSON.stringify(editDm.mock.calls[0]?.[0])).toContain("1527695430949798110");
  });

  it("rejects suspended users without generating a report", async () => {
    const database = {
      getAccess: vi.fn().mockResolvedValue({
        credits: 1,
        suspended: true,
        defaultCountry: null
      })
    } as unknown as BotDatabase;
    const generate = vi.fn();
    const handler = new InteractionHandler({
      api: {} as DsaApi,
      config: {
        whitelistEnabled: true,
        adminUserIds: new Set<string>()
      } as unknown as BotConfig,
      countries: ["DE"],
      database,
      messageResolver: {} as MessageResolver,
      profileResolver: {} as ProfileResolver,
      reportWriter: { generate } as unknown as ReportWriter,
      serverResolver: {} as ServerResolver
    });
    const reply = vi.fn().mockResolvedValue(undefined);
    const interaction = quickInteraction({
      send: vi.fn(),
      deferReply: vi.fn(),
      editReply: vi.fn(),
      reply
    });

    await handler.handle(interaction);

    expect(generate).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledOnce();
    expect(JSON.stringify(reply.mock.calls[0]?.[0])).toContain("suspended");
  });
});

describe("experimental report batch interaction flow", () => {
  function experimentalTargetMessage() {
    return {
      id: "123456789012345679",
      channelId: "123456789012345678",
      channel: { name: "general" },
      guildId: null,
      guild: null,
      member: null,
      author: { id: "999", username: "reported-user", globalName: null, bot: false },
      content: "hateful content",
      createdAt: new Date("2026-08-09T00:00:00.000Z"),
      attachments: { values: () => [] },
      embeds: [],
      url: "https://discord.com/channels/1/123456789012345678/123456789012345679"
    };
  }

  it.each([
    ["Experimental 10x Same Category", "same_category_10x", 10],
    [
      "Experimental All Categories",
      "all_categories",
      USER_MESSAGE_REPORT_REASONS.length
    ]
  ] as const)(
    "defers and durably reserves %s without inline AI or API work",
    async (commandName, mode, requiredCredits) => {
      const order: string[] = [];
      const dataEncryptionKey = randomBytes(32);
      const reserveExperimentalBatch = vi.fn(
        (input: Parameters<BotDatabase["reserveExperimentalBatch"]>[0]) => {
          void input;
          order.push("reserve");
          return Promise.resolve({
            batchId: "batch-id",
            itemCount: requiredCredits,
            balanceBefore: 30,
            balanceAfter: 30 - requiredCredits,
            replayed: false
          });
        }
      );
      const database = {
        getAccess: vi.fn(() => {
          order.push("access");
          return Promise.resolve({
            credits: 30,
            suspended: false,
            defaultCountry: "DE"
          });
        }),
        reserveExperimentalBatch
      } as unknown as BotDatabase;
      const generate = vi.fn();
      const createReport = vi.fn();
      const handler = new InteractionHandler({
        api: { createReport } as unknown as DsaApi,
        config: {
          whitelistEnabled: true,
          adminUserIds: new Set<string>(),
          dataEncryptionKey,
          keyPepper: "test-key-pepper"
        } as unknown as BotConfig,
        countries: ["DE"],
        database,
        messageResolver: {} as MessageResolver,
        profileResolver: {} as ProfileResolver,
        reportWriter: { generate } as unknown as ReportWriter,
        serverResolver: {} as ServerResolver
      });
      const editReply = vi.fn((payload: unknown) => {
        void payload;
        order.push("edit");
        return Promise.resolve();
      });
      const interaction = {
        isAutocomplete: () => false,
        isMessageContextMenuCommand: () => true,
        isChatInputCommand: () => false,
        isModalSubmit: () => false,
        isStringSelectMenu: () => false,
        isButton: () => false,
        isRepliable: () => true,
        commandName,
        id: "interaction-id",
        user: { id: "1197857362942378017" },
        targetMessage: experimentalTargetMessage(),
        deferReply: vi.fn(() => {
          order.push("defer");
          return Promise.resolve();
        }),
        editReply,
        deferred: false,
        replied: false
      } as unknown as Interaction;

      await handler.handle(interaction);

      expect(order[0]).toBe("defer");
      expect(reserveExperimentalBatch).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: "1197857362942378017",
          interactionId: "interaction-id",
          mode,
          requiredCredits,
          adminBypass: false
        })
      );
      const reservation = reserveExperimentalBatch.mock.calls[0]?.[0];
      expect(reservation?.definitions).toHaveLength(requiredCredits);
      expect(
        decryptJson(String(reservation?.encryptedDraft), dataEncryptionKey)
      ).toMatchObject({
        flow: "message_urf",
        country: "DE",
        countrySelection: "default",
        sendToDms: false
      });
      expect(generate).not.toHaveBeenCalled();
      expect(createReport).not.toHaveBeenCalled();
      expect(JSON.stringify(editReply.mock.calls.at(-1)?.[0])).toContain(
        `${requiredCredits} credits reserved`
      );
    }
  );
});
