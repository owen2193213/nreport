import { describe, expect, it } from "vitest";

import { readDiagnosticResponse, sanitizeDiagnostic } from "../src/index.js";

describe("diagnostics", () => {
  it("redacts sensitive keys and supplied report values", () => {
    expect(sanitizeDiagnostic({ detail: "bad private evidence", token: "secret" }, ["private evidence"])).toEqual({
      detail: "bad [redacted]",
      token: "[redacted]"
    });
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
