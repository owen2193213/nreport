import { simpleParser } from "mailparser";

export async function extractVerificationCode(rawEmail: Buffer): Promise<string | undefined> {
  const parsed = await simpleParser(rawEmail, {
    skipHtmlToText: false,
    skipTextToHtml: true
  });
  const html = typeof parsed.html === "string" ? parsed.html.replace(/<[^>]+>/g, " ") : "";
  const content = [parsed.subject ?? "", parsed.text ?? "", html].join("\n");
  const matches =
    content.match(/\b(?=[A-Z0-9]{6}\b)(?=[A-Z0-9]*\d)[A-Z0-9]{6}\b/g) ?? [];
  const unique = [...new Set(matches)];
  return unique.length === 1 ? unique[0] : undefined;
}
