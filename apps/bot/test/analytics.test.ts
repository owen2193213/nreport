import { Buffer } from "node:buffer";

import { describe, expect, it } from "vitest";

import { renderAnalyticsChart } from "../src/analytics-charts.js";
import {
  actionHistoryModal,
  analyticsComponents,
  analyticsView,
  analyticsViewWithChart
} from "../src/analytics-ui.js";
import { analyticsFixture, communityFixture } from "./analytics-fixtures.js";

describe("analytics dashboard", () => {
  it("renders a PNG without embedding report content", async () => {
    const png = await renderAnalyticsChart("volume", analyticsFixture());
    expect(png.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    expect(png.includes(Buffer.from("submitted explanation"))).toBe(false);
  });

  it("labels Actioned results without claiming bans", () => {
    const text = JSON.stringify(analyticsView(analyticsFixture(), "overview"));
    expect(text).toContain("Actioned");
    expect(text.toLowerCase()).not.toContain("ban");
  });

  it("keeps component state enum-only and provides the custom date modal", () => {
    const text = JSON.stringify(analyticsComponents("history", "personal", "7d", "next-token"));
    expect(text).toContain("analytics:history:personal:7d");
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
});
