import { MessageFlags } from "discord.js";
import { describe, expect, it } from "vitest";

import { buildReportModal, classifyReportView, parseReportModalValues, shouldSendDecisionDm, statusMessageOptions, visibleStatusHash, type TargetDisplayContext } from "../src/report-ui.js";
import type { ReportDetail } from "@nreport/contracts";

const context: TargetDisplayContext = {
  flow: "message",
  name: "Example User",
  handle: "@username",
  imageUrl: "https://cdn.discordapp.com/avatars/123/avatar.png",
  kind: "User account",
  excerpt: "Example reported message content",
  metadata: [
    ["Location", "#general · Example Community"],
    ["User ID", "123456789012345678"]
  ]
};

function report(overrides: Partial<ReportDetail> = {}): ReportDetail {
  return {
    reportId: "11111111-1111-4111-8111-111111111111",
    accountId: "22222222-2222-4222-8222-222222222222",
    flow: "message",
    useAi: true,
    status: "submitted",
    creditState: "consumed",
    lifecycleAttempt: 1,
    country: "DE",
    category: "sub_other_threats",
    description: "Evidence",
    discordReportId: "discord-report",
    discordStatus: "received",
    reviewStatus: null,
    predecessorReportId: null,
    successorReportId: null,
    retryableModes: [],
    createdAt: "2026-09-07T10:00:00.000Z",
    updatedAt: "2026-09-07T10:01:00.000Z",
    target: { messageUrl: "https://discord.com/channels/@me/123456789012345678/123456789012345679" },
    finalText: "Only this AI-written report belongs in the code block.",
    legalReference: null,
    researchSummary: null,
    sources: [],
    failure: null,
    timeline: [],
    ...overrides
  };
}

describe("Components V2 report UI", () => {
  it("keeps target context separate from the final report code block", () => {
    const options = statusMessageOptions(report(), context);
    const json = JSON.parse(JSON.stringify(options)) as Record<string, unknown>;
    const serialized = JSON.stringify(json);

    expect(json.flags).toBe(MessageFlags.IsComponentsV2);
    expect(json).not.toHaveProperty("content");
    expect(json).not.toHaveProperty("embeds");
    expect(serialized).toContain("@username");
    expect(serialized).toContain("Example reported message content");
    expect(serialized).toContain("```\\nOnly this AI-written report belongs in the code block.\\n```");
    expect(serialized).not.toContain("123456789012345678\\nOnly this AI-written report");
  });

  it("groups rapid internal states and distinguishes every Discord decision", () => {
    expect(classifyReportView(report({ status: "researching", discordStatus: null })).key).toBe("preparing");
    expect(classifyReportView(report({ status: "awaiting_verification", discordStatus: null })).key).toBe("submitting");
    expect(classifyReportView(report({ discordStatus: "closed_no_action", reviewStatus: "requested" })).key).toBe("report_denied");
    expect(classifyReportView(report({ discordStatus: "review_not_approved", reviewStatus: "not_approved", retryableModes: ["rewrite_ai", "edit_manual"] })).key).toBe("appeal_denied");
    expect(classifyReportView(report({ discordStatus: "actioned", reviewStatus: null })).key).toBe("report_accepted");
    expect(classifyReportView(report({ discordStatus: "actioned", reviewStatus: "approved" })).key).toBe("appeal_accepted");
    expect(classifyReportView(report({ status: "failed", discordStatus: null, failure: { stage: "receipt", code: "discord_receipt_timeout", message: "Timed out" } })).key).toBe("report_timeout");
    expect(classifyReportView(report({ reviewStatus: "confirmation_timeout" })).key).toBe("appeal_timeout");
    expect(classifyReportView(report({ reviewStatus: "ineligible" })).key).toBe("ineligible");
  });

  it("gives rapid internal preparation states the same visible payload hash", () => {
    const preparing = report({ status: "researching", discordStatus: null, finalText: null, category: null, country: null });
    const writing = report({ status: "writing", discordStatus: null, finalText: null, category: null, country: null });
    expect(visibleStatusHash(preparing, context)).toBe(visibleStatusHash(writing, context));
  });

  it("shows recovery only for a fresh appeal denial", () => {
    const denied = JSON.stringify(statusMessageOptions(report({ discordStatus: "review_not_approved", reviewStatus: "not_approved", retryableModes: ["rewrite_ai", "edit_manual"] }), context));
    const ineligible = JSON.stringify(statusMessageOptions(report({ discordStatus: "closed_no_action", reviewStatus: "ineligible", retryableModes: [] }), context));
    expect(denied).toContain("Rewrite with AI");
    expect(denied).toContain("Edit manually");
    expect(denied).not.toContain("Resend as is");
    expect(ineligible).not.toContain("Rewrite with AI");
    expect(ineligible).not.toContain("Edit manually");
  });

  it("uses current modal components and leaves AI Auto fields optional", () => {
    const modal = buildReportModal("report:pending", "profile", "@username").toJSON();
    const serialized = JSON.stringify(modal);
    expect(serialized).toContain("How should this report be written?");
    expect(serialized).toContain("Use AI");
    expect(serialized).toContain("Why are you reporting this?");
    expect(serialized).toContain("Which profile elements are unlawful?");
    expect(serialized).toContain('"type":18');
    expect(serialized).toContain('"type":21');
    expect(serialized).toContain('"type":3');
    expect(serialized).not.toContain('"custom_id":"country","min_length"');
  });

  it("omits Auto values in AI mode and enforces manual fields after submission", () => {
    expect(parseReportModalValues("message", { mode: "ai", country: "", categories: [], details: "" }, ["DE"])).toEqual({ useAi: true });
    expect(parseReportModalValues("profile", { mode: "ai", country: "de", categories: [], details: "Guidance", profileElements: ["name"] }, ["DE"])).toEqual({
      useAi: true, country: "DE", description: "Guidance", profileElements: ["name"]
    });
    expect(() => parseReportModalValues("message", { mode: "manual", country: "", categories: [], details: "Text" }, ["DE"]))
      .toThrow("Country, category, and final report text are required in manual mode.");
    expect(() => parseReportModalValues("message", { mode: "ai", country: "ZZ", categories: [], details: "" }, ["DE"]))
      .toThrow("Choose a supported country code.");
  });

  it("keeps report-denied notifications independent from appeal-denied decisions", () => {
    const defaults = { decisionEnabled: true, reportDeniedEnabled: false, problemEnabled: true };
    expect(shouldSendDecisionDm("discord:closed_no_action", "report_denied", defaults)).toBe(false);
    expect(shouldSendDecisionDm("discord:review_not_approved", "appeal_denied", defaults)).toBe(true);
    expect(shouldSendDecisionDm("discord:actioned", "report_accepted", defaults)).toBe(true);
    expect(shouldSendDecisionDm("report_receipt_timeout", "report_timeout", defaults)).toBe(true);
    expect(shouldSendDecisionDm("report_writing", "preparing", defaults)).toBe(false);
  });
});
