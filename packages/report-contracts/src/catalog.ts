import type { GuildElement, ReportFlow, UserProfileElement } from "./types.js";

export interface ReportReason {
  label: string;
  value: string;
}

export const USER_MESSAGE_REPORT_REASONS: readonly ReportReason[] = [
  { label: "Sexualizing a minor", value: "sub_general_scrm_icwm" },
  { label: "Sexual contact involving a minor", value: "sub_icwm" },
  { label: "Minor posting or accessing adult sexual content", value: "sub_icaam" },
  { label: "Child sexual abuse material", value: "sub_csam" },
  { label: "Threat of physical harm", value: "threatening_behavior" },
  { label: "Glorifying violence", value: "sub_glorifying_violence" },
  {
    label: "Hate based on identity or vulnerability",
    value: "sub_racist_or_discriminatory_language_or_imagery"
  },
  { label: "Underage user", value: "sub_coppa" },
  { label: "Encouraging self-harm", value: "sub_self_harm_encouragement" },
  { label: "Stolen accounts or credit cards", value: "sub_cracked_accounts" },
  { label: "Drugs or illegal goods", value: "sub_illicit_goods" },
  { label: "Non-consensual intimate content", value: "sub_ncp" },
  { label: "Unwanted adult sexual content", value: "sub_unsolicited_porn" },
  { label: "Other: child safety", value: "sub_other_child_safety" },
  { label: "Other: threats or harassment", value: "sub_other_threats" },
  { label: "Other: cybercrime", value: "sub_other_cybercrime" },
  { label: "Other: hate speech", value: "sub_other_hate_speech" },
  {
    label: "Other: unwanted sexual content",
    value: "sub_other_unwanted_sexual_content"
  }
] as const;

export const GUILD_REPORT_REASONS: readonly ReportReason[] = [
  { label: "Child safety", value: "sub_other_child_safety" },
  { label: "Threats or harassment", value: "sub_other_threats" },
  { label: "Cybercrime", value: "sub_other_cybercrime" },
  { label: "Hate speech", value: "sub_other_hate_speech" },
  { label: "Unwanted sexual content", value: "sub_other_unwanted_sexual_content" }
] as const;

export const PROFILE_ELEMENT_LABELS: Record<UserProfileElement, string> = {
  photos: "Photos",
  name: "Name",
  descriptors: "Descriptors"
};

export const GUILD_ELEMENT_LABELS: Record<GuildElement, string> = {
  name: "Server name",
  icon: "Icon",
  banner: "Banner",
  invite_splash: "Invite splash",
  discovery_splash: "Discovery splash",
  welcome_screen_description: "Welcome screen description",
  channel_names: "Channel names",
  other: "Other"
};

export function reportReasons(flow: ReportFlow): readonly ReportReason[] {
  return flow === "guild_urf" ? GUILD_REPORT_REASONS : USER_MESSAGE_REPORT_REASONS;
}

export function reportReasonLabel(flow: ReportFlow, value: string): string {
  return reportReasons(flow).find((reason) => reason.value === value)?.label ?? value;
}
