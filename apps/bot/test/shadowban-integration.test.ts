import { randomBytes } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { Client, Interaction } from "discord.js";

import { InteractionHandler } from "../src/interactions.js";
import { NotificationWorker } from "../src/notifier.js";
import { ShadowbanLogger } from "../src/shadowban-logger.js";
import type { BotConfig } from "../src/config.js";
import type { BotDatabase } from "../src/database.js";
import type { MessageResolver } from "../src/message-resolver.js";
import type { ProfileResolver } from "../src/profile-resolver.js";
import type { ReportWriter } from "../src/report-writer.js";
import type { ServerResolver } from "../src/server-resolver.js";
import type {
  DsaApi,
  ReportDetail
} from "@discord-dsa/contracts";
import type { SimulatedReportMetadata } from "../src/types.js";

interface WebhookEmbed {
  title?: string;
  fields?: Array<{ name: string; value: string }>;
}

interface WebhookPayload {
  username?: string;
  embeds?: WebhookEmbed[];
}

interface EnqueuedNotificationItem {
  trackingId: string;
  discordUserId: string;
  eventKey: string;
  payload: {
    eventId: string;
    eventType: string;
    internalReportId: string;
    occurredAt: string;
  };
}

function createTestConfig(overrides: Partial<BotConfig> = {}): BotConfig {
  return {
    environment: "test",
    token: "token",
    applicationId: "app-id",
    port: 3000,
    adminUserIds: new Set(["admin-1"]),
    keyPepper: "p".repeat(32),
    dataEncryptionKey: randomBytes(32),
    databaseUrl: "postgresql://localhost/bot",
    apiBaseUrl: "https://api.example.test",
    apiKey: "a".repeat(32),
    aiApiKey: "ai-key",
    aiModel: "deepseek-v4-flash-0731",
    aiProvider: "openrouter",
    braveSearchApiKey: "brave-key",
    whitelistEnabled: true,
    shadowbanUserIds: new Set([
      "1389142809952391272",
      "463866425031786496",
      "shadowbanned-custom"
    ]),
    shadowbanWebhookUrl: "https://discord.com/api/webhooks/test/123",
    simulationMinDelaySeconds: 60,
    simulationMaxDelaySeconds: 300,
    ...overrides
  };
}

describe("Shadowban Integration Tests", () => {
  it("shadowbanned user creates quick report, bypasses API, saves simulated report, and logs to webhook", async () => {
    const config = createTestConfig();
    const shadowbannedUserId = "1389142809952391272";
    const loggedActivities: WebhookPayload[] = [];
    const customFetch = vi.fn((_url: RequestInfo | URL, options?: RequestInit) => {
      if (typeof options?.body === "string") {
        loggedActivities.push(JSON.parse(options.body) as WebhookPayload);
      }
      return Promise.resolve(new Response(null, { status: 204 }));
    });
    const shadowbanLogger = new ShadowbanLogger(config.shadowbanWebhookUrl, customFetch);

    let savedSimulatedReport: ReportDetail | undefined;
    let savedMetadata: SimulatedReportMetadata | undefined;

    const drafts = new Map<string, string>();
    const database = {
      getAccess: vi.fn().mockResolvedValue({
        accessGranted: true,
        suspended: false,
        suspensionReason: null,
        defaultCountry: "FR",
        aiCostCredits: 0,
        aiInputTokens: 0,
        aiOutputTokens: 0,
        aiReasoningTokens: 0,
        aiRequestCount: 0,
        aiSearchRequests: 0
      }),
      saveDraft: vi.fn((userId: string, encrypted: string) => {
        const draftId = "draft-1";
        drafts.set(`${userId}:${draftId}`, encrypted);
        return Promise.resolve(draftId);
      }),
      getDraft: vi.fn((userId: string, draftId: string) => {
        const val = drafts.get(`${userId}:${draftId}`);
        if (!val) throw new Error("Draft not found");
        return Promise.resolve(val);
      }),
      updateDraft: vi.fn((userId: string, draftId: string, encrypted: string) => {
        drafts.set(`${userId}:${draftId}`, encrypted);
        return Promise.resolve();
      }),
      deleteDraft: vi.fn((userId: string, draftId: string) => {
        drafts.delete(`${userId}:${draftId}`);
        return Promise.resolve();
      }),
      reserveSubmission: vi.fn().mockResolvedValue({
        id: "tracking-sim-1",
        creditState: "none",
        replayed: false,
        balanceBefore: null,
        balanceAfter: null
      }),
      saveSimulatedReport: vi.fn(
        (input: { report: ReportDetail; metadata: SimulatedReportMetadata }) => {
          savedSimulatedReport = input.report;
          savedMetadata = input.metadata;
          return Promise.resolve();
        }
      ),
      saveStatusDmMessageId: vi.fn().mockResolvedValue(undefined),
      statusDmMessageId: vi.fn().mockResolvedValue(null),
      aiDecisions: vi.fn().mockResolvedValue([]),
      getSimulatedReport: vi.fn((reportId: string) => {
        if (savedSimulatedReport && savedSimulatedReport.internalReportId === reportId) {
          return Promise.resolve(savedSimulatedReport);
        }
        return Promise.resolve(null);
      }),
      listSimulatedReports: vi.fn(() => {
        return Promise.resolve(savedSimulatedReport ? [savedSimulatedReport] : []);
      })
    } as unknown as BotDatabase;

    const createReportApi = vi.fn();
    const api = {
      createReport: createReportApi
    } as unknown as DsaApi;

    const reportWriterGenerate = vi.fn();
    const reportWriter = {
      generate: reportWriterGenerate
    } as unknown as ReportWriter;

    const handler = new InteractionHandler({
      api,
      config,
      countries: ["DE", "FR"],
      database,
      messageResolver: {} as MessageResolver,
      profileResolver: {} as ProfileResolver,
      reportWriter,
      serverResolver: {} as ServerResolver,
      shadowbanLogger
    });

    const editReply = vi.fn().mockResolvedValue(undefined);
    const deferReply = vi.fn().mockResolvedValue(undefined);

    const dmMessage = {
      id: "dm-msg-1",
      edit: vi.fn().mockResolvedValue(undefined)
    };

    const interaction = {
      id: "interaction-quick-1",
      type: 2,
      user: {
        id: shadowbannedUserId,
        username: "ShadowbannedTest",
        send: vi.fn().mockResolvedValue(dmMessage),
        createDM: vi.fn().mockResolvedValue({
          messages: {
            fetch: vi.fn().mockResolvedValue(dmMessage)
          }
        })
      },
      commandName: "Quick Report Message",
      targetMessage: {
        id: "300",
        url: "https://discord.com/channels/100/200/300",
        content: "Prohibited content in discord",
        author: {
          id: "bad-user-1",
          username: "bad_actor",
          bot: false,
          displayAvatarURL: () => "https://cdn.discordapp.com/avatars/bad-user-1.png"
        },
        channelId: "200",
        channel: { name: "general" },
        guildId: "100",
        guild: { name: "Test Server" },
        createdAt: new Date("2026-08-25T10:00:00.000Z"),
        attachments: new Map(),
        embeds: []
      },
      isAutocomplete: () => false,
      isMessageContextMenuCommand: () => true,
      isChatInputCommand: () => false,
      isModalSubmit: () => false,
      isStringSelectMenu: () => false,
      isButton: () => false,
      isRepliable: () => true,
      deferred: false,
      replied: false,
      deferReply,
      editReply
    } as unknown as Interaction;

    await handler.handle(interaction);

    expect(reportWriterGenerate).not.toHaveBeenCalled();
    expect(createReportApi).not.toHaveBeenCalled();

    expect(savedSimulatedReport).not.toBeNull();
    const createdReport = savedSimulatedReport;
    expect(createdReport?.internalReportId).toMatch(/^sim-/);
    expect(createdReport?.reportType).toBe("sub_other_threats");
    const createdMetadata = savedMetadata;
    expect(createdMetadata?.isSimulated).toBe(true);

    expect(loggedActivities.length).toBeGreaterThan(0);
    const hasSubmissionLog = loggedActivities.some((a) =>
      a.embeds?.[0]?.title?.includes("Quick Report Submitted (Simulated)")
    );
    expect(hasSubmissionLog).toBe(true);
  });

  it("shadowbanned user views /access status and receives simulated granted access view", async () => {
    const config = createTestConfig();
    const shadowbannedUserId = "463866425031786496";
    const database = {
      getAccess: vi.fn().mockResolvedValue({
        accessGranted: false,
        suspended: true,
        suspensionReason: "Blacklisted",
        defaultCountry: null,
        aiCostCredits: 0,
        aiInputTokens: 0,
        aiOutputTokens: 0,
        aiReasoningTokens: 0,
        aiRequestCount: 0,
        aiSearchRequests: 0
      })
    } as unknown as BotDatabase;

    const reply = vi.fn().mockResolvedValue(undefined);
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
      id: "interaction-access-1",
      type: 2,
      user: { id: shadowbannedUserId, username: "ShadowbannedTwo" },
      commandName: "access",
      options: {
        getSubcommand: () => "status"
      },
      isAutocomplete: () => false,
      isMessageContextMenuCommand: () => false,
      isChatInputCommand: () => true,
      isModalSubmit: () => false,
      isStringSelectMenu: () => false,
      isButton: () => false,
      isRepliable: () => true,
      reply
    } as unknown as Interaction;

    await handler.handle(interaction);

    expect(reply).toHaveBeenCalledOnce();
    const payload: unknown = reply.mock.calls[0]?.[0];
    expect(JSON.stringify(payload)).toContain("Active");
  });

  it("NotificationWorker processes scheduled simulated reports, updates DB, enqueues notifications, and notifies webhook", async () => {
    const config = createTestConfig();
    const shadowbannedUserId = "1389142809952391272";
    const loggedActivities: WebhookPayload[] = [];
    const customFetch = vi.fn((_url: RequestInfo | URL, options?: RequestInit) => {
      if (typeof options?.body === "string") {
        loggedActivities.push(JSON.parse(options.body) as WebhookPayload);
      }
      return Promise.resolve(new Response(null, { status: 204 }));
    });
    const shadowbanLogger = new ShadowbanLogger(config.shadowbanWebhookUrl, customFetch);

    const simulatedReport: ReportDetail = {
      internalReportId: "sim-1234567890abcdef",
      country: "DE",
      flow: "message_urf",
      reportType: "sub_other_hate_speech",
      submitterDiscordUserId: shadowbannedUserId,
      pseudonym: "EU DSA Reporter",
      email: "dsa@mail.discord-dsa.eu",
      locale: "en-US",
      timezone: "Europe/Berlin",
      lifecycleAttempt: 1,
      retryable: false,
      retryOfReportId: null,
      retriedAsReportId: null,
      retrySequence: 0,
      failureStage: null,
      status: "submitted",
      discordReportId: "987654321012345678",
      discordStatus: "received",
      discordStatusUpdatedAt: "2026-08-25T09:00:00.000Z",
      reviewStatus: null,
      reviewStatusUpdatedAt: null,
      reviewError: null,
      appealRetryable: false,
      resubmittable: false,
      error: null,
      reportedDetails: {
        kind: "message",
        messageUrl: "https://discord.com/channels/1/2/3"
      },
      timeline: [
        {
          eventId: "1",
          type: "report_submitted",
          occurredAt: "2026-08-25T09:00:00.000Z",
          lifecycleAttempt: 1,
          discordStatus: null,
          errorCode: null
        }
      ],
      createdAt: "2026-08-25T09:00:00.000Z",
      updatedAt: "2026-08-25T09:00:00.000Z"
    };

    const simulatedMetadata: SimulatedReportMetadata = {
      isSimulated: true,
      originalUserId: shadowbannedUserId,
      stage: "initial",
      scheduledEvent: "discord:closed_no_action",
      scheduledAt: new Date(Date.now() - 1000).toISOString(),
      outcomeDecidedAt: "2026-08-25T09:00:00.000Z"
    };

    const enqueuedNotifications: EnqueuedNotificationItem[] = [];
    let updatedReportInDb: ReportDetail | undefined;

    const claimDueSimulatedTrackings = vi.fn().mockResolvedValue([
      {
        id: "tracking-sim-1",
        discord_user_id: shadowbannedUserId,
        simulated_report: simulatedReport,
        simulation_metadata: simulatedMetadata
      }
    ]);

    const database = {
      claimDueTrackings: vi.fn().mockResolvedValue([]),
      claimDueSimulatedTrackings,
      updateSimulatedReport: vi.fn((input: { report: ReportDetail }) => {
        updatedReportInDb = input.report;
        return Promise.resolve();
      }),
      enqueueNotification: vi.fn((notif: EnqueuedNotificationItem) => {
        enqueuedNotifications.push(notif);
        return Promise.resolve();
      }),
      claimNotifications: vi.fn().mockResolvedValue([]),
      reconciliationCursor: vi.fn().mockResolvedValue(null),
      setReconciliationCursor: vi.fn().mockResolvedValue(undefined)
    } as unknown as BotDatabase;

    const client = {
      users: {
        fetch: vi.fn()
      }
    } as unknown as Client;

    const worker = new NotificationWorker(
      database,
      {} as DsaApi,
      client,
      config,
      {} as ServerResolver,
      shadowbanLogger
    );

    await worker.tick();

    expect(claimDueSimulatedTrackings).toHaveBeenCalled();
    expect(updatedReportInDb).not.toBeNull();
    const updated = updatedReportInDb;
    expect(updated?.discordStatus).toBe("closed_no_action");
    expect(updated?.appealRetryable).toBe(true);
    expect(enqueuedNotifications.length).toBe(1);
    expect(enqueuedNotifications[0]?.payload.eventType).toBe("discord:closed_no_action");

    const hasDispatchedLog = loggedActivities.some((a) =>
      a.embeds?.[0]?.title?.includes("Simulated Lifecycle Response Dispatched")
    );
    expect(hasDispatchedLog).toBe(true);
  });

  it("shadowbanned user retries a simulated report safely", async () => {
    const config = createTestConfig();
    const shadowbannedUserId = "1389142809952391272";
    const loggedActivities: WebhookPayload[] = [];
    const customFetch = vi.fn((_url: RequestInfo | URL, options?: RequestInit) => {
      if (typeof options?.body === "string") {
        loggedActivities.push(JSON.parse(options.body) as WebhookPayload);
      }
      return Promise.resolve(new Response(null, { status: 204 }));
    });
    const shadowbanLogger = new ShadowbanLogger(config.shadowbanWebhookUrl, customFetch);

    const simulatedReport: ReportDetail = {
      internalReportId: "sim-resub-123456",
      country: "FR",
      flow: "message_urf",
      reportType: "sub_harassment_defamation",
      submitterDiscordUserId: shadowbannedUserId,
      pseudonym: "EU Reporter",
      email: "eu@mail.discord-dsa.eu",
      locale: "en-US",
      timezone: "Europe/Paris",
      lifecycleAttempt: 1,
      retryable: true,
      retryOfReportId: null,
      retriedAsReportId: null,
      retrySequence: 0,
      failureStage: null,
      status: "failed",
      discordReportId: "1234567890",
      discordStatus: null,
      discordStatusUpdatedAt: null,
      reviewStatus: null,
      reviewStatusUpdatedAt: null,
      reviewError: null,
      appealRetryable: false,
      resubmittable: false,
      error: null,
      reportedDetails: {
        kind: "message",
        messageUrl: "https://discord.com/channels/1/2/3",
        reportReason: "Severe harassment",
        context: "Harassment context notes"
      },
      timeline: [],
      createdAt: "2026-08-25T09:00:00.000Z",
      updatedAt: "2026-08-25T09:00:00.000Z"
    };

    let savedRetryReport: ReportDetail | undefined;

    const database = {
      getAccess: vi.fn().mockResolvedValue({
        accessGranted: false,
        suspended: true,
        suspensionReason: "Blacklisted",
        defaultCountry: "FR",
        aiCostCredits: 0,
        aiInputTokens: 0,
        aiOutputTokens: 0,
        aiReasoningTokens: 0,
        aiRequestCount: 0,
        aiSearchRequests: 0
      }),
      getSimulatedReport: vi.fn().mockResolvedValue(simulatedReport),
      trackSimulatedRetryReport: vi.fn((input: { report: ReportDetail }) => {
        savedRetryReport = input.report;
        return Promise.resolve("tracking-retry-1");
      }),
      statusDmMessageId: vi.fn().mockResolvedValue(null),
      aiDecisions: vi.fn().mockResolvedValue([])
    } as unknown as BotDatabase;

    const handler = new InteractionHandler({
      api: {} as DsaApi,
      config,
      countries: ["DE", "FR"],
      database,
      messageResolver: {} as MessageResolver,
      profileResolver: {} as ProfileResolver,
      reportWriter: {} as ReportWriter,
      serverResolver: {} as ServerResolver,
      shadowbanLogger
    });

    const editReply = vi.fn().mockResolvedValue(undefined);
    const deferUpdate = vi.fn().mockResolvedValue(undefined);

    const interaction = {
      id: "interaction-retry-1",
      customId: "reports:retry:sim-resub-123456",
      user: { id: shadowbannedUserId, username: "Shadowbanned" },
      message: { id: "msg-1" },
      isAutocomplete: () => false,
      isMessageContextMenuCommand: () => false,
      isChatInputCommand: () => false,
      isModalSubmit: () => false,
      isStringSelectMenu: () => false,
      isButton: () => true,
      isRepliable: () => true,
      deferUpdate,
      editReply
    } as unknown as Interaction;

    await handler.handle(interaction);

    expect(savedRetryReport).not.toBeNull();
    expect(savedRetryReport?.retryOfReportId).toBe("sim-resub-123456");
    expect(loggedActivities.some((a) => a.embeds?.[0]?.title?.includes("Report Retried (Simulated)"))).toBe(true);
  });
});
