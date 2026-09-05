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
      if (event.eventId !== eventId || !/^\d+$/.test(eventId) || typeof event.accountId !== "string" ||
        typeof event.reportId !== "string" || typeof event.type !== "string" ||
        !Number.isSafeInteger(event.lifecycleAttempt) || !Number.isFinite(Date.parse(event.occurredAt ?? ""))) {
        json(response, 400, { error: "invalid_event" });
        return;
      }
      const result = await this.database.ingestEvent(event as ReportLifecycleEvent);
      json(response, reportEventIngestionStatus(result), { status: result });
    } catch {
      json(response, 400, { error: "invalid_event" });
    }
  }
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
