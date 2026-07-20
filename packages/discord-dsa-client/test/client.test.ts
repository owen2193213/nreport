import { describe, expect, it } from "vitest";

import { DiscordDsaClient } from "../src/client.js";
import { DiscordDsaNetworkError } from "../src/errors.js";
import type {
  JsonRequest,
  JsonTransport,
  ReportMenu,
  ReportSubmissionResult
} from "../src/types.js";
import { createMinimalMenu } from "./fixtures.js";

class FakeTransport implements JsonTransport {
  public readonly requests: JsonRequest[] = [];

  public requestJson<T>(request: JsonRequest): Promise<T> {
    this.requests.push(request);
    let response: unknown;
    if (request.path.includes("/experiments?")) response = { fingerprint: "generated-fp" };
    else if (request.path.endsWith("/verify")) response = { token: "verified-token" };
    else if (request.path.startsWith("menu/")) response = createMinimalMenu("message_urf");
    else if (request.path === "message_urf") response = { report_id: "123" };
    else response = undefined;
    return Promise.resolve(response as T);
  }

  public exportCookies(): string {
    return '{"cookies":[]}';
  }
}

class FlakyFingerprintTransport extends FakeTransport {
  public failuresRemaining = 2;

  public override requestJson<T>(request: JsonRequest): Promise<T> {
    if (request.path.includes("/experiments?") && this.failuresRemaining > 0) {
      this.requests.push(request);
      this.failuresRemaining -= 1;
      return Promise.reject(new DiscordDsaNetworkError("temporary fingerprint failure"));
    }
    return super.requestJson<T>(request);
  }
}

describe("DiscordDsaClient", () => {
  it("constructs the code and verification requests", async () => {
    const transport = new FakeTransport();
    const client = new DiscordDsaClient({
      fingerprint: "test-fp",
      transport
    });

    await client.sendEmailCode("message_urf", "projectnebulon@gmail.com");
    const token = await client.verifyEmailCode(
      "message_urf",
      "reporter@example.com",
      "ABC123"
    );

    expect(token).toBe("verified-token");
    expect(transport.requests).toEqual([
      {
        method: "POST",
        path: "message_urf/code?b=js30bq",
        body: { name: "message_urf", email: "projectnebulon@gmail.com" },
        headers: { "x-fingerprint": "test-fp" }
      },
      {
        method: "POST",
        path: "message_urf/verify",
        body: {
          name: "message_urf",
          email: "reporter@example.com",
          code: "ABC123"
        },
        headers: { "x-fingerprint": "test-fp" }
      }
    ]);
  });

  it("loads menus and submits prepared payloads", async () => {
    const transport = new FakeTransport();
    const client = new DiscordDsaClient({
      fingerprint: "test-fp",
      transport
    });

    const menu: ReportMenu = await client.getMenu("message_urf");
    const result: ReportSubmissionResult = await client.submitPrepared({
      version: menu.version,
      variant: menu.variant,
      language: "en",
      breadcrumbs: [64, 150, 78, 77],
      elements: {},
      email_token: "token",
      name: "message_urf"
    });

    expect(result).toEqual({ report_id: "123" });
    expect(transport.requests.at(-1)?.path).toBe("message_urf");
  });

  it("bootstraps and reuses a Discord fingerprint", async () => {
    const transport = new FakeTransport();
    const client = new DiscordDsaClient({ transport });

    expect(await client.bootstrapFingerprint()).toBe("generated-fp");
    await client.getMenu("message_urf");

    expect(transport.requests).toEqual([
      {
        method: "GET",
        path: "https://discord.com/api/v9/experiments?with_guild_experiments=true"
      },
      {
        method: "GET",
        path: "menu/message_urf",
        headers: { "x-fingerprint": "generated-fp" }
      }
    ]);
  });

  it("retries transient fingerprint bootstrap failures without repeating later requests", async () => {
    const transport = new FlakyFingerprintTransport();
    const client = new DiscordDsaClient({ transport, fingerprintRetryDelayMs: 0 });

    await expect(client.bootstrapFingerprint()).resolves.toBe("generated-fp");
    await client.getMenu("message_urf");

    expect(
      transport.requests.filter((request) => request.path.includes("/experiments?"))
    ).toHaveLength(3);
  });

  it("exports resumable fingerprint and cookie state", async () => {
    const transport = new FakeTransport();
    const client = new DiscordDsaClient({ fingerprint: "persisted-fp", transport });

    await expect(client.snapshotSession()).resolves.toEqual({
      fingerprint: "persisted-fp",
      cookies: '{"cookies":[]}'
    });
  });
});
