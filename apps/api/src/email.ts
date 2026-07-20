import { simpleParser } from "mailparser";
import type { ParsedMail } from "mailparser";

export type DiscordReportStatus =
  | "received"
  | "actioned"
  | "closed_no_action"
  | "review_not_approved";

export type ParsedDiscordEmail =
  | { kind: "verification"; code: string }
  | { kind: "report_update"; reportId: string; status: DiscordReportStatus };

export type IgnoredEmailClassification =
  | "non_discord_sender"
  | "discord_verification_subject_unmatched"
  | "discord_lifecycle_subject_unmatched"
  | "discord_unrecognized_subject";

export interface IgnoredEmailDiagnostic {
  classification: IgnoredEmailClassification;
  senderAddresses: string[];
  subject: string;
  textPreview: string;
}

export type DiscordEmailInspection =
  | { kind: "parsed"; email: ParsedDiscordEmail }
  | { kind: "ignored"; diagnostic: IgnoredEmailDiagnostic };

const VERIFICATION_SUBJECT =
  /^(?:Your (?:one-time verification key|verification code) is|Dein einmaliger Verifizierungsschl(?:üssel|Ã¼ssel) lautet)\s+([A-Z0-9]{6})\.?$/i;
const VERIFICATION_BODY =
  /\b(?:Your (?:one-time verification key|verification key|verification code) is|Dein einmaliger Verifizierungsschl(?:üssel|Ã¼ssel) lautet|Verifizierungscode (?:lautet|ist))\s+([A-Z0-9]{6})\b/i;

function capturedCode(value: string | undefined, pattern: RegExp): string | undefined {
  const code = pattern.exec(value?.trim() ?? "")?.[1];
  return code?.toUpperCase();
}

function verificationCode(parsed: ParsedMail): string | undefined {
  return (
    capturedCode(parsed.subject, VERIFICATION_SUBJECT) ??
    capturedCode(parsed.text, VERIFICATION_BODY)
  );
}

function trustedSubjectEndingCode(parsed: ParsedMail): string | undefined {
  const code = /(?:^|\s)([A-Z0-9]{6})[.!?]?$/.exec(parsed.subject?.trim() ?? "")?.[1];
  return code !== undefined && /[A-Z]/.test(code) ? code : undefined;
}

function isDiscordSender(parsed: ParsedMail): boolean {
  return (
    parsed.from?.value.some(
      (address) => address.address?.trim().toLowerCase() === "noreply@discord.com"
    ) ?? false
  );
}

function sanitizeDiagnosticText(value: string | undefined, limit: number): string {
  return (value ?? "")
    .replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, "[redacted-email]")
    .replace(/\b(?:[A-Z]{6}|(?=[A-Za-z0-9]{6}\b)(?=[A-Za-z0-9]*\d)[A-Za-z0-9]{6})\b/g, "[redacted-code]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, limit);
}

function ignoredClassification(parsed: ParsedMail): IgnoredEmailClassification {
  if (!isDiscordSender(parsed)) return "non_discord_sender";
  const subject = parsed.subject?.trim() ?? "";
  if (/verification|verifizierung|one-time|\bcode\b|\bkey\b/i.test(subject)) {
    return "discord_verification_subject_unmatched";
  }
  if (/\breport\b/i.test(subject)) return "discord_lifecycle_subject_unmatched";
  return "discord_unrecognized_subject";
}

function ignoredDiagnostic(parsed: ParsedMail): IgnoredEmailDiagnostic {
  const senderAddresses = [
    ...new Set(
      (parsed.from?.value ?? [])
        .map((address) => address.address?.trim().toLowerCase())
        .filter((address): address is string => Boolean(address))
    )
  ];
  return {
    classification: ignoredClassification(parsed),
    senderAddresses,
    subject: sanitizeDiagnosticText(parsed.subject, 300),
    textPreview: sanitizeDiagnosticText(parsed.text, 500)
  };
}

export async function extractVerificationCode(rawEmail: Buffer): Promise<string | undefined> {
  const parsed = await simpleParser(rawEmail, {
    skipHtmlToText: false,
    skipTextToHtml: true
  });
  return verificationCode(parsed);
}

export async function parseDiscordEmail(
  rawEmail: Buffer
): Promise<ParsedDiscordEmail | undefined> {
  const inspection = await inspectDiscordEmail(rawEmail);
  return inspection.kind === "parsed" ? inspection.email : undefined;
}

export async function inspectDiscordEmail(rawEmail: Buffer): Promise<DiscordEmailInspection> {
  const parsed = await simpleParser(rawEmail, {
    skipHtmlToText: false,
    skipTextToHtml: true
  });
  if (!isDiscordSender(parsed)) return { kind: "ignored", diagnostic: ignoredDiagnostic(parsed) };

  const lifecycle = /^(Report Received|Report Actioned|Report Closed) #(\d{15,22})$/i.exec(
    parsed.subject?.trim() ?? ""
  );
  if (lifecycle) {
    const label = lifecycle[1]?.toLowerCase();
    const reportId = lifecycle[2];
    if (!reportId) return { kind: "ignored", diagnostic: ignoredDiagnostic(parsed) };
    let status: DiscordReportStatus;
    if (label === "report received") status = "received";
    else if (label === "report actioned") status = "actioned";
    else if (/report review request for report/i.test(parsed.text ?? "")) {
      status = "review_not_approved";
    } else status = "closed_no_action";
    return { kind: "parsed", email: { kind: "report_update", reportId, status } };
  }

  const code = verificationCode(parsed) ?? trustedSubjectEndingCode(parsed);
  return code === undefined
    ? { kind: "ignored", diagnostic: ignoredDiagnostic(parsed) }
    : { kind: "parsed", email: { kind: "verification", code } };
}
