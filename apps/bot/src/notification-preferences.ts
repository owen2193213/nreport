export const DIGEST_FREQUENCIES = ["off", "daily", "weekly", "monthly"] as const;
export type DigestFrequency = (typeof DIGEST_FREQUENCIES)[number];

export type NotificationPreferenceKey =
  | "submission_results"
  | "actioned"
  | "declined"
  | "appeal_progress";

export interface NotificationPreferences {
  submissionResults: boolean;
  actioned: boolean;
  declined: boolean;
  appealProgress: boolean;
  digestFrequency: DigestFrequency;
}

export function notificationCategory(eventType: string): NotificationPreferenceKey | null {
  if (["report_submitted", "report_failed", "discord:received"].includes(eventType)) {
    return "submission_results";
  }
  if (eventType === "discord:actioned") return "actioned";
  if (["discord:closed_no_action", "discord:review_not_approved"].includes(eventType)) {
    return "declined";
  }
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
    case "declined": return preferences.declined;
    case "appeal_progress": return preferences.appealProgress;
    case null: return false;
  }
}
