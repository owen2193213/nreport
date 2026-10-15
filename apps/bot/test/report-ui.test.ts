import { ComponentType, MessageFlags } from "discord.js";
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
    traceId: "33333333-3333-4333-8333-333333333333",
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

function components(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.flatMap(components);
  if (typeof value !== "object" || value === null) return [];
  const node = value as Record<string, unknown>;
  return [node, ...Object.values(node).flatMap(components)];
}

function cardNodes(value: ReportDetail): Record<string, unknown>[] {
  return components(JSON.parse(JSON.stringify(statusMessageOptions(value, context))));
}

describe("report card behavior and Discord payload contracts (not visual readability)", () => {
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
    const timeout = classifyReportView(report({ status: "failed", discordStatus: null, failure: { stage: "receipt", code: "discord_receipt_timeout", message: "Timed out" } }));
    expect(timeout.key).toBe("report_timeout");
    expect(classifyReportView(report({ reviewStatus: "confirmation_timeout" })).key).toBe("appeal_timeout");
    expect(classifyReportView(report({ reviewStatus: "ineligible" })).key).toBe("ineligible");
    expect(classifyReportView(report({ discordStatus: "closed_no_action", reviewStatus: "request_failed" })).key).toBe("appeal_failed");
    expect(classifyReportView(report({ discordStatus: "closed_no_action", reviewStatus: "request_ambiguous" })).key).toBe("appeal_failed");
  });

  it("distinguishes an appeal waiting to submit from one already submitted", () => {
    const queued = classifyReportView(report({ discordStatus: "closed_no_action", reviewStatus: "queued" }));
    const submitted = classifyReportView(report({ discordStatus: "closed_no_action", reviewStatus: "requested" }));

    expect(queued.key).toBe("report_denied");
    expect(submitted.key).toBe("report_denied");
    expect(queued.title).not.toBe(submitted.title);
    expect(queued.mark).not.toBe(submitted.mark);
    expect(queued.terminal).toBe(false);
    expect(submitted.terminal).toBe(false);
  });

  it("classifies queue, verification, and submission phases and refreshes visible state", () => {
    const queued = report({ status: "queued", discordStatus: null });
    const requesting = report({ status: "requesting_verification", discordStatus: null });
    const awaitingEmail = report({ status: "awaiting_verification", discordStatus: null });
    expect(classifyReportView(queued).key).toBe("preparing");
    expect(classifyReportView(requesting).key).toBe("submitting");
    expect(classifyReportView(awaitingEmail).key).toBe("submitting");
    const emailReceived = classifyReportView(report({ status: "verification_received", discordStatus: null }));
    expect(emailReceived.key).toBe("verification_received");
    expect(emailReceived.terminal).toBe(false);
    const verifying = classifyReportView(report({ status: "verifying", discordStatus: null }));
    expect(verifying.key).toBe("verifying");
    expect(verifying.terminal).toBe(false);
    const submitting = classifyReportView(report({ status: "submitting", discordStatus: null }));
    expect(submitting.key).toBe("submitting");
    expect(submitting.terminal).toBe(false);
    expect(visibleStatusHash(report({ status: "verification_received", discordStatus: null }), context))
      .not.toBe(visibleStatusHash(report({ status: "awaiting_verification", discordStatus: null }), context));
    expect(visibleStatusHash(requesting, context)).not.toBe(visibleStatusHash(awaitingEmail, context));
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
    expect(value).toContain("Report ID: `11111111-1111-4111-8111-111111111111`");
    expect(value).toContain("<t:1788775200:R>");
    expect(value).not.toContain("Discord ID:");
    expect(value).not.toContain("> Example reported message content");
    expect(value).not.toContain("User account");
    expect(value).not.toContain("Location");
    expect(value).not.toContain("Attachments");
  });

  it("shows the generated reporter email alias on the private report card", () => {
    const withAlias = { ...report(), reporterEmail: "ernestine.deckow.z1k2mkvwz9b69rhc@doomed.org" } as ReportDetail;

    const serialized = JSON.stringify(statusMessageOptions(withAlias, context));
    expect(serialized).toContain("ernestine.deckow.z1k2mkvwz9b69rhc");
    expect(serialized).not.toContain("@doomed.org");
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
    const expectedTimes = [1788775200, 1788775260, 1788775380, 1788775440].map((time) => `<t:${time}:R>`);
    const positions = expectedTimes.map((time) => value.indexOf(time));

    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((left, right) => left - right));
    expect(value).not.toContain("<t:1788775320:R>");
  });

  it("keeps verification receipt in history when the report snapshot has already advanced", () => {
    const timeline = [
      { eventId: "1", type: "verification_received", occurredAt: "2026-09-07T10:00:30.000Z", lifecycleAttempt: 1, discordStatus: null, errorCode: null }
    ];
    const current = report({ status: "submitting", discordStatus: null, timeline: [] });
    const advanced = report({
      status: "submitting", discordStatus: null, timeline
    });
    const value = JSON.stringify(statusMessageOptions(advanced, context));

    expect(classifyReportView(advanced).key).toBe("submitting");
    expect(value).toContain("<t:1788775230:R>");
    expect(visibleStatusHash(advanced, context)).not.toBe(visibleStatusHash(current, context));
  });

  it("uses report_submitted as an awaiting-confirmation milestone even if the status snapshot lags", () => {
    const timeline = [
      { eventId: "1", type: "report_submitted", occurredAt: "2026-09-07T10:01:15.000Z", lifecycleAttempt: 1, discordStatus: null, errorCode: null }
    ];
    const submitted = report({
      status: "submitting", discordStatus: null, timeline
    });
    const view = classifyReportView(submitted);
    const value = JSON.stringify(statusMessageOptions(submitted, context));

    expect(view.key).toBe("awaiting_confirmation");
    expect(value).toContain("<t:1788775275:R>");
  });

  it("shows and records Discord receipt confirmation separately from report submission", () => {
    const submitted = report({
      status: "submitted", discordStatus: null,
      timeline: [{ eventId: "1", type: "report_submitted", occurredAt: "2026-09-07T10:01:00.000Z", lifecycleAttempt: 1, discordStatus: null, errorCode: null }]
    });
    const received = report({
      status: "submitted", discordStatus: null,
      timeline: [
        { eventId: "1", type: "report_submitted", occurredAt: "2026-09-07T10:01:00.000Z", lifecycleAttempt: 1, discordStatus: null, errorCode: null },
        { eventId: "2", type: "discord:received", occurredAt: "2026-09-07T10:02:00.000Z", lifecycleAttempt: 1, discordStatus: "received", errorCode: null }
      ]
    });
    const submittedView = classifyReportView(submitted);
    const receivedView = classifyReportView(received);
    const value = JSON.stringify(statusMessageOptions(received, context));

    expect(submittedView.key).toBe("awaiting_confirmation");
    expect(receivedView.key).toBe("confirmation_received");
    expect(value).toContain("<t:1788775260:R>");
    expect(value).toContain("<t:1788775320:R>");
    expect(visibleStatusHash(received, context)).not.toBe(visibleStatusHash(submitted, context));
  });

  it("labels the report text as prepared until a durable submission confirmation exists", () => {
    const pending = JSON.stringify(statusMessageOptions(report({
      status: "submitting", discordStatus: null, timeline: []
    }), context));
    const confirmedByEvent = JSON.stringify(statusMessageOptions(report({
      status: "submitting", discordStatus: null,
      timeline: [{ eventId: "1", type: "report_submitted", occurredAt: "2026-09-07T10:01:15.000Z", lifecycleAttempt: 1, discordStatus: null, errorCode: null }]
    }), context));

    expect(pending).toContain("### Prepared report");
    expect(pending).not.toContain("### Report sent to Discord");
    expect(confirmedByEvent).toContain("### Report sent to Discord");
  });

  it("shows the safe specific failure on both the card and its reply", () => {
    const failed = report({ status: "failed", discordStatus: null, failure: { stage: "researching", code: "preparation_rate_limited", message: "The AI writing provider is rate limited after 3 attempts." } });
    expect(JSON.stringify(statusMessageOptions(failed, context))).toContain("The AI writing provider is rate limited after 3 attempts.");
    expect(JSON.stringify(decisionMessageOptions(failed, context))).toContain("The AI writing provider is rate limited after 3 attempts.");
  });

  it.each([[], ["reuse"], ["regenerate"], ["reuse", "regenerate"]] as const)("binds only API-authorized retry modes %j to this report", (...modes) => {
    const failed = report({ status: "failed", discordStatus: null, retryableModes: [...modes], failure: { stage: "researching", code: "preparation_rate_limited", message: "Rate limited." } });
    const ids = cardNodes(failed).filter((node) => node.type === ComponentType.Button).map((node) => node.custom_id);
    expect(ids).toEqual(modes.map((mode) => `report-retry-${mode}:${failed.reportId}`));
    expect(cardNodes({ ...failed, successorReportId: "replacement" }).filter((node) => node.type === ComponentType.Button)).toEqual([]);
  });

  it("keeps submitted reports neutral until Discord accepts them", () => {
    const color = (value: ReportDetail) => cardNodes(value).find((node) => node.type === ComponentType.Container)?.accent_color;
    const submitted = color(report({ status: "submitted", discordStatus: "received" }));
    const accepted = color(report({ discordStatus: "actioned" }));
    expect(typeof submitted).toBe("number");
    expect(typeof accepted).toBe("number");
    expect(submitted).not.toBe(accepted);
  });

  it("changes the visible payload hash when the preparation stage changes", () => {
    const preparing = report({ status: "researching", discordStatus: null, finalText: null, category: null, country: null });
    const writing = report({ status: "writing", discordStatus: null, finalText: null, category: null, country: null });
    expect(visibleStatusHash(preparing, context)).not.toBe(visibleStatusHash(writing, context));
  });

  it("invalidates the visible hash when queue length or failure details change", () => {
    const queued = report({ status: "queued", discordStatus: null, queueLength: 7 });
    expect(visibleStatusHash(queued, context)).not.toBe(visibleStatusHash({ ...queued, queueLength: 2 }, context));
    const failed = report({ status: "failed", discordStatus: null, failure: { stage: "writing", code: "preparation_failed", message: "Initial reason" } });
    expect(visibleStatusHash(failed, context)).not.toBe(visibleStatusHash({ ...failed, failure: { ...failed.failure!, message: "Corrected reason" } }, context));
  });

  it("shows recovery only for a fresh appeal denial", () => {
    const denied = cardNodes(report({ discordStatus: "review_not_approved", reviewStatus: "not_approved", retryableModes: ["rewrite_ai", "edit_manual"] }))
      .filter((node) => node.type === ComponentType.Button).map((node) => node.custom_id);
    const ineligible = cardNodes(report({ discordStatus: "closed_no_action", reviewStatus: "ineligible", retryableModes: [] }))
      .filter((node) => node.type === ComponentType.Button).map((node) => node.custom_id);
    expect(denied).toContain("report-rewrite:11111111-1111-4111-8111-111111111111");
    expect(denied).toContain("report-edit:11111111-1111-4111-8111-111111111111");
    expect(ineligible).toEqual([]);
  });

  it("keeps report fields optional in AI mode", () => {
    const modal = buildReportModal("report:pending", "profile", "@username").toJSON();
    const country = components(modal).find((node) => node.custom_id === "country");
    const category = components(modal).find((node) => node.custom_id === "category");
    const writerMode = components(modal).find((node) => node.custom_id === "writer-mode");

    expect(country).toMatchObject({ required: false, max_length: 2 });
    expect(category).toMatchObject({ required: false, min_values: 0 });
    expect(writerMode).toMatchObject({ required: true });
  });

  it("omits Auto values in AI mode and enforces manual fields after submission", () => {
    expect(parseReportModalValues("message", { mode: "ai", country: "", categories: [], details: "" }, ["DE"])).toEqual({ useAi: true });
    expect(parseReportModalValues("profile", { mode: "ai", country: "de", categories: [], details: "Guidance", profileElements: ["name"] }, ["DE"])).toEqual({
      useAi: true, country: "DE", description: "Guidance", profileElements: ["name"]
    });
    expect(() => parseReportModalValues("message", { mode: "manual", country: "", categories: [], details: "Text" }, ["DE"]))
      .toThrow();
    expect(() => parseReportModalValues("message", { mode: "ai", country: "ZZ", categories: [], details: "" }, ["DE"]))
      .toThrow();
  });

  it("keeps report-denied notifications independent from appeal-denied decisions", () => {
    const defaults = { decisionEnabled: true, reportDeniedEnabled: false, problemEnabled: true };
    expect(shouldSendDecisionDm("discord:closed_no_action", "report_denied", defaults)).toBe(false);
    expect(shouldSendDecisionDm("discord:review_not_approved", "appeal_denied", defaults)).toBe(true);
    expect(shouldSendDecisionDm("discord:actioned", "report_accepted", defaults)).toBe(true);
    expect(shouldSendDecisionDm("report_receipt_timeout", "report_timeout", defaults)).toBe(true);
    expect(shouldSendDecisionDm("review_request_failed", "appeal_failed", defaults)).toBe(true);
    expect(shouldSendDecisionDm("review_request_ambiguous", "appeal_failed", defaults)).toBe(true);
    expect(shouldSendDecisionDm("report_writing", "preparing", defaults)).toBe(false);
  });
});
