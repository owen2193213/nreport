import type {
  CreateReportInput,
  DiscordReportStatus,
  GuildElement,
  ReportFlow,
  ReportStatus,
  UserProfileElement
} from "@discord-dsa/contracts";

export interface ReportDraft {
  country?: string;
  context?: string;
  flow: ReportFlow;
  guildElements?: GuildElement[];
  guildIdOrInviteCode?: string;
  messageUrl?: string;
  profileElements?: UserProfileElement[];
  reportedUsername?: string;
  reportedUserServerId?: string;
  reportType?: string;
}

export interface AccessView {
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
  country: string;
  discordReportId: string | null;
  discordStatus: DiscordReportStatus | null;
  flow: ReportFlow;
  internalReportId: string;
  lifecycleAttempt: number;
  reportType: string;
  retryable: boolean;
  status: ReportStatus;
  timestamp: string;
}
