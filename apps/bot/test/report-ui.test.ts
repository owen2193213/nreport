import { MessageFlags } from "discord.js";
import { describe, expect, it } from "vitest";

import { buildReportModal, classifyReportView, decisionMessageOptions, parseReportModalValues, shouldSendDecisionDm, statusMessageOptions, visibleStatusHash, type TargetDisplayContext } from "../src/report-ui.js";
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

  it("distinguishes an appeal waiting to submit from one already submitted", () => {
    expect(classifyReportView(report({ discordStatus: "closed_no_action", reviewStatus: "queued" }))).toMatchObject({
      title: "Preparing appeal",
      mark: "Not submitted yet"
    });
    expect(classifyReportView(report({ discordStatus: "closed_no_action", reviewStatus: "requested" }))).toMatchObject({
      title: "Appeal submitted",
      mark: "Awaiting Discord's decision"
    });
  });

  it("shows explicit queue and Discord submission phases", () => {
    expect(classifyReportView(report({ status: "queued", discordStatus: null })).title).toBe("Queued for Discord submission");
    expect(classifyReportView(report({ status: "requesting_verification", discordStatus: null })).title).toBe("Requesting verification from Discord");
    expect(classifyReportView(report({ status: "awaiting_verification", discordStatus: null })).title).toBe("Waiting for Discord verification email");
    expect(classifyReportView(report({ status: "submitting", discordStatus: null })).title).toBe("Submitting report to Discord");
  });

  it("keeps the mention, username, plain link, and code-blocked message in one reported-item block", () => {
    const value = JSON.stringify(statusMessageOptions(report({ status: "queued", discordStatus: null, queueLength: 7 }), {
      flow: "message",
      name: "Example Display",
      handle: "@username",
      kind: "User account",
      excerpt: "Example reported message content",
      metadata: [["Location", "#general"], ["Attachments", "3"], ["User ID", "123456789012345678"], ["Message", "https://discord.com/channels/@me/123456789012345678/123456789012345679"]]
    }));
    expect(value).toContain("<@123456789012345678> (@username)\\nhttps://discord.com/channels/@me/123456789012345678/123456789012345679\\n```\\nExample reported message content\\n```");
    expect(value).toContain("Queue length: **7**");
    expect(value).toContain("- <t:1788775200:R> Added to submission queue");
    expect(value).not.toContain("Open reported message");
    expect(value).not.toContain("Discord ID:");
    expect(value).not.toContain("> Example reported message content");
    expect(value).not.toContain("User account");
    expect(value).not.toContain("Location");
    expect(value).not.toContain("Attachments");
  });

  it("collapses a denied report and submitted appeal into one chronological history action", () => {
    const timeline = [
      { eventId: "1", type: "report_queued", occurredAt: "2026-09-07T10:00:00.000Z", lifecycleAttempt: 1, discordStatus: null, errorCode: null },
      { eventId: "2", type: "report_submitted", occurredAt: "2026-09-07T10:01:00.000Z", lifecycleAttempt: 1, discordStatus: null, errorCode: null },
      { eventId: "3", type: "discord:closed_no_action", occurredAt: "2026-09-07T10:02:00.000Z", lifecycleAttempt: 1, discordStatus: "closed_no_action" as const, errorCode: null },
      { eventId: "4", type: "review_requested", occurredAt: "2026-09-07T10:03:00.000Z", lifecycleAttempt: 1, discordStatus: null, errorCode: null },
      { eventId: "5", type: "discord:actioned", occurredAt: "2026-09-07T10:04:00.000Z", lifecycleAttempt: 1, discordStatus: "actioned" as const, errorCode: null }
    ];
    const value = JSON.stringify(statusMessageOptions(report({ discordStatus: "actioned", reviewStatus: "approved", timeline }), context));
    expect(value).toContain("- <t:1788775200:R> Added to submission queue\\n- <t:1788775260:R> Report submitted\\n- <t:1788775380:R> Report denied; appeal submitted\\n- <t:1788775440:R> Appeal accepted");
    expect(value).not.toContain("<t:1788775320:R> Report denied");
  });

  it("shows the safe specific failure on both the card and its reply", () => {
    const failed = report({ status: "failed", discordStatus: null, failure: { stage: "researching", code: "preparation_rate_limited", message: "The AI writing provider is rate limited after 3 attempts." } });
    expect(JSON.stringify(statusMessageOptions(failed, context))).toContain("The AI writing provider is rate limited after 3 attempts.");
    expect(JSON.stringify(decisionMessageOptions(failed, context))).toContain("The AI writing provider is rate limited after 3 attempts.");
  });

  it("adds valid retry controls to failed reports", () => {
    const failed = report({ status: "failed", discordStatus: null, retryableModes: ["reuse", "regenerate"], failure: { stage: "researching", code: "preparation_rate_limited", message: "Rate limited." } });
    const value = JSON.stringify(statusMessageOptions(failed, context));
    expect(value).toContain("Retry submission");
    expect(value).toContain("Retry with fresh report");
  });

  it("keeps submitted reports neutral until Discord accepts them", () => {
    const card = statusMessageOptions(report({ status: "submitted", discordStatus: "received" }), context);
    expect(JSON.stringify(card)).toContain('"accent_color":5793266');
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
