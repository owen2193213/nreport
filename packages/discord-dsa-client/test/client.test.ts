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
  public readonly redirects: string[] = [];

  public requestJson<T>(request: JsonRequest): Promise<T> {
    this.requests.push(request);
    let response: unknown;
    if (request.path.includes("/experiments?")) response = { fingerprint: "generated-fp" };
    else if (request.path.endsWith("/verify")) response = { token: "verified-token" };
    else if (request.path.startsWith("menu/")) response = createMinimalMenu("message_urf");
    else if (request.path === "message_urf") response = { report_id: "123" };
    else if (request.path === "https://discord.com/api/v9/reporting/review") {
      response = { report_id: "1510655259763019999" };
    }
    else response = undefined;
    return Promise.resolve(response as T);
  }

  public resolveRedirect(url: string): Promise<string> {
    this.redirects.push(url);
    return Promise.resolve(
      "https://discord.com/report-review#token=review-token-value"
    );
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
        body: {
          name: "message_urf",
          email: "projectnebulon@gmail.com",
          language: "en"
        },
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

  it("honors a single configured fingerprint bootstrap attempt", async () => {
    const transport = new FlakyFingerprintTransport();
    const client = new DiscordDsaClient({
      transport,
      fingerprintMaxAttempts: 1,
      fingerprintRetryDelayMs: 0
    });

    await expect(client.bootstrapFingerprint()).rejects.toThrow(
      "temporary fingerprint failure"
    );
    expect(
      transport.requests.filter((request) => request.path.includes("/experiments?"))
    ).toHaveLength(1);
  });

  it.each([0, -1, 1.5])(
    "rejects invalid fingerprint attempt limit %s",
    (fingerprintMaxAttempts) => {
      expect(
        () => new DiscordDsaClient({ transport: new FakeTransport(), fingerprintMaxAttempts })
      ).toThrow("fingerprintMaxAttempts must be a positive integer");
    }
  );

  it("exports resumable fingerprint and cookie state", async () => {
    const transport = new FakeTransport();
    const client = new DiscordDsaClient({ fingerprint: "persisted-fp", transport });

    await expect(client.snapshotSession()).resolves.toEqual({
      fingerprint: "persisted-fp",
      cookies: '{"cookies":[]}'
    });
  });

  it("resolves a trusted tracking link and submits a token-only report review", async () => {
    const transport = new FakeTransport();
    const client = new DiscordDsaClient({ transport });

    await expect(
      client.submitReportReview("https://click.discord.com/ls/click?upn=opaque")
    ).resolves.toEqual({ report_id: "1510655259763019999" });

    expect(transport.redirects).toEqual([
      "https://click.discord.com/ls/click?upn=opaque"
    ]);
    expect(transport.requests.at(-1)).toEqual({
      method: "POST",
      path: "https://discord.com/api/v9/reporting/review",
      body: { token: "review-token-value" }
    });
  });

  it("retains direct query-token compatibility", async () => {
    const client = new DiscordDsaClient({ transport: new FakeTransport() });

    await expect(
      client.resolveReportReviewToken(
        "https://discord.com/report-review?token=legacy-query-token"
      )
    ).resolves.toBe("legacy-query-token");
  });

  it("rejects untrusted review and redirect URLs", async () => {
    const client = new DiscordDsaClient({ transport: new FakeTransport() });

    await expect(
      client.submitReportReview("https://example.org/report-review?token=secret")
    ).rejects.toThrow("trusted Discord report-review URL");
  });
});
