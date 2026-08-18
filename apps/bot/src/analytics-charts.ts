import { createCanvas } from "@napi-rs/canvas";
import type { ReportAnalytics } from "@discord-dsa/contracts";

export type AnalyticsChart = "volume" | "reply_time";

const WIDTH = 1_100;
const HEIGHT = 420;
const PAD = { left: 76, right: 38, top: 42, bottom: 64 };

export function chartValues(
  chart: AnalyticsChart,
  analytics: ReportAnalytics
): Array<number | null> {
  return analytics.series.map((point) => {
    if (chart === "volume") return point.reportCount;
    return point.medianReplySeconds === null ? null : point.medianReplySeconds / 3_600;
  });
}

export async function renderAnalyticsChart(
  chart: AnalyticsChart,
  analytics: ReportAnalytics
): Promise<Buffer> {
  const canvas = createCanvas(WIDTH, HEIGHT);
  const context = canvas.getContext("2d");
  context.fillStyle = "#1e1f22";
  context.fillRect(0, 0, WIDTH, HEIGHT);
  context.font = "22px sans-serif";
  context.fillStyle = "#f2f3f5";
  context.fillText(chart === "volume" ? "Report volume" : "Discord reply time", PAD.left, 29);

  const values = chartValues(chart, analytics);
  const knownValues = values.filter((value): value is number => value !== null);
  const maximum = Math.max(1, ...knownValues);
  const plotWidth = WIDTH - PAD.left - PAD.right;
  const plotHeight = HEIGHT - PAD.top - PAD.bottom;

  const isHourly = analytics.interval.period === "24h" ||
    (analytics.series.length > 1 &&
      Date.parse(analytics.series[1]!.bucketStart) - Date.parse(analytics.series[0]!.bucketStart) <= 3_600_000);

  // Background grid lines
  context.strokeStyle = "#2b2d31";
  context.lineWidth = 1;
  const gridSteps = 4;
  for (let i = 0; i <= gridSteps; i += 1) {
    const yVal = PAD.top + (plotHeight / gridSteps) * i;
    context.beginPath();
    context.moveTo(PAD.left, yVal);
    context.lineTo(PAD.left + plotWidth, yVal);
    context.stroke();

    const tickVal = Math.round((maximum * (gridSteps - i)) / gridSteps * 10) / 10;
    context.font = "12px sans-serif";
    context.fillStyle = "#80848e";
    context.fillText(String(tickVal), PAD.left - 36, yVal + 4);
  }

  // Axes
  context.strokeStyle = "#4e5058";
  context.lineWidth = 2;
  context.beginPath();
  context.moveTo(PAD.left, PAD.top);
  context.lineTo(PAD.left, PAD.top + plotHeight);
  context.lineTo(PAD.left + plotWidth, PAD.top + plotHeight);
  context.stroke();

  context.font = "14px sans-serif";
  context.fillStyle = "#b5bac1";
  context.fillText(chart === "volume" ? "Reports" : "Hours", 12, PAD.top + 10);
  context.fillText(isHourly ? "Time (UTC)" : "UTC date", WIDTH - 120, HEIGHT - 18);

  if (knownValues.length === 0) {
    context.font = "16px sans-serif";
    context.fillText("No data in this period", PAD.left + 20, PAD.top + plotHeight / 2);
    return canvas.encode("png");
  }

  const x = (index: number): number => PAD.left + (values.length === 1
    ? plotWidth / 2
    : (index * plotWidth) / (values.length - 1));
  const y = (value: number): number => PAD.top + plotHeight - (value / maximum) * plotHeight;

  // Draw fill under line
  context.beginPath();
  let fillStarted = false;
  let firstX = PAD.left;
  let lastX = PAD.left + plotWidth;
  values.forEach((value, index) => {
    if (value === null) return;
    const curX = x(index);
    const curY = y(value);
    if (!fillStarted) {
      context.moveTo(curX, PAD.top + plotHeight);
      context.lineTo(curX, curY);
      firstX = curX;
      fillStarted = true;
    } else {
      context.lineTo(curX, curY);
    }
    lastX = curX;
  });
  if (fillStarted) {
    context.lineTo(lastX, PAD.top + plotHeight);
    context.lineTo(firstX, PAD.top + plotHeight);
    context.closePath();
    context.fillStyle = "rgba(88, 101, 242, 0.12)";
    context.fill();
  }

  // Draw stroke line
  context.strokeStyle = "#5865f2";
  context.lineWidth = 3;
  context.beginPath();
  let drawing = false;
  values.forEach((value, index) => {
    if (value === null) {
      drawing = false;
    } else if (drawing) {
      context.lineTo(x(index), y(value));
    } else {
      context.moveTo(x(index), y(value));
      drawing = true;
    }
  });
  context.stroke();

  // Draw points
  values.forEach((value, index) => {
    if (value === null) return;
    context.beginPath();
    context.arc(x(index), y(value), values.length > 30 ? 3 : 5, 0, Math.PI * 2);
    context.fillStyle = "#5865f2";
    context.fill();
  });

  // X-axis labels
  context.font = "14px sans-serif";
  context.fillStyle = "#b5bac1";
  const first = analytics.series[0];
  const last = analytics.series.at(-1);
  const midIndex = Math.floor(analytics.series.length / 2);
  const mid = analytics.series[midIndex];

  const formatLabel = (point: (typeof analytics.series)[number] | undefined): string => {
    if (!point) return "";
    return isHourly ? point.bucketStart.slice(11, 16) : point.bucketStart.slice(0, 10);
  };

  if (first !== undefined) context.fillText(formatLabel(first), PAD.left, HEIGHT - 28);
  if (mid !== undefined && mid !== first && mid !== last && analytics.series.length >= 6) {
    const midX = x(midIndex) - 20;
    context.fillText(formatLabel(mid), midX, HEIGHT - 28);
  }
  if (last !== undefined && last !== first) {
    const label = formatLabel(last);
    context.fillText(label, WIDTH - PAD.right - 70, HEIGHT - 28);
  }
  return canvas.encode("png");
}

