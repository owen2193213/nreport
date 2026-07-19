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

function uniqueVerificationCode(value: string): string | undefined {
  const matches =
    value.match(/\b(?=[A-Z0-9]{6}\b)(?=[A-Z0-9]*\d)[A-Z0-9]{6}\b/g) ?? [];
  const unique = [...new Set(matches)];
  return unique.length === 1 ? unique[0] : undefined;
}

function verificationCode(parsed: ParsedMail): string | undefined {
  return (
    uniqueVerificationCode(parsed.subject ?? "") ??
    uniqueVerificationCode(parsed.text ?? "")
  );
}

function isDiscordSender(parsed: ParsedMail): boolean {
  return (
    parsed.from?.value.some(
      (address) => address.address?.trim().toLowerCase() === "noreply@discord.com"
    ) ?? false
  );
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
  const parsed = await simpleParser(rawEmail, {
    skipHtmlToText: false,
    skipTextToHtml: true
  });
  if (!isDiscordSender(parsed)) return undefined;

  const lifecycle = /^(Report Received|Report Actioned|Report Closed) #(\d{15,22})$/i.exec(
    parsed.subject?.trim() ?? ""
  );
  if (lifecycle) {
    const label = lifecycle[1]?.toLowerCase();
    const reportId = lifecycle[2];
    if (!reportId) return undefined;
    let status: DiscordReportStatus;
    if (label === "report received") status = "received";
    else if (label === "report actioned") status = "actioned";
    else if (/report review request for report/i.test(parsed.text ?? "")) {
      status = "review_not_approved";
    } else status = "closed_no_action";
    return { kind: "report_update", reportId, status };
  }

  const code = verificationCode(parsed);
  return code === undefined ? undefined : { kind: "verification", code };
}
