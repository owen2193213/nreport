export const DSA_API_BASE_PATH = "/v1/discord/dsa" as const;
export const DSA_ADMIN_BASE_PATH = "/v1/admin/discord/dsa" as const;
export const NREPORT_DISCORD_DSA_SERVICE = {
  category: "discord",
  type: "dsa",
  version: "v1"
} as const;
export type NreportServiceDescriptor = typeof NREPORT_DISCORD_DSA_SERVICE;

export const REPORT_FLOWS = ["message", "profile", "server"] as const;
export type ReportFlow = (typeof REPORT_FLOWS)[number];

export const REPORT_STATUSES = [
  "queued", "planning", "researching", "writing", "requesting_verification",
  "awaiting_verification", "verification_received", "verifying", "submitting",
  "submitted", "failed"
] as const;
export type ReportStatus = (typeof REPORT_STATUSES)[number];
export const REPORT_RETRY_MODES = ["reuse", "regenerate"] as const;
export type ReportRetryMode = (typeof REPORT_RETRY_MODES)[number];
export const ACCOUNT_STATUSES = ["active", "suspended"] as const;
export type ApiAccountStatus = (typeof ACCOUNT_STATUSES)[number];
export const CREDIT_STATES = ["available", "reserved", "consumed", "released"] as const;
export type ReportCreditState = (typeof CREDIT_STATES)[number];

export const DISCORD_REPORT_STATUSES = ["received", "actioned", "closed_no_action", "review_not_approved"] as const;
export type DiscordReportStatus = (typeof DISCORD_REPORT_STATUSES)[number];
export const DISCORD_REVIEW_STATUSES = [
  "queued", "requested", "received", "confirmation_timeout", "request_failed",
  "ineligible", "request_ambiguous", "approved", "not_approved"
] as const;
export type DiscordReviewStatus = (typeof DISCORD_REVIEW_STATUSES)[number];
export const PROFILE_ELEMENTS = ["photos", "name", "descriptors"] as const;
export type UserProfileElement = (typeof PROFILE_ELEMENTS)[number];
export const GUILD_ELEMENTS = [
  "name", "icon", "banner", "invite_splash", "discovery_splash",
  "welcome_screen_description", "channel_names", "other"
] as const;
export type GuildElement = (typeof GUILD_ELEMENTS)[number];

export interface ReportedUserSnapshot {
  userId: string;
  username: string;
  globalDisplayName: string | null;
  avatarUrl: string | null;
  bannerUrl?: string | null;
  bot: boolean;
  resolvedAt: string;
}

export interface ReportedReferencedMessageSnapshot {
  messageId: string;
  authorId: string;
  authorUsername: string;
  authorDisplayName: string | null;
  authorBot: boolean;
  content: string;
  attachments?: Array<{ name: string; contentType: string | null; size: number; spoiler: boolean }>;
}

export interface ReportedMessageSnapshot {
  messageId: string;
  channelId: string;
  channelName: string | null;
  serverId: string | null;
  serverName: string | null;
  authorId: string;
  authorUsername: string;
  authorDisplayName: string | null;
  authorAvatarUrl: string | null;
  authorBot: boolean;
  content: string;
  createdAt: string;
  attachments: Array<{ name: string; url: string; contentType: string | null; size: number; spoiler: boolean }>;
  embeds: Array<{ title: string | null; description: string | null; url: string | null }>;
  referencedMessage?: ReportedReferencedMessageSnapshot | null;
}

export interface CapturedMessageEvidence {
  source: "context_menu" | "message_link";
  status: "captured";
  capturedAt: string;
  snapshot: ReportedMessageSnapshot;
}
export interface UnavailableMessageEvidence {
  source: "message_link";
  status: "unavailable";
  attemptedAt: string;
}
export type MessageEvidence = CapturedMessageEvidence | UnavailableMessageEvidence;

export type ReportTarget =
  | { messageUrl: string; messageEvidence?: MessageEvidence }
  | {
      reportedUsername: string;
      reportedUserId: string;
      reportedUserSnapshot: ReportedUserSnapshot;
      reportedUserServerId?: string;
      profileElements: UserProfileElement[];
    }
  | { guildIdOrInviteCode: string; guildElements: GuildElement[] };

interface BaseCreateReportInput {
  flow: ReportFlow;
  useAi: boolean;
  target: ReportTarget;
  country?: string;
  category?: string;
  description?: string;
  finalText?: string;
}
export interface AiCreateReportInput extends BaseCreateReportInput {
  useAi: true;
  finalText?: never;
}
export interface ManualCreateReportInput extends BaseCreateReportInput {
  useAi: false;
  country: string;
  category: string;
  finalText: string;
}
export type CreateReportInput = AiCreateReportInput | ManualCreateReportInput;

export interface ApiUsageTotals {
  aiRequests: number;
  inputTokens: number;
  outputTokens: number;
  searchRequests: number;
}
export interface ApiAccountView {
  accountId: string;
  username: string;
  status: ApiAccountStatus;
  availableCredits: number;
  reservedCredits: number;
  keyPrefix: string;
  usage: ApiUsageTotals;
}
export interface LegalSourceAnnotation { title: string; url: string }
export interface ReportTimelineEvent {
  eventId: string;
  type: string;
  occurredAt: string;
  lifecycleAttempt: number | null;
  discordStatus: DiscordReportStatus | null;
  errorCode: string | null;
}
export interface ReportSummary {
  reportId: string;
  accountId: string;
  flow: ReportFlow;
  useAi: boolean;
  status: ReportStatus;
  creditState: ReportCreditState;
  lifecycleAttempt: number;
  country: string | null;
  category: string | null;
  description: string | null;
  discordReportId: string | null;
  discordStatus: DiscordReportStatus | null;
  reviewStatus: DiscordReviewStatus | null;
  predecessorReportId: string | null;
  successorReportId: string | null;
  retryableModes: ReportRetryMode[];
  createdAt: string;
  updatedAt: string;
}
export type PublicReportTarget =
  | {
      messageUrl: string;
      messageEvidence?: UnavailableMessageEvidence | {
        source: CapturedMessageEvidence["source"];
        status: "captured";
        capturedAt: string;
        snapshot: Omit<ReportedMessageSnapshot, "authorAvatarUrl" | "attachments" | "embeds"> & {
          attachments: Array<Omit<ReportedMessageSnapshot["attachments"][number], "url">>;
          embeds: Array<Omit<ReportedMessageSnapshot["embeds"][number], "url">>;
        };
      };
    }
  | {
      reportedUsername: string;
      reportedUserId: string;
      reportedUserSnapshot: Omit<ReportedUserSnapshot, "avatarUrl" | "bannerUrl">;
      reportedUserServerId?: string;
      profileElements: UserProfileElement[];
    }
  | { guildIdOrInviteCode: string; guildElements: GuildElement[] };
export interface ReportDetail extends ReportSummary {
  target: PublicReportTarget;
  finalText: string | null;
  legalReference: string | null;
  researchSummary: string | null;
  sources: LegalSourceAnnotation[];
  failure: { stage: string; code: string; message: string } | null;
  timeline: ReportTimelineEvent[];
}
export interface ReportLifecycleEvent {
  eventId: string;
  accountId: string;
  reportId: string;
  type: string;
  occurredAt: string;
  lifecycleAttempt: number;
}
export interface CursorPage<T> { items: T[]; next: string | null }
export interface ApiErrorEnvelope {
  error: { code: string; message: string; requestId: string };
}
export interface AdminCreateAccountInput {
  username: string;
  initialCredits?: number;
  webhookDestinationId?: string;
}
export interface AdminAccountView {
  accountId: string;
  username: string;
  status: ApiAccountStatus;
  availableCredits: number;
  reservedCredits: number;
  webhookDestinationId: string | null;
  createdAt: string;
}
export interface AdminApiKeyView {
  keyId: string;
  prefix: string;
  createdAt: string;
  lastUsedAt: string | null;
  overlapExpiresAt: string | null;
  revokedAt: string | null;
}
export interface WebhookDestinationView {
  destinationId: string;
  name: string;
  url: string;
  status: "active" | "disabled";
  createdAt: string;
}
export interface GlobalUsageView extends ApiUsageTotals {
  accounts: number;
  availableCredits: number;
  reservedCredits: number;
}
/** @deprecated Use ReportDetail. */
export type ReportView = ReportDetail;
