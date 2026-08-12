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
  context.strokeStyle = "#4e5058";
  context.lineWidth = 2;
  context.beginPath();
  context.moveTo(PAD.left, PAD.top);
  context.lineTo(PAD.left, PAD.top + plotHeight);
  context.lineTo(PAD.left + plotWidth, PAD.top + plotHeight);
  context.stroke();

  context.font = "16px sans-serif";
  context.fillStyle = "#b5bac1";
  context.fillText(chart === "volume" ? "Reports" : "Hours", 12, PAD.top + 10);
  context.fillText("UTC date", WIDTH - 112, HEIGHT - 18);
  if (knownValues.length === 0) {
    context.fillText("No data in this period", PAD.left + 20, PAD.top + plotHeight / 2);
    return canvas.encode("png");
  }

  const x = (index: number): number => PAD.left + (values.length === 1
    ? plotWidth / 2
    : index * plotWidth / (values.length - 1));
  const y = (value: number): number => PAD.top + plotHeight - value / maximum * plotHeight;
  context.strokeStyle = "#5865f2";
  context.fillStyle = "#5865f2";
  context.lineWidth = 4;
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
  values.forEach((value, index) => {
    if (value === null) return;
    context.beginPath();
    context.arc(x(index), y(value), 6, 0, Math.PI * 2);
    context.fill();
  });

  context.fillStyle = "#b5bac1";
  const first = analytics.series[0];
  const last = analytics.series.at(-1);
  if (first !== undefined) context.fillText(first.bucketStart.slice(0, 10), PAD.left, HEIGHT - 28);
  if (last !== undefined && last !== first) {
    const label = last.bucketStart.slice(0, 10);
    context.fillText(label, WIDTH - PAD.right - 90, HEIGHT - 28);
  }
  return canvas.encode("png");
}
