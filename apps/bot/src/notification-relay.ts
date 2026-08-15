import type { ReportDetail } from "@discord-dsa/contracts";
import { WebhookClient, type EmbedBuilder } from "discord.js";

import { botLog, errorFields } from "./observability.js";

export function parseWebhookCredentials(url: string): { id: string; token: string } | null {
  const match = url.match(
    /^https:\/\/(?:(?:canary|ptb)\.)?discord(?:app)?\.com\/api(?:\/v\d+)?\/webhooks\/(\d{15,22})\/([A-Za-z0-9_-]+)/
  );
  if (!match || !match[1] || !match[2]) return null;
  return { id: match[1], token: match[2] };
}

export function isReportedMessageAuthor(
  report: ReportDetail,
  targetAuthorId: string
): boolean {
  if (report.reportedDetails.kind !== "message") {
    return false;
  }
  const evidence = report.reportedDetails.messageEvidence;
  if (!evidence || evidence.status !== "captured") {
    return false;
  }
  return evidence.snapshot.authorId === targetAuthorId;
}

export async function relayNotificationToWebhook(
  webhookUrl: string,
  embed: EmbedBuilder,
  decision: EmbedBuilder | null,
  replyText: string | null
): Promise<void> {
  const credentials = parseWebhookCredentials(webhookUrl);
  if (!credentials) {
    botLog("notification_relay_failed", { reason: "invalid_webhook_url" }, "warn");
    return;
  }

  const webhookClient = new WebhookClient({ id: credentials.id, token: credentials.token });
  try {
    const embeds = [embed];
    if (decision !== null) {
      embeds.push(decision);
    }
    await webhookClient.send({
      ...(replyText !== null ? { content: replyText } : {}),
      embeds,
      allowedMentions: { parse: [] }
    });
    botLog("notification_relay_completed", {
      hasDecision: decision !== null,
      hasReplyText: replyText !== null
    });
  } catch (error) {
    botLog("notification_relay_failed", errorFields(error), "warn");
  } finally {
    webhookClient.destroy();
  }
}
