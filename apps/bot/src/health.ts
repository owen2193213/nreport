import { createServer } from "node:http";
import type { Server, ServerResponse } from "node:http";

import type { BotDatabase } from "./database.js";

export class HealthServer {
  private server: Server | undefined;

  public constructor(
    private readonly database: BotDatabase,
    private readonly ready: () => boolean
  ) {}

  public async listen(port: number): Promise<void> {
    this.server = createServer((request, response) => {
      if (request.url !== "/healthz") {
        response.writeHead(404).end();
        return;
      }
      void this.respond(response);
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

  public async close(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((resolve, reject) => {
      this.server?.close((error) => (error ? reject(error) : resolve()));
    });
  }
}
