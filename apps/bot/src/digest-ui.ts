import type { DigestActivity, ReportAnalytics } from "@discord-dsa/contracts";
import { AttachmentBuilder, Colors, EmbedBuilder, type MessageCreateOptions } from "discord.js";

import { renderAnalyticsChart } from "./analytics-charts.js";
import type { DigestFrequency } from "./notification-preferences.js";

function percentage(value: number | null): string {
  return value === null ? "Not enough data" : `${value}%`;
}

function duration(value: number | null): string {
  if (value === null) return "Not enough data";
  if (value < 3_600) return `${Math.round(value / 60)} min`;
  if (value < 86_400) return `${Math.round(value / 360) / 10} hr`;
  return `${Math.round(value / 8_640) / 10} days`;
}

export async function digestMessage(input: {
  frequency: Exclude<DigestFrequency, "off">;
  activity: DigestActivity;
  personal: ReportAnalytics;
  community: ReportAnalytics | null;
}): Promise<MessageCreateOptions> {
  const periodName = input.frequency === "daily" ? "day" : input.frequency === "weekly" ? "week" : "month";
  const embed = new EmbedBuilder().setColor(Colors.Blurple)
    .setTitle(`Your ${periodName} in reports`)
    .setDescription(
      `${input.activity.interval.startAt?.slice(0, 10)} → ${input.activity.interval.endAt.slice(0, 10)} UTC`
    )
    .addFields(
      {
        name: "Your activity",
        value: `New reports: **${input.activity.newReports}**\nOutcome changes: **${input.activity.outcomeChanges.total}**\nActioned: **${input.activity.outcomeChanges.actioned + input.activity.outcomeChanges.appealActioned}**\nAppeal then Actioned: **${input.activity.outcomeChanges.appealActioned}**`
      },
      {
        name: "Your results",
        value: `Pending: **${input.personal.outcomes.awaitingResponse + input.personal.outcomes.awaitingDecision}**\nAction rate: **${percentage(input.personal.rates.action.percentage)}**\nMedian Discord reply: **${duration(input.personal.timing.reply.medianSeconds)}**`
      }
    )
    .setFooter({ text: "Use /analytics anytime for the full private dashboard." });
  if (input.community?.availability === "available") {
    const flows = input.community.breakdowns.flows.slice(0, 3)
      .map((item) => `${item.label} ${item.percentage}%`).join(" · ") || "Not enough category data";
    embed.addFields({
      name: "Community snapshot",
      value: `${flows}\nAction rate: **${percentage(input.community.rates.action.percentage)}**\nAppeal action rate: **${percentage(input.community.rates.appealAction.percentage)}**`
    });
  }

  const files: AttachmentBuilder[] = [];
  try {
    const [volume, reply] = await Promise.all([
      renderAnalyticsChart("volume", input.personal),
      renderAnalyticsChart("reply_time", input.personal)
    ]);
    files.push(
      new AttachmentBuilder(volume, { name: "report-volume.png" }),
      new AttachmentBuilder(reply, { name: "discord-reply-time.png" })
    );
    embed.setImage("attachment://report-volume.png");
  } catch {
    embed.setFooter({
      text: "Use /analytics anytime for the full private dashboard. Charts were unavailable; totals are shown above."
    });
  }
  return { embeds: [embed], files, allowedMentions: { parse: [] } };
}
