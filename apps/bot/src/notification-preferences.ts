export const DIGEST_FREQUENCIES = ["off", "daily", "weekly", "monthly"] as const;
export type DigestFrequency = (typeof DIGEST_FREQUENCIES)[number];

export type NotificationPreferenceKey =
  | "submission_results"
  | "actioned"
  | "denied_reports"
  | "denied_appeals"
  | "appeal_progress";

export interface NotificationPreferences {
  submissionResults: boolean;
  actioned: boolean;
  deniedReports: boolean;
  deniedAppeals: boolean;
  appealProgress: boolean;
  digestFrequency: DigestFrequency;
}

export function notificationCategory(eventType: string): NotificationPreferenceKey | null {
  if (["report_submitted", "report_failed", "discord:received"].includes(eventType)) {
    return "submission_results";
  }
  if (eventType === "discord:actioned") return "actioned";
  if (eventType === "discord:closed_no_action") return "denied_reports";
  if (eventType === "discord:review_not_approved") return "denied_appeals";
  if ([
    "review_requested", "review_received", "review_confirmation_timeout",
    "review_request_failed", "review_ineligible", "review_request_ambiguous"
  ].includes(eventType)) return "appeal_progress";
  return null;
}

export function allowsLifecycleNotification(
  eventType: string,
  preferences: NotificationPreferences
): boolean {
  switch (notificationCategory(eventType)) {
    case "submission_results": return preferences.submissionResults;
    case "actioned": return preferences.actioned;
    case "denied_reports": return preferences.deniedReports;
    case "denied_appeals": return preferences.deniedAppeals;
    case "appeal_progress": return preferences.appealProgress;
    case null: return false;
  }
}
