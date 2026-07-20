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

export const PROFILE_ELEMENTS = ["photos", "name", "descriptors"] as const;
export type UserProfileElement = (typeof PROFILE_ELEMENTS)[number];

export interface ReportedUserSnapshot {
  userId: string;
  username: string;
  globalDisplayName: string | null;
  serverDisplayName?: string;
  avatarUrl: string | null;
  bot: boolean;
  resolvedAt: string;
}

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
  reportType: string;
  submitterDiscordUserId: string;
  context?: string;
  reporterUsername?: string;
}

export interface MessageCreateReportInput extends BaseCreateReportInput {
  flow: "message_urf";
  messageUrl: string;
}

export interface UserCreateReportInput extends BaseCreateReportInput {
  flow: "user_urf";
  reportedUsername: string;
  reportedUserId?: string;
  reportedUserSnapshot?: ReportedUserSnapshot;
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
  error: { code: string; message: string | null } | null;
  createdAt: string;
  updatedAt: string;
}

export type ReportedDetails =
  | {
      kind: "message";
      messageUrl: string;
      context?: string;
    }
  | {
      kind: "profile";
      reportedUsername: string;
      reportedUserId?: string;
      reportedUserSnapshot?: ReportedUserSnapshot;
      reportedUserServerId?: string;
      profileElements: UserProfileElement[];
      context?: string;
    }
  | {
      kind: "server";
      guildIdOrInviteCode: string;
      guildElements: GuildElement[];
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
