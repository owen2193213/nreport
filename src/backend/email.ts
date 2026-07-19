import { simpleParser } from "mailparser";

function uniqueVerificationCode(value: string): string | undefined {
  const matches =
    value.match(/\b(?=[A-Z0-9]{6}\b)(?=[A-Z0-9]*\d)[A-Z0-9]{6}\b/g) ?? [];
  const unique = [...new Set(matches)];
  return unique.length === 1 ? unique[0] : undefined;
}

export async function extractVerificationCode(rawEmail: Buffer): Promise<string | undefined> {
  const parsed = await simpleParser(rawEmail, {
    skipHtmlToText: false,
    skipTextToHtml: true
  });
  return (
    uniqueVerificationCode(parsed.subject ?? "") ??
    uniqueVerificationCode(parsed.text ?? "")
  );
}
