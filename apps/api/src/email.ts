import { simpleParser } from "mailparser";
import type { ParsedMail } from "mailparser";

import type { DiscordReportStatus } from "@nreport/contracts";

export type { DiscordReportStatus } from "@nreport/contracts";

export type ParsedDiscordEmail =
  | { kind: "verification"; code: string }
  | {
      kind: "report_update";
      reportId: string;
      status: DiscordReportStatus;
      reviewUrl?: string;
    }
  | { kind: "review_update"; reportId: string; status: "received" };

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

function trustedReportReviewUrl(value: string): string | undefined {
  try {
    const url = new URL(value.replace(/[),.;]+$/, ""));
    const trustedDirect =
      url.protocol === "https:" &&
      url.hostname === "discord.com" &&
      url.pathname === "/report-review";
    const trustedTracker =
      url.protocol === "https:" &&
      url.hostname === "click.discord.com" &&
      url.pathname === "/ls/click";
    return trustedDirect || trustedTracker ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function normalizedHtmlText(value: string): string {
  return value
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#0*160;|&#x0*a0;/gi, " ")
    .replace(/&amp;|&#0*38;|&#x0*26;/gi, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function reportReviewUrlFromHtml(html: string): string | undefined {
  const anchors = html.matchAll(
    /<a\b[^>]*\bhref\s*=\s*(?:"([^"]+)"|'([^']+)')[^>]*>([\s\S]*?)<\/a>/gi
  );
  for (const anchor of anchors) {
    if (normalizedHtmlText(anchor[3] ?? "").toLowerCase() !== "here") continue;
    const context = normalizedHtmlText(
      html.slice(Math.max(0, (anchor.index ?? 0) - 600), anchor.index)
    );
    if (!/request we review this decision by clicking$/i.test(context)) continue;
    const href = (anchor[1] ?? anchor[2] ?? "").replace(
      /&amp;|&#0*38;|&#x0*26;/gi,
      "&"
    );
    const trusted = trustedReportReviewUrl(href);
    if (trusted !== undefined) return trusted;
  }
  return undefined;
}

function reportReviewUrl(parsed: ParsedMail): string | undefined {
  if (typeof parsed.html === "string") {
    const htmlUrl = reportReviewUrlFromHtml(parsed.html);
    if (htmlUrl !== undefined) return htmlUrl;
  }
  const candidate =
    /request we review this decision by clicking here:\s*(https:\/\/[^\s<>"']+)/i.exec(
      parsed.text ?? ""
    )?.[1];
  return candidate === undefined ? undefined : trustedReportReviewUrl(candidate);
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

  const reviewConfirmation =
    /^Report Review Request Received #(\d{15,22})$/i.exec(parsed.subject?.trim() ?? "");
  if (reviewConfirmation?.[1]) {
    return {
      kind: "parsed",
      email: {
        kind: "review_update",
        reportId: reviewConfirmation[1],
        status: "received"
      }
    };
  }

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
    const reviewUrl = status === "closed_no_action" ? reportReviewUrl(parsed) : undefined;
    return {
      kind: "parsed",
      email: {
        kind: "report_update",
        reportId,
        status,
        ...(reviewUrl === undefined ? {} : { reviewUrl })
      }
    };
  }

  const code = verificationCode(parsed) ?? trustedSubjectEndingCode(parsed);
  return code === undefined
    ? { kind: "ignored", diagnostic: ignoredDiagnostic(parsed) }
    : { kind: "parsed", email: { kind: "verification", code } };
}
