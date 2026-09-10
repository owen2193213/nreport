import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import type { ReportLifecycleEvent } from "@nreport/contracts";

import type { AccountBotDatabase, EventIngestionResult } from "./account-database.js";
import { verifyReportEventSignature } from "./crypto.js";

export function reportEventIngestionStatus(result: EventIngestionResult): 202 | 409 {
  return result === "not_tracked_yet" ? 409 : 202;
}

export class HealthServer {
  private server: Server | undefined;

  public constructor(
    private readonly database: AccountBotDatabase,
    private readonly ready: () => boolean,
    private readonly eventSecret?: string
  ) {}

  public async listen(port: number): Promise<void> {
    this.server = createServer((request, response) => {
      if (request.method === "GET" && request.url === "/healthz") void this.health(response);
      else if (request.method === "POST" && request.url === "/internal/report-events" && this.eventSecret !== undefined) {
        void this.event(request, response);
      } else response.writeHead(404).end();
    });
    await new Promise<void>((resolve, reject) => {
      this.server?.once("error", reject);
      this.server?.listen(port, "0.0.0.0", resolve);
    });
  }

  public async close(): Promise<void> {
    if (this.server === undefined) return;
    await new Promise<void>((resolve, reject) => this.server?.close((error) => error ? reject(error) : resolve()));
  }

  private async health(response: ServerResponse): Promise<void> {
    try {
      await this.database.healthcheck();
      if (!this.ready()) throw new Error("Discord is not ready.");
      json(response, 200, { status: "ok" });
    } catch {
      json(response, 503, { status: "unavailable" });
    }
  }

  private async event(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      const body = await readBody(request);
      const eventId = request.headers["x-report-event-id"];
      const timestamp = request.headers["x-report-event-timestamp"];
      const signature = request.headers["x-report-event-signature"];
      if (typeof eventId !== "string" || typeof timestamp !== "string" || typeof signature !== "string" ||
        !verifyReportEventSignature({ secret: this.eventSecret!, eventId, timestamp, signature, body })) {
        json(response, 401, { error: "invalid_signature" });
        return;
      }
      const event = JSON.parse(body) as Partial<ReportLifecycleEvent>;
      if (event.eventId !== eventId || !isReportLifecycleEvent(event)) {
        json(response, 400, { error: "invalid_event" });
        return;
      }
      const result = await this.database.ingestEvent(event);
      json(response, reportEventIngestionStatus(result), { status: result });
    } catch {
      json(response, 400, { error: "invalid_event" });
    }
  }
}

export function isReportLifecycleEvent(event: unknown): event is ReportLifecycleEvent {
  if (typeof event !== "object" || event === null) return false;
  const candidate = event as Partial<ReportLifecycleEvent>;
  return typeof candidate.eventId === "string" && /^\d+$/.test(candidate.eventId) &&
    typeof candidate.accountId === "string" && typeof candidate.reportId === "string" &&
    typeof candidate.traceId === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(candidate.traceId) &&
    typeof candidate.type === "string" && Number.isSafeInteger(candidate.lifecycleAttempt) &&
    !Number.isNaN(Date.parse(candidate.occurredAt ?? ""));
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer | string) => {
      const buffer = Buffer.from(chunk);
      size += buffer.length;
      if (size > 65_536) {
        reject(new Error("Payload too large."));
        request.destroy();
      } else chunks.push(buffer);
    });
    request.once("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.once("error", reject);
  });
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}
