export const REPORT_FLOWS = ["user_urf", "message_urf", "guild_urf"] as const;

export type ReportFlow = (typeof REPORT_FLOWS)[number];

export interface MenuButton {
  type: string;
  target: number | null;
}

export interface MenuElement {
  name: string;
  type: string;
  data: unknown;
  should_submit_data: boolean;
  skip_if_unlocalized: boolean;
  is_localized: boolean;
}

export interface MenuNode {
  id: number;
  key: string;
  header: string | null;
  subheader: string | null;
  info: string | null;
  button: MenuButton | null;
  elements: MenuElement[];
  report_type: string | null;
  children: Array<[label: string, nodeId: number]>;
  is_multi_select_required: boolean;
  is_auto_submit: boolean;
}

export interface ReportMenu {
  name: ReportFlow;
  variant: string;
  version: string;
  postback_url: string;
  root_node_id: number;
  success_node_id: number;
  fail_node_id: number;
  nodes: Record<string, MenuNode>;
}

export interface ReporterIdentity {
  country: string;
  legalName: string;
  username?: string;
}

export type UserProfileElement = "photos" | "name" | "descriptors";

export type GuildElement =
  | "name"
  | "icon"
  | "banner"
  | "invite_splash"
  | "discovery_splash"
  | "welcome_screen_description"
  | "channel_names"
  | "other";

interface BaseReportDraft {
  reporter: ReporterIdentity;
  reportType: string;
  context?: string;
}

export interface UserReportDraft extends BaseReportDraft {
  flow: "user_urf";
  reportedUsername: string;
  reportedUserServerId?: string;
  profileElements: UserProfileElement[];
}

export interface MessageReportDraft extends BaseReportDraft {
  flow: "message_urf";
  messageUrl: string;
}

export interface GuildReportDraft extends BaseReportDraft {
  flow: "guild_urf";
  guildIdOrInviteCode: string;
  guildElements: GuildElement[];
}

export type ReportDraft = UserReportDraft | MessageReportDraft | GuildReportDraft;

export interface SubmissionPayload {
  version: string;
  variant: string;
  language: string;
  breadcrumbs: number[];
  elements: Record<string, unknown>;
  email_token: string;
  name: ReportFlow;
}

export interface ReportSubmissionResult {
  report_id: string;
}

export interface EmailTokenResponse {
  token: string;
}

export interface FingerprintResponse {
  fingerprint: string;
}

export interface JsonRequest {
  method: "GET" | "POST";
  path: string;
  body?: unknown;
  headers?: Record<string, string>;
}

export interface JsonTransport {
  requestJson<T>(request: JsonRequest): Promise<T>;
  close?(): Promise<void>;
}
