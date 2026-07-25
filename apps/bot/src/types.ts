import type {
  CreateReportInput,
  DiscordReportStatus,
  GuildElement,
  ReportedUserSnapshot,
  ReportFlow,
  ReportStatus,
  UserProfileElement
} from "@discord-dsa/contracts";

export interface ReportDraft {
  country?: string;
  countrySelection?: CountrySelection;
  context?: string;
  legalResearch?: LegalResearch;
  reportBrief?: string;
  writerConversation?: WriterConversationMessage[];
  flow: ReportFlow;
  guildElements?: GuildElement[];
  guildIdOrInviteCode?: string;
  messageUrl?: string;
  messageSnapshot?: MessageSnapshot;
  profileElements?: UserProfileElement[];
  reportedUsername?: string;
  reportedUserId?: string;
  reportedUserSnapshot?: ReportedUserSnapshot;
  profileTargetRaw?: string;
  reportedUserServerId?: string;
  reportType?: string;
  serverSnapshot?: ServerSnapshot;
}

export type CountrySelection = "auto" | "default" | "override";

export interface LegalSource {
  title: string;
  url: string;
}

export interface LegalResearch {
  country: string;
  lawReference?: string;
  summary: string;
  sources: LegalSource[];
  researchedAt: string;
  searchRequests: number;
}

export interface AiUsage {
  costCredits: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  searchRequests: number;
}

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

export interface WriterConversationMessage {
  role: "user" | "assistant";
  content: string;
}

export interface MessageSnapshot {
  messageId: string;
  channelId: string;
  channelName: string | null;
  serverId: string | null;
  serverName: string | null;
  authorId: string;
  authorUsername: string;
  authorDisplayName: string | null;
  authorBot: boolean;
  content: string;
  createdAt: string;
  attachments: Array<{
    name: string;
    url: string;
    contentType: string | null;
  }>;
  embeds: Array<{
    title: string | null;
    description: string | null;
    url: string | null;
  }>;
}

export interface AccessView {
  aiCostCredits: number;
  aiInputTokens: number;
  aiOutputTokens: number;
  aiReasoningTokens: number;
  aiRequestCount: number;
  aiSearchRequests: number;
  credits: number;
  defaultCountry: string | null;
  suspended: boolean;
  suspensionReason: string | null;
}

export interface SubmissionTracking {
  id: string;
  discordUserId: string;
  interactionId: string;
  internalReportId: string | null;
  creditState: "none" | "reserved" | "consumed" | "released";
  request: CreateReportInput;
}

export interface PollingTracking extends SubmissionTracking {
  lastStatus: ReportStatus | null;
  lastDiscordStatus: DiscordReportStatus | null;
}

export interface NotificationPayload {
  eventId: string;
  eventType: string;
  internalReportId: string;
  occurredAt: string;
}
