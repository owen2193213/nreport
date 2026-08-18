import { Buffer } from "node:buffer";

import { describe, expect, it, vi } from "vitest";
import type { Interaction } from "discord.js";
import type { DsaApi } from "@discord-dsa/contracts";

import { chartValues, renderAnalyticsChart } from "../src/analytics-charts.js";
import {
  actionHistoryModal,
  actionHistoryView,
  analyticsView,
  analyticsViewWithChart
} from "../src/analytics-ui.js";
import { analyticsFixture, communityFixture } from "./analytics-fixtures.js";
import { COMMANDS } from "../src/commands.js";
import { inclusiveAnalyticsRange, InteractionHandler } from "../src/interactions.js";
import type { BotConfig } from "../src/config.js";
import type { BotDatabase } from "../src/database.js";
import type { MessageResolver } from "../src/message-resolver.js";
import type { ProfileResolver } from "../src/profile-resolver.js";
import type { ReportWriter } from "../src/report-writer.js";
import type { ServerResolver } from "../src/server-resolver.js";

function handler(api: DsaApi): InteractionHandler {
  return new InteractionHandler({
    api,
    config: { adminUserIds: new Set<string>(), whitelistEnabled: false } as unknown as BotConfig,
    countries: ["DE"],
    database: {} as BotDatabase,
    messageResolver: {} as MessageResolver,
    profileResolver: {} as ProfileResolver,
    reportWriter: {} as ReportWriter,
    serverResolver: {} as ServerResolver
  });
}

describe("analytics dashboard", () => {
  it("registers the one-hub analytics command with all approved periods", () => {
    const command = COMMANDS.find((candidate) => candidate.name === "analytics");
    expect(command?.options?.[0]).toMatchObject({ name: "period", required: false });
    expect(JSON.stringify(command)).toContain("365d");
    expect(JSON.stringify(command)).not.toContain("yearly");
  });

  it("renders a PNG without embedding report content", async () => {
    const png = await renderAnalyticsChart("volume", analyticsFixture());
    expect(png.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    expect(png.includes(Buffer.from("submitted explanation"))).toBe(false);
  });

  it("keeps missing reply-time samples as chart gaps", () => {
    const analytics = analyticsFixture({
      series: [
        { bucketStart: "2026-08-01T00:00:00.000Z", reportCount: 3, medianReplySeconds: 3_600 },
        { bucketStart: "2026-08-02T00:00:00.000Z", reportCount: 2, medianReplySeconds: null },
        { bucketStart: "2026-08-03T00:00:00.000Z", reportCount: 4, medianReplySeconds: 7_200 }
      ]
    });

    expect(chartValues("reply_time", analytics)).toEqual([1, null, 2]);
    expect(chartValues("volume", analytics)).toEqual([3, 2, 4]);
  });

  it("labels Actioned results without claiming bans", () => {
    const text = JSON.stringify(analyticsView(analyticsFixture(), "overview"));
    expect(text).toContain("Actioned");
    expect(text.toLowerCase()).not.toContain("ban");
  });

  it("keeps component state enum-only without exposing pagination cursors", () => {
    const page = {
      interval: analyticsFixture().interval,
      items: [],
      nextCursor: "next-token"
    };
    const text = JSON.stringify(actionHistoryView(page, "7d"));
    expect(text).toContain("analytics:view:history:personal:7d");
    expect(text).not.toContain("next-token");
    expect(text).not.toContain("1197857362942378017");
    expect(actionHistoryModal().toJSON()).toMatchObject({ custom_id: "analytics:history-range" });
  });

  it("withholds Community fields when the API marks them unavailable", () => {
    const payload = analyticsView(communityFixture({ availability: "insufficient_community_data" }), "overview");
    expect(JSON.stringify(payload)).toContain("Not enough anonymized Community data");
    expect(payload.embeds[0]?.toJSON().fields).toBeUndefined();
  });

  it("attaches a local chart for trend views", async () => {
    const payload = await analyticsViewWithChart(analyticsFixture(), "trends");
    expect(JSON.stringify(payload.files[0])).toContain("report-volume.png");
  });

  it("defaults the command to the requesting user's personal seven-day view", async () => {
    const analyticsFor = vi.fn().mockResolvedValue(analyticsFixture());
    const deferReply = vi.fn().mockResolvedValue(undefined);
    const editReply = vi.fn().mockResolvedValue(undefined);
    const interaction = {
      isAutocomplete: () => false,
      isMessageContextMenuCommand: () => false,
      isChatInputCommand: () => true,
      isModalSubmit: () => false,
      isStringSelectMenu: () => false,
      isButton: () => false,
      isRepliable: () => true,
      commandName: "analytics",
      options: { getString: () => null },
      user: { id: "1197857362942378017" },
      deferReply,
      editReply,
      deferred: false,
      replied: false
    } as unknown as Interaction;

    await handler({ analyticsFor } as unknown as DsaApi).handle(interaction);

    expect(analyticsFor).toHaveBeenCalledWith("1197857362942378017", "7d");
    expect(deferReply).toHaveBeenCalledWith({ flags: 64 });
    expect(editReply).toHaveBeenCalledWith(expect.objectContaining({
      allowedMentions: { parse: [] }
    }));
  });

  it("keeps Community navigation aggregate-only", async () => {
    const communityAnalytics = vi.fn().mockResolvedValue(communityFixture());
    const analyticsFor = vi.fn();
    const interaction = {
      isAutocomplete: () => false,
      isMessageContextMenuCommand: () => false,
      isChatInputCommand: () => false,
      isModalSubmit: () => false,
      isStringSelectMenu: () => false,
      isButton: () => true,
      isRepliable: () => true,
      customId: "analytics:scope:community:overview:30d",
      user: { id: "1197857362942378017" },
      deferUpdate: vi.fn().mockResolvedValue(undefined),
      editReply: vi.fn().mockResolvedValue(undefined),
      deferred: false,
      replied: false
    } as unknown as Interaction;

    await handler({ communityAnalytics, analyticsFor } as unknown as DsaApi).handle(interaction);

    expect(communityAnalytics).toHaveBeenCalledWith("30d");
    expect(analyticsFor).not.toHaveBeenCalled();
  });

  it("always scopes Action History to the interaction user", async () => {
    const actionHistory = vi.fn().mockResolvedValue({
      interval: analyticsFixture().interval,
      items: [],
      nextCursor: null
    });
    const editReply = vi.fn().mockResolvedValue(undefined);
    const interaction = {
      isAutocomplete: () => false,
      isMessageContextMenuCommand: () => false,
      isChatInputCommand: () => false,
      isModalSubmit: () => false,
      isStringSelectMenu: () => false,
      isButton: () => true,
      isRepliable: () => true,
      customId: "analytics:history:personal:7d",
      user: { id: "1197857362942378017" },
      deferUpdate: vi.fn().mockResolvedValue(undefined),
      editReply,
      deferred: false,
      replied: false
    } as unknown as Interaction;

    await handler({ actionHistory } as unknown as DsaApi).handle(interaction);

    expect(actionHistory).toHaveBeenCalledWith("1197857362942378017", {
      period: "7d",
      limit: 25
    });
    expect(editReply).toHaveBeenCalledWith(expect.objectContaining({
      allowedMentions: { parse: [] }
    }));
  });

  it("converts inclusive custom history dates to a half-open UTC interval", () => {
    expect(inclusiveAnalyticsRange("2026-08-01", "2026-08-03")).toEqual({
      startAt: "2026-08-01T00:00:00.000Z",
      endAt: "2026-08-04T00:00:00.000Z"
    });
    expect(() => inclusiveAnalyticsRange("2026-08-03", "2026-08-01")).toThrow(/valid date range/);
  });

  it("keeps a custom Action History request within its submitted UTC range", async () => {
    const actionHistory = vi.fn().mockResolvedValue({
      interval: analyticsFixture().interval,
      items: [],
      nextCursor: "unused-cursor"
    });
    const interaction = {
      isAutocomplete: () => false,
      isMessageContextMenuCommand: () => false,
      isChatInputCommand: () => false,
      isModalSubmit: () => true,
      isStringSelectMenu: () => false,
      isButton: () => false,
      isRepliable: () => true,
      customId: "analytics:history-range",
      fields: {
        getTextInputValue: (name: string) => name === "start_date" ? "2026-08-01" : "2026-08-03"
      },
      user: { id: "1197857362942378017" },
      deferReply: vi.fn().mockResolvedValue(undefined),
      editReply: vi.fn().mockResolvedValue(undefined),
      deferred: false,
      replied: false
    } as unknown as Interaction;

    await handler({ actionHistory } as unknown as DsaApi).handle(interaction);

    expect(actionHistory).toHaveBeenCalledWith("1197857362942378017", {
      startAt: "2026-08-01T00:00:00.000Z",
      endAt: "2026-08-04T00:00:00.000Z",
      limit: 25
    });
  });
});
