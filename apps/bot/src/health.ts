import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";

import type { ReportLifecycleEvent } from "@discord-dsa/contracts";

import { verifyReportEventSignature } from "./crypto.js";
import type { BotDatabase, ReportEventIngestionResult } from "./database.js";
import { botLog, errorFields } from "./observability.js";

export function reportEventIngestionStatus(result: ReportEventIngestionResult): 202 | 409 {
  return result === "not_tracked_yet" ? 409 : 202;
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Array<Buffer<ArrayBufferLike>> = [];
    let size = 0;
    request.on("data", (chunk: unknown) => {
      if (!Buffer.isBuffer(chunk) && typeof chunk !== "string") {
        reject(new Error("Invalid event payload."));
        return;
      }
      const buffer = Buffer.from(chunk);
      size += buffer.length;
      if (size > 65_536) {
        reject(new Error("Event payload is too large."));
        request.destroy();
        return;
      }
      chunks.push(buffer);
    });
    request.once("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.once("error", reject);
  });
}

export class HealthServer {
  private server: Server | undefined;

  public constructor(
    private readonly database: BotDatabase,
    private readonly ready: () => boolean,
    private readonly eventSecret?: string
  ) {}

  public async listen(port: number): Promise<void> {
    this.server = createServer((request, response) => {
      if (request.url === "/healthz" && request.method === "GET") {
        void this.respond(response);
        return;
      }
      if (
        request.url === "/internal/report-events" &&
        request.method === "POST" &&
        this.eventSecret
      ) {
        void this.receiveEvent(request, response);
        return;
      }
      response.writeHead(404).end();
    });
    await new Promise<void>((resolve, reject) => {
      this.server?.once("error", reject);
      this.server?.listen(port, "0.0.0.0", resolve);
    });
  }

  private async respond(response: ServerResponse): Promise<void> {
    try {
      await this.database.healthcheck();
      if (!this.ready()) throw new Error("Discord client is not ready.");
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ status: "ok" }));
    } catch {
      response.writeHead(503, { "content-type": "application/json" });
      response.end(JSON.stringify({ status: "unavailable" }));
    }
  }

  private async receiveEvent(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      const body = await readBody(request);
      const eventId = request.headers["x-report-event-id"];
      const timestamp = request.headers["x-report-event-timestamp"];
      const signature = request.headers["x-report-event-signature"];
      if (
        typeof eventId !== "string" ||
        typeof timestamp !== "string" ||
        typeof signature !== "string" ||
        !verifyReportEventSignature({
          secret: this.eventSecret!,
          eventId,
          timestamp,
          signature,
          body
        })
      ) {
        botLog("lifecycle_webhook_rejected", { reason: "invalid_signature" }, "warn");
        response.writeHead(401, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "invalid_signature" }));
        return;
      }
      const event = JSON.parse(body) as ReportLifecycleEvent;
      if (
        event.eventId !== eventId ||
        !/^\d+$/.test(event.eventId) ||
        !/^\d{15,22}$/.test(event.submitterDiscordUserId) ||
        typeof event.internalReportId !== "string" ||
        typeof event.type !== "string" ||
        !Number.isInteger(event.lifecycleAttempt) ||
        event.lifecycleAttempt < 1 ||
        !Number.isFinite(new Date(event.occurredAt).getTime())
      ) {
        botLog("lifecycle_webhook_rejected", { reason: "invalid_event" }, "warn");
        response.writeHead(400, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "invalid_event" }));
        return;
      }
      const ingestionResult = await this.database.ingestLifecycleEvent(event);
      botLog("lifecycle_webhook_ingested", {
        eventId: event.eventId,
        reportId: event.internalReportId,
        eventType: event.type,
        lifecycleAttempt: event.lifecycleAttempt,
        ingestionResult
      });
      response.writeHead(reportEventIngestionStatus(ingestionResult), {
        "content-type": "application/json"
      });
      response.end(JSON.stringify({ status: ingestionResult }));
    } catch (error) {
      botLog("lifecycle_webhook_rejected", { reason: "invalid_event", ...errorFields(error) }, "warn");
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "invalid_event" }));
    }
  }

  public async close(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((resolve, reject) => {
      this.server?.close((error) => (error ? reject(error) : resolve()));
    });
  }
}
