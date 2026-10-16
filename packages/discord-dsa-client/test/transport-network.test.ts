import { createServer } from "node:http";
import { once } from "node:events";
import { describe, expect, it } from "vitest";
import { UndiciJsonTransport } from "../src/transport.js";
import { DiscordDsaNetworkError } from "../src/errors.js";

describe("truncated HTTP response handling", () => {
  it.each(["json", "redirect"])("classifies a broken %s response body as a network failure", async (kind) => {
    let requests = 0;
    const server = createServer((_request, response) => {
      requests += 1;
      response.writeHead(kind === "json" ? 200 : 302, {
        "content-length": "100", connection: "close", location: "/destination"
      });
      response.end("{}");
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Missing local test listener");
    const url = `http://127.0.0.1:${address.port}/`;
    const transport = new UndiciJsonTransport({ baseUrl: url, timeoutMs: 100 });
    try {
      const operation = kind === "json"
        ? transport.requestJson({ method: "POST", path: "submission", body: {} })
        : transport.resolveRedirect(url);
      await expect(operation).rejects.toBeInstanceOf(DiscordDsaNetworkError);
      expect(requests).toBe(1);
    } finally {
      await transport.close();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});
