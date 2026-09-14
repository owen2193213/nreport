import { describe, expect, it } from "vitest";

import { inspectDiscordEmail } from "../src/email.js";

function raw(subject: string, from = "noreply@discord.com"): Buffer {
  return Buffer.from(`From: ${from}\r\nSubject: ${subject}\r\n\r\nMessage body`);
}

describe("Discord lifecycle email parsing", () => {
  it.each([
    ["Report Received #1548921252872462416", "report_update", "received"],
    ["Report Actioned #1548921252872462416", "report_update", "actioned"],
    ["Report Closed #1548921252872462416", "report_update", "closed_no_action"],
    ["Report Review Request Received #1548921252872462416", "review_update", "received"]
  ])("parses the exact lifecycle subject %s", async (subject, kind, status) => {
    await expect(inspectDiscordEmail(raw(subject))).resolves.toMatchObject({
      kind: "parsed", email: { kind, reportId: "1548921252872462416", status }
    });
  });

  it.each([
    "Re: Report Received #1548921252872462416",
    "Report received #1548921252872462416",
    "Bericht erhalten #1548921252872462416",
    "Report Received #15489212528724",
    "Report Received #123456789012345678901234"
  ])("rejects altered or unsupported lifecycle subjects: %s", async (subject) => {
    await expect(inspectDiscordEmail(raw(subject))).resolves.toMatchObject({ kind: "ignored" });
  });

  it("requires the exact parsed Discord sender", async () => {
    await expect(inspectDiscordEmail(raw("Report Received #1548921252872462416", "Noreply <noreply@evil.discord.com>")))
      .resolves.toMatchObject({ kind: "ignored", diagnostic: { classification: "non_discord_sender" } });
    await expect(inspectDiscordEmail(raw("Report Received #1548921252872462416", "noreply@discord.com, attacker@example.com")))
      .resolves.toMatchObject({ kind: "ignored", diagnostic: { classification: "non_discord_sender" } });
  });
});
