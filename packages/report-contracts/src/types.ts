export const REPORT_FLOWS = ["user_urf", "message_urf", "guild_urf"] as const;
export type ReportFlow = (typeof REPORT_FLOWS)[number];

export const REPORT_STATUSES = [
  "queued",
  "requesting_verification",
  "awaiting_verification",
  "verification_received",
  "verifying",
  "submitting",
  "submitted",
  "failed"
] as const;
export type ReportStatus = (typeof REPORT_STATUSES)[number];

export const DISCORD_REPORT_STATUSES = [
  "received",
  "actioned",
  "closed_no_action",
  "review_not_approved"
] as const;
export type DiscordReportStatus = (typeof DISCORD_REPORT_STATUSES)[number];

export const DISCORD_REVIEW_STATUSES = [
  "queued",
  "requested",
  "received",
  "confirmation_timeout",
  "request_failed",
  "ineligible",
  "request_ambiguous",
  "approved",
  "not_approved"
] as const;
export type DiscordReviewStatus = (typeof DISCORD_REVIEW_STATUSES)[number];

export const PROFILE_ELEMENTS = ["photos", "name", "descriptors"] as const;
export type UserProfileElement = (typeof PROFILE_ELEMENTS)[number];

export interface ReportedUserSnapshot {
  userId: string;
  username: string;
  globalDisplayName: string | null;
  avatarUrl: string | null;
  bannerUrl?: string | null;
  bot: boolean;
  resolvedAt: string;
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
  attachments: Array<{
    name: string;
    url: string;
    contentType: string | null;
    size: number;
    spoiler: boolean;
  }>;
  embeds: Array<{
    title: string | null;
    description: string | null;
    url: string | null;
  }>;
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

export const GUILD_ELEMENTS = [
  "name",
  "icon",
  "banner",
  "invite_splash",
  "discovery_splash",
  "welcome_screen_description",
  "channel_names",
  "other"
] as const;
export type GuildElement = (typeof GUILD_ELEMENTS)[number];

interface BaseCreateReportInput {
  country: string;
  reportReason: string;
  reportType: string;
  submitterDiscordUserId: string;
  context?: string;
  reporterUsername?: string;
}

export interface MessageCreateReportInput extends BaseCreateReportInput {
  flow: "message_urf";
  messageUrl: string;
  messageEvidence?: MessageEvidence;
}

export interface UserCreateReportInput extends BaseCreateReportInput {
  flow: "user_urf";
  reportedUsername: string;
  reportedUserId: string;
  reportedUserSnapshot: ReportedUserSnapshot;
  reportedUserServerId?: string;
  profileElements: UserProfileElement[];
}

export interface GuildCreateReportInput extends BaseCreateReportInput {
  flow: "guild_urf";
  guildIdOrInviteCode: string;
  guildElements: GuildElement[];
}

export type CreateReportInput =
  | MessageCreateReportInput
  | UserCreateReportInput
  | GuildCreateReportInput;

export interface ReportSummary {
  internalReportId: string;
  country: string;
  flow: ReportFlow;
  reportType: string;
  submitterDiscordUserId: string | null;
  pseudonym: string;
  email: string;
  locale: string;
  timezone: string;
  lifecycleAttempt: number;
  retryable: boolean;
  retryOfReportId: string | null;
  retriedAsReportId: string | null;
  retrySequence: number;
  failureStage: ReportStatus | "pre_submission" | null;
  status: ReportStatus;
  discordReportId: string | null;
  discordStatus: DiscordReportStatus | null;
  discordStatusUpdatedAt: string | null;
  reviewStatus: DiscordReviewStatus | null;
  reviewStatusUpdatedAt: string | null;
  reviewError: { code: string; message: string | null } | null;
  appealRetryable: boolean;
  resubmittable: boolean;
  error: { code: string; message: string | null } | null;
  createdAt: string;
  updatedAt: string;
}

export type ReportedDetails =
  | {
      kind: "message";
      messageUrl: string;
      messageEvidence?: MessageEvidence;
      reportReason?: string;
      context?: string;
    }
  | {
      kind: "profile";
      reportedUsername: string;
      reportedUserId?: string;
      reportedUserSnapshot?: ReportedUserSnapshot;
      reportedUserServerId?: string;
      profileElements: UserProfileElement[];
      reportReason?: string;
      context?: string;
    }
  | {
      kind: "server";
      guildIdOrInviteCode: string;
      guildElements: GuildElement[];
      reportReason?: string;
      context?: string;
    };

export interface ReportTimelineEvent {
  eventId: string;
  type: string;
  occurredAt: string;
  lifecycleAttempt: number | null;
  discordStatus: DiscordReportStatus | null;
  errorCode: string | null;
}

export interface ReportDetail extends ReportSummary {
  reportedDetails: ReportedDetails;
  timeline: ReportTimelineEvent[];
}

export interface ReportLifecycleEvent {
  eventId: string;
  internalReportId: string;
  submitterDiscordUserId: string;
  type: string;
  occurredAt: string;
  lifecycleAttempt: number;
}

/** @deprecated Use ReportDetail for a single report and ReportSummary for lists. */
export type ReportView = ReportDetail;
