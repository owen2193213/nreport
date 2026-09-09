import { describe, expect, it } from "vitest";

import {
  createReportBodySchema,
  GUILD_REPORT_REASONS,
  REPORT_FLOWS,
  REPORT_RETRY_MODES,
  REPORT_STATUSES,
  retryReportBodySchema,
  USER_MESSAGE_REPORT_REASONS
} from "../src/index.js";

describe("report contracts", () => {
  it("keeps report reason catalogs within Discord select limits", () => {
    expect(USER_MESSAGE_REPORT_REASONS.length).toBeGreaterThan(0);
    expect(GUILD_REPORT_REASONS.length).toBeGreaterThan(0);
    expect(GUILD_REPORT_REASONS.length).toBeLessThanOrEqual(25);
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

  it("publishes distinct appeal-denial replacement modes", () => {
    expect(REPORT_RETRY_MODES).toEqual(["reuse", "regenerate", "rewrite_ai", "edit_manual"]);
    expect(retryReportBodySchema).toMatchObject({
      oneOf: [
        { properties: { mode: { enum: ["reuse", "regenerate", "rewrite_ai"] } } },
        {
          required: ["mode", "country", "category", "finalText"],
          properties: { mode: { const: "edit_manual" } }
        }
      ]
    });
  });
});
