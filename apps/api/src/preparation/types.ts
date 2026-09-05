import type {
  GuildElement,
  MessageEvidence,
  ReportedMessageSnapshot,
  ReportedUserSnapshot,
  UserProfileElement
} from "@nreport/contracts";

export interface AiUsage {
  costCredits: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  searchRequests: number;
}

export interface LegalSource { title: string; url: string }
export interface LegalResearch {
  country: string;
  lawReference?: string;
  summary: string;
  sources: LegalSource[];
  researchedAt: string;
  searchRequests: number;
}
export interface WriterConversationMessage { role: "user" | "assistant"; content: string }

export interface ServerSnapshot {
  id: string;
  name: string;
  description: string | null;
  iconUrl: string | null;
  bannerUrl?: string | null;
  inviteSplashUrl?: string | null;
  discoverySplashUrl?: string | null;
  approximateMemberCount: number | null;
  approximatePresenceCount: number | null;
  resolvedAt: string;
}

export interface ReportDraft {
  country?: string;
  countrySelection?: "auto" | "default" | "override";
  context?: string;
  legalResearch?: LegalResearch;
  reportBrief?: string;
  reportReason?: string;
  writerConversation?: WriterConversationMessage[];
  flow: "message_urf" | "user_urf" | "guild_urf";
  guildElements?: GuildElement[];
  guildIdOrInviteCode?: string;
  messageUrl?: string;
  messageEvidence?: MessageEvidence;
  profileElements?: UserProfileElement[];
  reportedUsername?: string;
  reportedUserId?: string;
  reportedUserSnapshot?: ReportedUserSnapshot;
  profileTargetRaw?: string;
  reportedUserServerId?: string;
  reportType?: string;
  rewriteRequest?: {
    previousReportReason?: string;
    previousContext?: string;
    instruction: string;
  };
  serverSnapshot?: ServerSnapshot;
}

export function capturedMessageSnapshot(evidence: MessageEvidence | undefined): ReportedMessageSnapshot | undefined {
  return evidence?.status === "captured" ? evidence.snapshot : undefined;
}
