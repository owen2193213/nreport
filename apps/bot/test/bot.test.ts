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
import { NotificationWorker, renderNotification } from "../src/notifier.js";
import { matchingCountries } from "../src/countries.js";
import type { BotConfig } from "../src/config.js";
import type { BotDatabase } from "../src/database.js";
import {
  notificationEventKey,
  observedNotificationTypes,
  shouldNotifyLifecycleType
} from "../src/database.js";
import { InteractionHandler, shouldBypassReportCredits } from "../src/interactions.js";
import { reportEventIngestionStatus } from "../src/health.js";
import {
  isValidProfileTarget,
  ProfileResolver,
  normalizeProfileTarget
} from "../src/profile-resolver.js";
import { ServerResolver } from "../src/server-resolver.js";
import type { DsaApi, ReportDetail } from "@discord-dsa/contracts";
import {
  buildCountryPicker,
  buildReportModal,
  buildReview,
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
    const profile = subcommands.find((subcommand) => subcommand.name === "profile");
    const target = profile && "options" in profile
      ? profile.options?.find((option) => option.name === "target")
      : undefined;
    expect(target).toMatchObject({
      required: true,
      description: "Discord username or raw user ID",
      min_length: 2,
      max_length: 32
    });
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

  it("identifies the redeemer in key list and inspection output", () => {
    const list = JSON.stringify(accessKeysEmbed([redeemedKey]).toJSON());
    const detail = JSON.stringify(accessKeyEmbed(redeemedKey).toJSON());
    for (const output of [list, detail]) {
      expect(output).toContain("100000000000000002");
      expect(output).toContain("Redeemed");
    }
  });

  it("charges normal users only when credit enforcement is enabled", () => {
    expect(shouldBypassReportCredits(false, true)).toBe(false);
    expect(shouldBypassReportCredits(true, true)).toBe(true);
    expect(shouldBypassReportCredits(false, false)).toBe(true);
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

describe("profile resolution", () => {
  it("accepts only usernames or raw user IDs", () => {
    expect(normalizeProfileTarget("  example.user  ")).toBe("example.user");
    expect(isValidProfileTarget("example.user")).toBe(true);
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
      displayAvatarURL: () => "https://cdn.discordapp.com/avatar.png"
    });
    const client = {
      users: { fetch: fetchUser },
      guilds: { fetch: vi.fn() }
    } as unknown as Client;
    await expect(new ProfileResolver(client).resolve("123456789012345678")).resolves.toMatchObject({
      userId: "123456789012345678",
      username: "example",
      globalDisplayName: "Example Display",
      avatarUrl: "https://cdn.discordapp.com/avatar.png"
    });
    expect(fetchUser).toHaveBeenCalledWith("123456789012345678", { force: true });
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

  it("preserves a resolved profile ID and snapshot in the API request", () => {
    const snapshot = {
      userId: "123456789012345678",
      username: "example",
      globalDisplayName: "Example Display",
      avatarUrl: "https://cdn.discordapp.com/avatar.png",
      bot: false,
      resolvedAt: "2026-07-20T00:00:00.000Z"
    };
    expect(
      draftToCreateInput(
        {
          flow: "user_urf",
          country: "DE",
          reportType: "sub_other_hate_speech",
          reportedUsername: "example",
          reportedUserId: snapshot.userId,
          reportedUserSnapshot: snapshot,
          profileElements: ["name"],
          context: "The profile name contains unlawful hate speech."
        },
        "1197857362942378017"
      )
    ).toMatchObject({
      reportedUsername: "example",
      reportedUserId: snapshot.userId,
      reportedUserSnapshot: snapshot
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
    expect(JSON.stringify(json)).toContain("Attempt 3");
    expect(JSON.stringify(json)).not.toContain("Verification started");
  });

  it("renders lifecycle DMs with full details and the current timeline", () => {
    const rendered = renderNotification(reportFixture());
    const json = JSON.stringify(rendered.toJSON());
    expect(json).toContain("Discord took action");
    expect(json).toContain("discord.com/channels");
    expect(json).toContain("sensitive context");
    expect(json).toContain("History");
  });

  it("shows a lifecycle status only in the notification title and simplified history", () => {
    const report = reportFixture();
    report.discordStatus = "received";
    report.timeline[1]!.discordStatus = "received";
    const json = renderNotification(report, null, "discord:received").toJSON();
    expect(json.title).toBe("Report received by Discord");
    expect(json.description).toBeUndefined();
    expect(json.fields?.some((field) => field.name === "Discord review")).toBe(false);
    expect(json.fields?.some((field) => field.name === "Progress")).toBe(false);
  });
});

describe("lifecycle notification deduplication", () => {
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
    expect(observedNotificationTypes("submitted", null, submitted)).toEqual([]);
    expect(shouldNotifyLifecycleType("report_submitted")).toBe(true);
    expect(shouldNotifyLifecycleType("discord:received")).toBe(false);
    expect(shouldNotifyLifecycleType("discord:actioned")).toBe(true);
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
    expect(reportRetryComponents(failed)).toEqual([]);
  });

  it("asks the API to retry events that arrive before report tracking is linked", () => {
    expect(reportEventIngestionStatus(false)).toBe(409);
    expect(reportEventIngestionStatus(true)).toBe(202);
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
    const ingestLifecycleEvent = vi.fn().mockResolvedValue(true);
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
      profileResolver: {} as ProfileResolver,
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
      profileResolver: {} as ProfileResolver,
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
  it("asks how to interpret a snowflake-shaped profile target before opening the report modal", async () => {
    const deferReply = vi.fn();
    const editReply = vi.fn();
    const showModal = vi.fn();
    const database = {
      getAccess: vi.fn().mockResolvedValue({
        credits: 0,
        defaultCountry: "DE",
        suspended: false,
        suspensionReason: null
      }),
      saveDraft: vi.fn().mockResolvedValue("draft-id"),
      updateDraft: vi.fn()
    } as unknown as BotDatabase;
    const resolveProfile = vi.fn().mockResolvedValue({
      userId: "123456789012345678",
      username: "example",
      globalDisplayName: "Example Display",
      avatarUrl: "https://cdn.discordapp.com/avatar.png",
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
      profileResolver,
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

    expect(resolveProfile).toHaveBeenCalled();
    expect(deferReply).toHaveBeenCalledWith({ flags: MessageFlags.Ephemeral });
    expect(JSON.stringify(editReply.mock.calls[0]?.[0])).toContain("Report This Account");
    expect(showModal).not.toHaveBeenCalled();
  });

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
      profileResolver: {} as ProfileResolver,
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
