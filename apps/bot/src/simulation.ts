import { randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import {
  reportReasonLabel,
  type ActionHistoryItem,
  type ActionHistoryPage,
  type AnalyticsPeriod,
  type AnalyticsScope,
  type CreateReportInput,
  type DiscordReportStatus,
  type DiscordReviewStatus,
  type ReportAnalytics,
  type ReportDetail,
  type ReportedDetails,
  type ReportTimelineEvent
} from "@discord-dsa/contracts";

import type { BotConfig } from "./config.js";
import {
  capturedMessageSnapshot,
  type AccessView,
  type ReportDraft,
  type SimulatedLifecycleEvent,
  type SimulatedReportMetadata
} from "./types.js";
import type { WriterProgress, WriterResult } from "./report-writer.js";

const CROCKFORD = "0123456789abcdefghjkmnpqrstvwxyz";

interface CountryNameProfile {
  firstNames: readonly string[];
  lastNames: readonly string[];
  locale: string;
  timezone: string;
}

const COUNTRY_NAME_PROFILES: Readonly<Record<string, CountryNameProfile>> = {
  DE: {
    firstNames: ["Lukas", "Maximilian", "Felix", "Leon", "Jonas", "Hannah", "Mia", "Emma", "Sophia", "Anna", "Timo"],
    lastNames: ["Muller", "Schmidt", "Schneider", "Fischer", "Weber", "Meyer", "Wagner", "Becker", "Hoffmann", "Schulz", "Schmitt"],
    locale: "de-DE",
    timezone: "Europe/Berlin"
  },
  FR: {
    firstNames: ["Lucas", "Gabriel", "Leo", "Louis", "Arthur", "Emma", "Jade", "Louise", "Alice", "Chloe", "Hugo"],
    lastNames: ["Martin", "Bernard", "Thomas", "Petit", "Robert", "Richard", "Durand", "Dubois", "Moreau", "Laurent"],
    locale: "fr-FR",
    timezone: "Europe/Paris"
  },
  ES: {
    firstNames: ["Hugo", "Mateo", "Martin", "Lucas", "Leo", "Lucia", "Sofia", "Martina", "Maria", "Paula", "Elena"],
    lastNames: ["Garcia", "Rodriguez", "Gonzalez", "Fernandez", "Lopez", "Martinez", "Sanchez", "Perez", "Gomez"],
    locale: "es-ES",
    timezone: "Europe/Madrid"
  },
  IT: {
    firstNames: ["Leonardo", "Francesco", "Alessandro", "Lorenzo", "Mattia", "Sofia", "Giulia", "Aurora", "Alice", "Ginevra"],
    lastNames: ["Rossi", "Russo", "Ferrari", "Esposito", "Bianchi", "Romano", "Colombo", "Ricci", "Marino", "Greco"],
    locale: "it-IT",
    timezone: "Europe/Rome"
  },
  NL: {
    firstNames: ["Noah", "Sem", "Liam", "Lucas", "Daan", "Emma", "Mila", "Sophie", "Julia", "Tess"],
    lastNames: ["De Jong", "Jansen", "De Vries", "Van de Berg", "Van Dijk", "Bakker", "Janssen", "Visser", "Smit"],
    locale: "nl-NL",
    timezone: "Europe/Amsterdam"
  },
  PL: {
    firstNames: ["Antoni", "Jan", "Aleksander", "Franciszek", "Nikodem", "Zofia", "Zuzanna", "Hanna", "Maja", "Laura"],
    lastNames: ["Nowak", "Kowalski", "Wisniewski", "Wojcik", "Kowalczyk", "Kaminski", "Lewandowski", "Zielinski"],
    locale: "pl-PL",
    timezone: "Europe/Warsaw"
  },
  SE: {
    firstNames: ["William", "Liam", "Noah", "Hugo", "Oliver", "Alice", "Maja", "Elsa", "Astrid", "Wilma"],
    lastNames: ["Andersson", "Johansson", "Karlsson", "Nilsson", "Eriksson", "Larsson", "Olsson", "Persson"],
    locale: "sv-SE",
    timezone: "Europe/Stockholm"
  },
  AT: {
    firstNames: ["Paul", "David", "Jakob", "Maximilian", "Felix", "Anna", "Marie", "Emma", "Sophia", "Emilia"],
    lastNames: ["Gruber", "Huber", "Bauer", "Wagner", "Muller", "Pichler", "Steiner", "Moser", "Mayer", "Hofer"],
    locale: "de-AT",
    timezone: "Europe/Vienna"
  },
  BE: {
    firstNames: ["Arthur", "Noah", "Jules", "Louis", "Lucas", "Olivia", "Emma", "Mila", "Louise", "Alice"],
    lastNames: ["Peeters", "Janssens", "Maes", "Jacobs", "Mertens", "Willems", "Claes", "Goossens", "Wouters"],
    locale: "nl-BE",
    timezone: "Europe/Brussels"
  },
  IE: {
    firstNames: ["Jack", "James", "Noah", "Daniel", "Conor", "Emily", "Grace", "Fiadh", "Sophie", "Hannah"],
    lastNames: ["Murphy", "Kelly", "O'Brien", "Ryan", "Walsh", "O'Sullivan", "O'Connor", "Doyle", "McCarthy"],
    locale: "en-IE",
    timezone: "Europe/Dublin"
  }
};

export function generateRealisticIdentity(countryCode = "DE"): {
  pseudonym: string;
  internalReportId: string;
  email: string;
  locale: string;
  timezone: string;
} {
  const code = countryCode.toUpperCase();
  const profile = COUNTRY_NAME_PROFILES[code] ?? COUNTRY_NAME_PROFILES["DE"]!;
  const first = profile.firstNames[Math.floor(Math.random() * profile.firstNames.length)]!;
  const last = profile.lastNames[Math.floor(Math.random() * profile.lastNames.length)]!;
  const pseudonym = `${first} ${last}`;
  const slug = `${first}-${last}`.toLowerCase().replace(/[^a-z0-9]+/g, "-");

  const bytes = randomBytes(10);
  let value = BigInt(`0x${bytes.toString("hex")}`);
  let suffix = "";
  for (let index = 0; index < 16; index += 1) {
    suffix = CROCKFORD[Number(value & 31n)] + suffix;
    value >>= 5n;
  }

  const internalReportId = `${slug}-${suffix}`;
  const email = `${slug.replace(/-/g, ".")}.${suffix}@mail.discord-dsa.eu`;

  return {
    pseudonym,
    internalReportId,
    email,
    locale: profile.locale,
    timezone: profile.timezone
  };
}

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
  minSeconds = 1200,
  maxSeconds = 172800
): number {
  const min = Math.max(1, Math.min(minSeconds, maxSeconds));
  const max = Math.max(min, maxSeconds);
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

export function synthesizeSimulatedReportText(
  draft: ReportDraft,
  country = "DE"
): { report: string; reportReason: string; synthesisSummary: string; lawReference: string } {
  const snapshot = capturedMessageSnapshot(draft.messageEvidence);
  const brief = draft.reportBrief?.trim();
  const rawContext = draft.context?.trim();

  const lawReferenceMap: Record<string, string> = {
    DE: "German Criminal Code (StGB) § 185, § 241 & Regulation (EU) 2022/2065 (DSA) Art. 16",
    FR: "French Penal Code Art. 222-17, Art. 222-33-2-2 & Regulation (EU) 2022/2065 (DSA) Art. 16",
    IE: "Non-Fatal Offences Against the Person Act 1997, Sec. 10 & Regulation (EU) 2022/2065 (DSA) Art. 16",
    ES: "Spanish Penal Code Art. 169, Art. 173 & Regulation (EU) 2022/2065 (DSA) Art. 16",
    IT: "Italian Penal Code Art. 595, Art. 612 & Regulation (EU) 2022/2065 (DSA) Art. 16",
    NL: "Dutch Criminal Code Art. 261, Art. 285 & Regulation (EU) 2022/2065 (DSA) Art. 16",
    PL: "Polish Penal Code Art. 190a, Art. 216 & Regulation (EU) 2022/2065 (DSA) Art. 16",
    SE: "Swedish Penal Code Ch. 4 § 7, Ch. 5 § 1 & Regulation (EU) 2022/2065 (DSA) Art. 16",
    AT: "Austrian Criminal Code (StGB) § 107, § 115 & Regulation (EU) 2022/2065 (DSA) Art. 16",
    BE: "Belgian Penal Code Art. 442bis, Art. 443 & Regulation (EU) 2022/2065 (DSA) Art. 16"
  };
  const lawReference =
    lawReferenceMap[country] ??
    "Regulation (EU) 2022/2065 (Digital Services Act), Article 16";

  if (rawContext && rawContext.length > 20) {
    const reportReason = brief || "Targeted threats or harassment in violation of DSA Art. 16.";
    return {
      report: rawContext,
      reportReason,
      synthesisSummary: `Notice synthesized under ${lawReference} regarding prohibited threats and harassment.`,
      lawReference
    };
  }

  if (draft.flow === "message_urf") {
    const author = snapshot?.authorUsername ?? draft.reportedUsername ?? "the reported user";
    const channel = snapshot?.channelName ? `#${snapshot.channelName}` : "the channel";
    const content = snapshot?.content?.trim();

    if (brief) {
      const reportReason = brief.slice(0, 400);
      const report = `Notice of illegal content pursuant to Regulation (EU) 2022/2065 (DSA) Article 16. In ${channel}, message content from @${author} constitutes directed harassment and intimidation. Context: "${brief.slice(0, 220)}". The conduct violates platform safety policies and applicable statutory standards. Expeditious moderation action is requested.`;
      return {
        report,
        reportReason,
        synthesisSummary: `DSA Art. 16 notice regarding message harassment by @${author} in ${channel}.`,
        lawReference
      };
    }

    if (content) {
      const excerpt = content.slice(0, 180);
      const reportReason = `Abusive and harassing messaging by @${author} in ${channel}: "${excerpt.slice(0, 100)}"`;
      const report = `Article 16 notice under Regulation (EU) 2022/2065 (Digital Services Act). In ${channel}, user @${author} transmitted the following prohibited message: "${excerpt}". This content constitutes targeted threats and harassment contrary to digital safety rules and platform standards. Review and removal are requested.`;
      return {
        report,
        reportReason,
        synthesisSummary: `DSA Art. 16 notice for abusive message excerpt in ${channel}.`,
        lawReference
      };
    }

    const reportReason = `Directed harassment and abusive content posted in ${channel} by @${author}.`;
    const report = `Notice submitted under Regulation (EU) 2022/2065 (Digital Services Act), Article 16. The identified message in ${channel} from @${author} exhibits targeted harassment and safety violations under applicable European standards. Prompt moderation review is requested.`;
    return {
      report,
      reportReason,
      synthesisSummary: `DSA Art. 16 notice for message harassment in ${channel}.`,
      lawReference
    };
  }

  if (draft.flow === "user_urf") {
    const username = draft.reportedUsername ?? draft.reportedUserSnapshot?.username ?? "the reported user";
    const serverNote = draft.reportedUserServerId ? ` (observed in server: ${draft.reportedUserServerId})` : "";
    const elements = (draft.profileElements as string[] | undefined)?.join(", ") || "profile elements";

    if (brief) {
      const reportReason = brief.slice(0, 400);
      const report = `Notice under Article 16 of Regulation (EU) 2022/2065 (Digital Services Act). The user account @${username}${serverNote} maintains ${elements} engaged in prohibited harassment. Context: "${brief.slice(0, 220)}". Platform moderation review and appropriate sanctions are requested.`;
      return {
        report,
        reportReason,
        synthesisSummary: `DSA Art. 16 notice for user profile harassment (@${username}).`,
        lawReference
      };
    }

    const reportReason = `User account @${username} displaying abusive ${elements} and harassment.`;
    const report = `Notice pursuant to Regulation (EU) 2022/2065 (Digital Services Act) Article 16. The user profile @${username}${serverNote} contains ${elements} promoting targeted hostility and harassment. Review and enforcement under platform safety terms are requested.`;
    return {
      report,
      reportReason,
      synthesisSummary: `DSA Art. 16 notice for user profile (@${username}).`,
      lawReference
    };
  }

  // Server flow (guild_urf)
  const serverName = draft.serverSnapshot?.name ?? draft.guildIdOrInviteCode ?? "the server";
  const elements = (draft.guildElements as string[] | undefined)?.join(", ") || "server configuration";

  if (brief) {
    const reportReason = brief.slice(0, 400);
    const report = `Notice under Article 16 of Regulation (EU) 2022/2065 (Digital Services Act). The server "${serverName}" exhibits ${elements} facilitating prohibited threats and harassment. Context: "${brief.slice(0, 220)}". Expeditious platform review and enforcement are requested.`;
    return {
      report,
      reportReason,
      synthesisSummary: `DSA Art. 16 notice for server harassment (${serverName}).`,
      lawReference
    };
  }

  const reportReason = `Server hosting and facilitating prohibited threats or harassment (${serverName}).`;
  const report = `Notice of illegal content pursuant to Regulation (EU) 2022/2065 (Digital Services Act), Article 16. The server "${serverName}" displays ${elements} in violation of platform safety terms and EU anti-harassment regulations. Platform review and action are requested.`;
  return {
    report,
    reportReason,
    synthesisSummary: `DSA Art. 16 notice for server (${serverName}).`,
    lawReference
  };
}

export async function simulateAiWriterProgress(
  draft: ReportDraft,
  onProgress?: (progress: WriterProgress) => Promise<void>,
  stepDelayMs?: number
): Promise<WriterResult> {
  const isTest = process.env.NODE_ENV === "test" || process.env.VITEST !== undefined;
  // Simulate ~45 seconds total (approx. 22s research + 23s write)
  const researchDelay = stepDelayMs ?? (isTest ? 1 : Math.floor(Math.random() * 4000) + 20000);
  const writeDelay = stepDelayMs ?? (isTest ? 1 : Math.floor(Math.random() * 4000) + 21000);

  const country = draft.country ?? "DE";
  // Always categorize as "Other: threats or harassment" (sub_other_threats)
  const reportType = "sub_other_threats";

  const { report, reportReason, synthesisSummary, lawReference } =
    synthesizeSimulatedReportText(draft, country);

  await onProgress?.({
    stage: "research",
    country: draft.countrySelection === "auto" || !draft.country ? "Auto" : country,
    reportReason: draft.reportBrief ?? "Auto",
    reportType: reportReasonLabel(draft.flow, reportType)
  });

  if (researchDelay > 0) {
    await delay(researchDelay);
  }

  await onProgress?.({
    stage: "write",
    country,
    reportReason,
    reportType: reportReasonLabel(draft.flow, reportType)
  });

  if (writeDelay > 0) {
    await delay(writeDelay);
  }

  return {
    conversation: [
      {
        role: "user",
        content: `Prepare legal report for threats or harassment under EU Digital Services Act for ${draft.flow}.`
      },
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
  const identity = generateRealisticIdentity(request.country);
  const internalReportId = customReportId ?? identity.internalReportId;
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
    pseudonym: identity.pseudonym,
    email: identity.email,
    locale: identity.locale,
    timezone: identity.timezone,
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

  // Simulated appeals for blacklisted/shadowbanned users always result in appeal denial
  const scheduledEvent: SimulatedLifecycleEvent = "discord:review_not_approved";

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

export function createSimulatedAnalytics(
  period: AnalyticsPeriod = "7d",
  scope: AnalyticsScope = "personal",
  simulatedReports: readonly ReportDetail[] = []
): ReportAnalytics {
  const total = simulatedReports.length;
  const actioned = simulatedReports.filter((r) => r.discordStatus === "actioned").length;
  const closedNoAction = simulatedReports.filter(
    (r) => r.discordStatus === "closed_no_action" || r.discordStatus === "review_not_approved"
  ).length;
  const pending = Math.max(0, total - actioned - closedNoAction);

  const now = new Date();
  const startAt = new Date(now.getTime() - 7 * 86400000).toISOString();
  const endAt = now.toISOString();

  return {
    availability: "available",
    scope,
    interval: {
      period,
      startAt,
      endAt,
      asOf: endAt,
      timezone: "UTC"
    },
    volume: {
      newCases: total,
      attempts: total,
      retries: 0,
      sentAttempts: total,
      pendingAttempts: pending,
      failedAttempts: 0
    },
    outcomes: {
      awaitingResponse: pending,
      awaitingDecision: 0,
      directActioned: actioned,
      closedNoAction,
      appealsStarted: 0,
      appealActioned: 0,
      appealsDenied: 0
    },
    rates: {
      submission: { numerator: total, denominator: total, percentage: total > 0 ? 100 : null },
      action: { numerator: actioned, denominator: total, percentage: total > 0 ? Math.round((actioned / total) * 100) : null },
      appealAction: { numerator: 0, denominator: 0, percentage: null }
    },
    timing: {
      reply: { sampleSize: actioned + closedNoAction, medianSeconds: 180, p90Seconds: 300 },
      decision: { sampleSize: actioned + closedNoAction, medianSeconds: 180, p90Seconds: 300 },
      appealDecision: { sampleSize: 0, medianSeconds: null, p90Seconds: null }
    },
    breakdowns: {
      flows: [{ key: "message_urf", label: "Message Report", count: total, percentage: 100 }],
      categories: [{ key: "sub_other_threats", label: "Other: threats or harassment", count: total, percentage: 100 }],
      countries: [{ key: "DE", label: "Germany", count: total, percentage: 100 }]
    },
    series: [
      {
        bucketStart: startAt,
        reportCount: total,
        medianReplySeconds: 180
      }
    ],
    patterns: []
  };
}

export function createSimulatedActionHistory(
  simulatedReports: readonly ReportDetail[] = []
): ActionHistoryPage {
  const now = new Date();
  const startAt = new Date(now.getTime() - 30 * 86400000).toISOString();
  const endAt = now.toISOString();

  const items: ActionHistoryItem[] = simulatedReports
    .filter((r) => r.discordStatus === "actioned")
    .map((r) => ({
      internalReportId: r.internalReportId,
      discordReportId: r.discordReportId,
      flow: r.flow,
      category: r.reportType,
      country: r.country,
      submittedText: r.reportedDetails.reportReason ?? "Threats or harassment report",
      messageUrl: r.reportedDetails.kind === "message" ? (r.reportedDetails.messageUrl ?? null) : null,
      submittedAt: r.createdAt,
      actionedAt: r.discordStatusUpdatedAt ?? r.updatedAt,
      actionSource: r.reviewStatus === "approved" ? "appeal" : "direct"
    }));

  return {
    interval: {
      period: "30d",
      startAt,
      endAt,
      asOf: endAt,
      timezone: "UTC"
    },
    items,
    nextCursor: null
  };
}
