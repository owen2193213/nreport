import { describe, expect, it } from "vitest";

import {
  createReportBodySchema,
  GUILD_REPORT_REASONS,
  REPORT_FLOWS,
  REPORT_STATUSES,
  USER_MESSAGE_REPORT_REASONS
} from "../src/index.js";

describe("report contracts", () => {
  it("keeps report reason catalogs within Discord select limits", () => {
    expect(USER_MESSAGE_REPORT_REASONS).toHaveLength(18);
    expect(GUILD_REPORT_REASONS).toHaveLength(5);
    expect(USER_MESSAGE_REPORT_REASONS.length).toBeLessThanOrEqual(25);
  });

  it("publishes the automatic lifecycle and public flow vocabulary", () => {
    expect(REPORT_FLOWS).toEqual(["message", "profile", "server"]);
    expect(REPORT_STATUSES.slice(0, 4)).toEqual([
      "queued",
      "planning",
      "researching",
      "writing"
    ]);
    expect(createReportBodySchema.required).toEqual(["flow", "useAi", "target"]);
  });
});
