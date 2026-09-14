import { describe, expect, it } from "vitest";

import { boundedDiagnostic, readDiagnosticResponse, sanitizeDiagnostic } from "../src/index.js";

describe("diagnostics", () => {
  it("redacts sensitive keys and supplied report values", () => {
    expect(sanitizeDiagnostic({ detail: "bad private evidence", token: "secret" }, ["private evidence"])).toEqual({
      detail: "bad [redacted]",
      token: "[redacted]"
    });
  });

  it("keeps stable error codes while redacting verification values", () => {
    expect(sanitizeDiagnostic({ errorCode: "discord_network_error", verificationCode: "123456", code: "654321" })).toEqual({
      errorCode: "discord_network_error",
      verificationCode: "[redacted]",
      code: "[redacted]"
    });
  });

  it("caps the entire diagnostic payload and handles cyclic data", () => {
    const cyclic: Record<string, unknown> = { token: "secret", first: "x".repeat(65_536), second: "y".repeat(65_536) };
    cyclic.self = cyclic;
    const result = boundedDiagnostic(cyclic, ["secret"]);
    expect(JSON.stringify(result).length).toBeLessThanOrEqual(65_536);
    expect(JSON.stringify(result)).not.toContain("secret");
  });

  it("captures a bounded JSON provider error and request id", async () => {
    const result = await readDiagnosticResponse(new Response(JSON.stringify({ detail: "unsupported parameter" }), {
      headers: { "content-type": "application/json", "x-request-id": "req_1" }
    }), []);
    expect(result).toMatchObject({ requestId: "req_1", body: { detail: "unsupported parameter" } });
  });

  it("omits oversized response bodies instead of logging an unsafe partial value", async () => {
    const result = await readDiagnosticResponse(new Response(JSON.stringify({
      token: "must-not-be-logged",
      padding: "x".repeat(16_384)
    }), {
      headers: { "content-type": "application/json", "x-request-id": "req_large" }
    }));

    expect(result).toEqual({
      contentType: "application/json",
      requestId: "req_large",
      bodyTruncated: true
    });
  });
});
