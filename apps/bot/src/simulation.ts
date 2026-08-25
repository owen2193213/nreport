import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import {
  reportReasonLabel,
  type CreateReportInput,
  type DiscordReportStatus,
  type DiscordReviewStatus,
  type ReportDetail,
  type ReportedDetails,
  type ReportTimelineEvent
} from "@discord-dsa/contracts";

import type { BotConfig } from "./config.js";
import type {
  AccessView,
  ReportDraft,
  SimulatedLifecycleEvent,
  SimulatedReportMetadata
} from "./types.js";
import type { WriterProgress, WriterResult } from "./report-writer.js";

export function isShadowbannedUser(
  userId: string,
  access?: Pick<AccessView, "suspended"> | null,
  config?: Pick<BotConfig, "shadowbanUserIds"> | null
): boolean {
  if (userId === "1389142809952391272" || userId === "463866425031786496") {
    return true;
  }
  if (config?.shadowbanUserIds?.has(userId)) {
    return true;
  }
  return false;
}

export function randomSimulationDelaySeconds(
  minSeconds = 60,
  maxSeconds = 300
): number {
  const min = Math.max(1, Math.min(minSeconds, maxSeconds));
  const max = Math.max(min, maxSeconds);
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

export async function simulateAiWriterProgress(
  draft: ReportDraft,
  onProgress?: (progress: WriterProgress) => Promise<void>,
  stepDelayMs?: number
): Promise<WriterResult> {
  const isTest = process.env.NODE_ENV === "test" || process.env.VITEST !== undefined;
  const researchDelay = stepDelayMs ?? (isTest ? 1 : Math.floor(Math.random() * 1500) + 2000);
  const writeDelay = stepDelayMs ?? (isTest ? 1 : Math.floor(Math.random() * 1500) + 2500);

  const country = draft.country ?? "DE";
  // Always categorize as "Other: threats or harassment" (sub_other_threats)
  const reportType = "sub_other_threats";

  await onProgress?.({
    stage: "research",
    country: draft.countrySelection === "auto" || !draft.country ? "Auto" : country,
    reportReason: draft.reportBrief ?? "Auto",
    reportType: reportReasonLabel(draft.flow, reportType)
  });

  if (researchDelay > 0) {
    await delay(researchDelay);
  }

  const reportReason =
    draft.reportBrief?.trim().slice(0, 400) ||
    "Prohibited conduct identified under Digital Services Act (Regulation EU 2022/2065) Article 16 regarding illegal threats and harassment.";

  await onProgress?.({
    stage: "write",
    country,
    reportReason,
    reportType: reportReasonLabel(draft.flow, reportType)
  });

  if (writeDelay > 0) {
    await delay(writeDelay);
  }

  const lawReference = "Regulation (EU) 2022/2065 (Digital Services Act), Article 16";
  const synthesisSummary =
    "Notice prepared under Digital Services Act Article 16 requirements for threats or harassment. Prohibited conduct identified.";

  const report =
    draft.context?.trim().slice(0, 480) ||
    (draft.reportBrief?.trim()
      ? `DSA (EU 2022/2065) Art. 16 notice — Threats / Harassment.\n\nContext: ${draft.reportBrief.trim().slice(0, 250)}\n\nBreaches platform safety rules and EU regulations against threats and harassment. Review and moderation action requested.`
      : `Digital Services Act (EU 2022/2065) Art. 16 notification.\n\nThe reported item constitutes threats or harassment violating platform terms and applicable EU laws. Prompt review and moderation action are requested.`);

  return {
    conversation: [
      { role: "user", content: "Prepare legal report for threats or harassment under EU Digital Services Act." },
      { role: "assistant", content: report }
    ],
    country,
    legalResearch: {
      country,
      lawReference,
      summary: synthesisSummary,
      sources: [
        {
          title: "EUR-Lex - Regulation (EU) 2022/2065 (Digital Services Act)",
          url: "https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX%3A32022R2065"
        }
      ],
      researchedAt: new Date().toISOString(),
      searchRequests: 2
    },
    report,
    reportReason,
    reportType
  };
}

export function createSimulatedReport(
  request: CreateReportInput,
  userId: string,
  config: Pick<BotConfig, "simulationMinDelaySeconds" | "simulationMaxDelaySeconds">,
  customReportId?: string
): { report: ReportDetail; metadata: SimulatedReportMetadata } {
  const now = new Date();
  const nowIso = now.toISOString();
  const internalReportId =
    customReportId ?? `sim-${randomUUID().replace(/-/g, "").slice(0, 16)}`;
  const discordReportId = String(
    Math.floor(100_000_000_000_000_000 + Math.random() * 900_000_000_000_000_000)
  );

  const roll = Math.random();
  const scheduledEvent: SimulatedLifecycleEvent =
    roll < 0.3 ? "discord:actioned" : "discord:closed_no_action";

  const delaySeconds = randomSimulationDelaySeconds(
    config.simulationMinDelaySeconds,
    config.simulationMaxDelaySeconds
  );
  const scheduledAt = new Date(now.getTime() + delaySeconds * 1000).toISOString();

  const reportEvent: ReportTimelineEvent = {
    eventId: "1",
    type: "report_submitted",
    lifecycleAttempt: 1,
    occurredAt: nowIso,
    discordStatus: null,
    errorCode: null
  };

  const reportedDetails: ReportedDetails =
    request.flow === "message_urf"
      ? {
          kind: "message",
          messageUrl: request.messageUrl,
          ...(request.messageEvidence ? { messageEvidence: request.messageEvidence } : {}),
          reportReason: request.reportReason,
          ...(request.context ? { context: request.context } : {})
        }
      : request.flow === "user_urf"
        ? {
            kind: "profile",
            reportedUsername: request.reportedUsername,
            reportedUserId: request.reportedUserId,
            reportedUserSnapshot: request.reportedUserSnapshot,
            ...(request.reportedUserServerId ? { reportedUserServerId: request.reportedUserServerId } : {}),
            profileElements: request.profileElements,
            reportReason: request.reportReason,
            ...(request.context ? { context: request.context } : {})
          }
        : {
            kind: "server",
            guildIdOrInviteCode: request.guildIdOrInviteCode,
            guildElements: request.guildElements,
            reportReason: request.reportReason,
            ...(request.context ? { context: request.context } : {})
          };

  const report: ReportDetail = {
    internalReportId,
    country: request.country,
    flow: request.flow,
    reportType: request.reportType,
    submitterDiscordUserId: userId,
    pseudonym: "EU DSA Reporter",
    email: `dsa-report-${randomUUID().slice(0, 8)}@mail.discord-dsa.eu`,
    locale: "en-US",
    timezone: "Europe/Berlin",
    lifecycleAttempt: 1,
    retryable: false,
    retryOfReportId: null,
    retriedAsReportId: null,
    retrySequence: 0,
    failureStage: null,
    status: "submitted",
    discordReportId,
    discordStatus: "received",
    discordStatusUpdatedAt: nowIso,
    reviewStatus: null,
    reviewStatusUpdatedAt: null,
    reviewError: null,
    appealRetryable: false,
    resubmittable: false,
    error: null,
    reportedDetails,
    timeline: [reportEvent],
    createdAt: nowIso,
    updatedAt: nowIso
  };

  const metadata: SimulatedReportMetadata = {
    isSimulated: true,
    originalUserId: userId,
    stage: "initial",
    scheduledEvent,
    scheduledAt,
    outcomeDecidedAt: nowIso
  };

  return { report, metadata };
}

export function createSimulatedAppeal(
  report: ReportDetail,
  interactionId: string,
  userId: string,
  config: Pick<BotConfig, "simulationMinDelaySeconds" | "simulationMaxDelaySeconds">
): { report: ReportDetail; metadata: SimulatedReportMetadata } {
  void interactionId;
  const now = new Date();
  const nowIso = now.toISOString();

  const roll = Math.random();
  const scheduledEvent: SimulatedLifecycleEvent =
    roll < 0.2 ? "discord:actioned" : "discord:review_not_approved";

  const delaySeconds = randomSimulationDelaySeconds(
    config.simulationMinDelaySeconds,
    config.simulationMaxDelaySeconds
  );
  const scheduledAt = new Date(now.getTime() + delaySeconds * 1000).toISOString();

  const appealEvent: ReportTimelineEvent = {
    eventId: String(report.timeline.length + 1),
    type: "review_requested",
    lifecycleAttempt: report.lifecycleAttempt + 1,
    occurredAt: nowIso,
    discordStatus: null,
    errorCode: null
  };

  const updatedReport: ReportDetail = {
    ...report,
    reviewStatus: "requested",
    reviewStatusUpdatedAt: nowIso,
    appealRetryable: false,
    timeline: [...report.timeline, appealEvent],
    updatedAt: nowIso
  };

  const metadata: SimulatedReportMetadata = {
    isSimulated: true,
    originalUserId: userId,
    stage: "appeal",
    scheduledEvent,
    scheduledAt,
    outcomeDecidedAt: nowIso
  };

  return { report: updatedReport, metadata };
}

export function advanceSimulatedReport(
  report: ReportDetail,
  metadata: SimulatedReportMetadata
): { updatedReport: ReportDetail; eventType: string } {
  const now = new Date().toISOString();
  const eventType = metadata.scheduledEvent;

  let discordStatus: DiscordReportStatus | null = report.discordStatus;
  let reviewStatus: DiscordReviewStatus | null = report.reviewStatus;
  let appealRetryable = false;
  let resubmittable = false;

  if (eventType === "discord:actioned") {
    discordStatus = "actioned";
    if (metadata.stage === "appeal") {
      reviewStatus = "approved";
    }
  } else if (eventType === "discord:closed_no_action") {
    discordStatus = "closed_no_action";
    reviewStatus = null;
    appealRetryable = true;
  } else if (eventType === "discord:review_not_approved") {
    discordStatus = "review_not_approved";
    reviewStatus = "not_approved";
    resubmittable = true;
  }

  const timelineEvent: ReportTimelineEvent = {
    eventId: String(report.timeline.length + 1),
    type: "discord_status_updated",
    lifecycleAttempt: report.lifecycleAttempt,
    occurredAt: now,
    discordStatus,
    errorCode: null
  };

  const updatedReport: ReportDetail = {
    ...report,
    discordStatus,
    discordStatusUpdatedAt: now,
    reviewStatus,
    reviewStatusUpdatedAt: now,
    appealRetryable,
    resubmittable,
    timeline: [...report.timeline, timelineEvent],
    updatedAt: now
  };

  return { updatedReport, eventType };
}
