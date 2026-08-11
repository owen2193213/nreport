import { createCanvas } from "@napi-rs/canvas";
import type { ReportAnalytics } from "@discord-dsa/contracts";

export type AnalyticsChart = "volume" | "reply_time";

const WIDTH = 1_100;
const HEIGHT = 420;
const PAD = { left: 76, right: 38, top: 42, bottom: 64 };

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

  const values = analytics.series.map((point) =>
    chart === "volume" ? point.reportCount : (point.medianReplySeconds ?? 0) / 3_600
  );
  const maximum = Math.max(1, ...values);
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
  if (values.length === 0) {
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
  values.forEach((value, index) => {
    if (index === 0) context.moveTo(x(index), y(value));
    else context.lineTo(x(index), y(value));
  });
  context.stroke();
  values.forEach((value, index) => {
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
