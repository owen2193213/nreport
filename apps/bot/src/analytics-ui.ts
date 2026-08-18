import type {
  ActionHistoryPage,
  AnalyticsPeriod,
  AnalyticsScope,
  ReportAnalytics
} from "@discord-dsa/contracts";
import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  Colors,
  EmbedBuilder,
  ModalBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  TextInputBuilder,
  TextInputStyle,
  type MessageActionRowComponentBuilder
} from "discord.js";

import { renderAnalyticsChart, type AnalyticsChart } from "./analytics-charts.js";

export type AnalyticsView = "overview" | "trends" | "outcomes" | "history";

function percentage(value: number | null): string {
  return value === null ? "Not enough data" : `${value.toLocaleString("en-US")}%`;
}

function duration(seconds: number | null): string {
  if (seconds === null) return "Not enough data";
  if (seconds < 3_600) return `${Math.round(seconds / 60)} min`;
  if (seconds < 86_400) return `${Math.round(seconds / 3_600 * 10) / 10} hr`;
  return `${Math.round(seconds / 86_400 * 10) / 10} days`;
}

export function intervalLabel(analytics: ReportAnalytics): string {
  const start = analytics.interval.startAt?.slice(0, 10) ?? "All time";
  const end = analytics.interval.endAt ? analytics.interval.endAt.slice(0, 10) : new Date().toISOString().slice(0, 10);
  return `${start} → ${end} UTC`;
}

function breakdown(items: ReportAnalytics["breakdowns"]["flows"]): string {
  return items.length === 0
    ? "Not enough data"
    : items.slice(0, 8).map((item) => `${item.label}: **${item.percentage}%** (${item.count})`).join("\n");
}

function formatActivityTimeline(series: ReportAnalytics["series"], isHourly: boolean): string {
  if (!series || series.length === 0) return "No data recorded";
  const max = Math.max(1, ...series.map((s) => s.reportCount));
  const blocks = [" ", " ", "▂", "▃", "▄", "▅", "▆", "▇", "█"];
  const sparkline = series.map((s) => {
    const idx = Math.min(blocks.length - 1, Math.round((s.reportCount / max) * (blocks.length - 1)));
    return blocks[idx];
  }).join("");
  const unit = isHourly ? "hourly" : "daily";
  return `\`${sparkline}\` (${unit})`;
}

function formatTimelineHistogram(series: ReportAnalytics["series"], isHourly: boolean): string {
  if (!series || series.length === 0) return "```\nNo activity recorded in this period.\n```";
  const max = Math.max(1, ...series.map((s) => s.reportCount));
  const barLen = 10;

  if (isHourly && series.length >= 24) {
    const chunks: { label: string; count: number }[] = [];
    for (let i = 0; i < series.length; i += 4) {
      const slice = series.slice(i, i + 4);
      const startHour = slice[0]?.bucketStart.slice(11, 16) ?? "00:00";
      const totalCount = slice.reduce((sum, p) => sum + p.reportCount, 0);
      chunks.push({ label: `${startHour} UTC`, count: totalCount });
    }
    const chunkMax = Math.max(1, ...chunks.map((c) => c.count));
    const lines = chunks.map((c) => {
      const filled = Math.round((c.count / chunkMax) * barLen);
      const bar = "█".repeat(filled) + "░".repeat(barLen - filled);
      return `${c.label.padEnd(10)} [${bar}] ${String(c.count).padStart(2)}`;
    });
    return "```text\n" + lines.join("\n") + "\n```";
  }

  const lines = series.slice(-7).map((p) => {
    const label = p.bucketStart.slice(5, 10).padEnd(10);
    const filled = Math.round((p.reportCount / max) * barLen);
    const bar = "█".repeat(filled) + "░".repeat(barLen - filled);
    return `${label} [${bar}] ${String(p.reportCount).padStart(2)}`;
  });
  return "```text\n" + lines.join("\n") + "\n```";
}

export function analyticsComponents(
  view: AnalyticsView,
  scope: AnalyticsScope,
  period: AnalyticsPeriod
): ActionRowBuilder<MessageActionRowComponentBuilder>[] {
  const viewRow = new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
    ...(["overview", "trends", "outcomes", "history"] as const).map((target) =>
      new ButtonBuilder()
        .setCustomId(`analytics:view:${target}:${scope}:${period}`)
        .setLabel(target[0]?.toUpperCase() + target.slice(1))
        .setStyle(target === view ? ButtonStyle.Primary : ButtonStyle.Secondary)
    )
  );
  const periodMenu = new StringSelectMenuBuilder()
    .setCustomId(`analytics:period:${view}:${scope}:${period}`)
    .setPlaceholder("Choose a period")
    .addOptions(...([
      ["24h", "Last 24 hours"], ["7d", "Last 7 days"], ["30d", "Last 30 days"],
      ["ytd", "Year to date"], ["365d", "Last 365 days"], ["all", "All time"]
    ] as const).map(([value, label]) => {
      const option = new StringSelectMenuOptionBuilder().setValue(value).setLabel(label);
      if (value === period) option.setDefault(true);
      return option;
    }));
  const filterRow = new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(periodMenu);
  const scopeRow = new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`analytics:scope:personal:${view}:${period}`).setLabel("Personal")
      .setStyle(scope === "personal" ? ButtonStyle.Primary : ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`analytics:scope:community:${view}:${period}`).setLabel("Community")
      .setStyle(scope === "community" ? ButtonStyle.Primary : ButtonStyle.Secondary)
      .setDisabled(view === "history"),
    new ButtonBuilder().setCustomId("analytics:history-range").setLabel("Custom history dates")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`analytics:dm-chart:${view}:${scope}:${period}`).setLabel("Send Chart to DM")
      .setStyle(ButtonStyle.Secondary).setEmoji("📊")
  );
  return [viewRow, filterRow, scopeRow];
}

export function analyticsView(
  analytics: ReportAnalytics,
  view: Exclude<AnalyticsView, "history">
): { embeds: EmbedBuilder[]; files: AttachmentBuilder[]; components: ActionRowBuilder<MessageActionRowComponentBuilder>[] } {
  const title = analytics.scope === "personal" ? "Your report analytics" : "Community analytics";
  if (analytics.availability === "insufficient_community_data") {
    return {
      embeds: [new EmbedBuilder().setColor(Colors.Blurple).setTitle(title)
        .setDescription("Not enough anonymized Community data is available for this period.")],
      files: [],
      components: analyticsComponents(view, analytics.scope, analytics.interval.period === "custom" ? "7d" : analytics.interval.period)
    };
  }
  const embed = new EmbedBuilder().setColor(Colors.Blurple).setTitle(title)
    .setDescription(intervalLabel(analytics));
  if (view === "overview") {
    const successfulSubmissions = analytics.volume.sentAttempts;
    const pendingReports = analytics.outcomes.awaitingResponse + analytics.outcomes.awaitingDecision;
    const acceptedReports = analytics.outcomes.directActioned + analytics.outcomes.appealActioned;
    const appealsPending = Math.max(
      0,
      analytics.outcomes.appealsStarted - (analytics.outcomes.appealActioned + analytics.outcomes.appealsDenied)
    );
    const deniedReports = analytics.outcomes.closedNoAction + analytics.outcomes.appealsDenied;
    const isHourly = analytics.interval.period === "24h" ||
      (analytics.series.length > 1 &&
        Date.parse(analytics.series[1]!.bucketStart) - Date.parse(analytics.series[0]!.bucketStart) <= 3_600_000);

    embed.addFields(
      {
        name: "Report Statuses",
        value: [
          `• Submissions: **${successfulSubmissions}** (successful)`,
          `• Pending: **${pendingReports}**`,
          `• Accepted (Actioned): **${acceptedReports}**`,
          `• Appealed (pending): **${appealsPending}**`,
          `• Denied: **${deniedReports}**`
        ].join("\n")
      },
      {
        name: "Performance & Rates",
        value: [
          `• Submission success: **${percentage(analytics.rates.submission.percentage)}**`,
          `• Action rate: **${percentage(analytics.rates.action.percentage)}**`,
          `• Appeal success rate: **${percentage(analytics.rates.appealAction.percentage)}**`,
          `• Timeline: ${formatActivityTimeline(analytics.series, isHourly)}`
        ].join("\n")
      },
      {
        name: "Response Time",
        value: [
          `• Median reply: **${duration(analytics.timing.reply.medianSeconds)}**`,
          `• Median decision: **${duration(analytics.timing.decision.medianSeconds)}**`,
          `• 90th percentile reply: **${duration(analytics.timing.reply.p90Seconds)}**`
        ].join("\n")
      },
      {
        name: "Activity Histogram",
        value: formatTimelineHistogram(analytics.series, isHourly)
      }
    );
  } else if (view === "trends") {
    embed.addFields(
      { name: "Discord response time", value: `Median reply: **${duration(analytics.timing.reply.medianSeconds)}**\n90th percentile: **${duration(analytics.timing.reply.p90Seconds)}**` },
      { name: "Report types", value: breakdown(analytics.breakdowns.flows) },
      { name: "Countries", value: breakdown(analytics.breakdowns.countries) }
    );
  } else {
    embed.addFields(
      { name: "Initial outcomes", value: `Actioned directly: **${analytics.outcomes.directActioned}**\nClosed without action: **${analytics.outcomes.closedNoAction}**` },
      { name: "Appeals", value: `Started: **${analytics.outcomes.appealsStarted}**\nAppeal then Actioned: **${analytics.outcomes.appealActioned}**\nDenied: **${analytics.outcomes.appealsDenied}**` },
      { name: "Decision time", value: `Initial median: **${duration(analytics.timing.decision.medianSeconds)}**\nAppeal median: **${duration(analytics.timing.appealDecision.medianSeconds)}**` }
    );
  }
  const period = analytics.interval.period === "custom" ? "7d" : analytics.interval.period;
  return { embeds: [embed], files: [], components: analyticsComponents(view, analytics.scope, period) };
}

export async function analyticsViewWithChart(
  analytics: ReportAnalytics,
  view: Exclude<AnalyticsView, "history">
): Promise<ReturnType<typeof analyticsView>> {
  const payload = analyticsView(analytics, view);
  if (analytics.availability !== "available") return payload;
  const chart: AnalyticsChart = view === "outcomes" ? "reply_time" : "volume";
  try {
    const buffer = await renderAnalyticsChart(chart, analytics);
    const name = chart === "volume" ? "report-volume.png" : "discord-reply-time.png";
    payload.files.push(new AttachmentBuilder(buffer, { name }));
    payload.embeds[0]?.setImage(`attachment://${name}`);
  } catch {
    payload.embeds[0]?.setFooter({ text: "Chart unavailable; totals are shown above." });
  }
  return payload;
}

export function actionHistoryModal(): ModalBuilder {
  return new ModalBuilder().setCustomId("analytics:history-range").setTitle("Action History dates")
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder()
        .setCustomId("start_date").setLabel("Start date (YYYY-MM-DD)")
        .setStyle(TextInputStyle.Short).setRequired(true)),
      new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder()
        .setCustomId("end_date").setLabel("End date (YYYY-MM-DD)")
        .setStyle(TextInputStyle.Short).setRequired(true))
    );
}

export function actionHistoryView(
  page: ActionHistoryPage,
  period: AnalyticsPeriod
): { embeds: EmbedBuilder[]; components: ActionRowBuilder<MessageActionRowComponentBuilder>[] } {
  const description = page.items.length === 0
    ? "No Actioned reports were found in this period."
    : page.items.map((item) => [
      `**${item.flow === "guild_urf" ? "Server" : item.flow === "user_urf" ? "Profile" : "Message"} · ${item.category.replaceAll("_", " ")}**`,
      `Actioned ${item.actionedAt.slice(0, 10)} · ${item.actionSource === "appeal" ? "After appeal" : "Direct"}`,
      item.submittedText.slice(0, 600),
      item.messageUrl
    ].filter(Boolean).join("\n")).join("\n\n").slice(0, 4_000);
  return {
    embeds: [new EmbedBuilder().setColor(Colors.Green).setTitle("Your Action History").setDescription(description)],
    components: analyticsComponents("history", "personal", period)
  };
}
