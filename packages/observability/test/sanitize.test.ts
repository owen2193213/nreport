import { describe, expect, it } from "vitest";
import type { ErrorEvent, SpanJSON, TransactionEvent } from "@sentry/core";
import { safeErrorSummary, sanitizeFailureContext, sanitizeSentryEvent, sanitizeSentryLog, sanitizeSentryTransaction, sanitizeText } from "../src/sanitize.js";

describe("Sentry privacy filters", () => {
  it("redacts credentials, URLs, email aliases, and verification values from error text", () => {
    const value = sanitizeText("Authorization: Bearer abc.def token=secret https://api.example/r?key=secret reporter@example.org verification code is 123456");
    expect(value).not.toContain("abc.def");
    expect(value).not.toContain("https://");
    expect(value).not.toContain("reporter@example.org");
    expect(value).not.toContain("123456");
    expect(value).toContain("[REDACTED_URL]");
    expect(value).toContain("[REDACTED_EMAIL]");
  });

  it("redacts recognizable service credentials and raw RFC822 mail", () => {
    const discordToken = `${"A".repeat(28)}.${"B".repeat(6)}.${"C".repeat(34)}`;
    const value = sanitizeText(`canary-api-key-do-not-log dsa_live_${"x".repeat(30)} ${discordToken}`);
    expect(value).not.toContain("canary-api-key-do-not-log");
    expect(value).not.toContain("dsa_live_");
    expect(value).not.toContain(discordToken);
    expect(sanitizeText("From: noreply@discord.com\r\nTo: report@example.org\r\nSubject: code 123456\r\n\r\nPrivate mail body"))
      .toBe("[REDACTED_RAW_MAIL]");
  });

  it("redacts exact configured secrets wherever an upstream Error echoes them", () => {
    const previous = process.env.NREPORT_ADMIN_KEY;
    process.env.NREPORT_ADMIN_KEY = "private-configured-admin-key-value";
    try {
      expect(sanitizeText("provider echoed private-configured-admin-key-value in a failure"))
        .not.toContain("private-configured-admin-key-value");
    } finally {
      if (previous === undefined) delete process.env.NREPORT_ADMIN_KEY;
      else process.env.NREPORT_ADMIN_KEY = previous;
    }
  });

  it("redacts complete IPv6 connection URLs including the port and database path", () => {
    const value = sanitizeText("database failed at postgresql://db-user:db-password@[2001:db8::1]:5432/nreport");
    expect(value).not.toContain("db-user");
    expect(value).not.toContain("2001:db8");
    expect(value).not.toContain("5432");
    expect(value).not.toContain("nreport");
    expect(value).toContain("[REDACTED_URL]");
  });

  it("keeps a bounded Error stack and cause chain while scrubbing sensitive text", () => {
    const cause = new Error("provider rejected reporter@example.org with code 123456");
    const error = new Error("failed for https://api.example/v1?token=secret", { cause });
    const summary = safeErrorSummary(error);
    expect(summary.name).toBe("Error");
    expect(summary.message).not.toContain("https://");
    expect(summary.causes).toHaveLength(1);
    expect(summary.causes[0]?.message).not.toContain("reporter@example.org");
    expect(summary.causes[0]?.message).not.toContain("123456");
    expect(summary.stack).toContain("Error:");
    expect(summary.causes[0]?.stack).toContain("Error:");
  });

  it("does not invoke hostile getters on non-Error values", () => {
    const hostile = Object.defineProperties({}, {
      message: { get: () => { throw new Error("message getter should not run"); } },
      toString: { get: () => { throw new Error("toString getter should not run"); } }
    });
    expect(safeErrorSummary(hostile)).toEqual({ name: "Error", message: "Non-Error failure", causes: [] });
  });

  it("accepts only safe structured lifecycle fields", () => {
    const context = sanitizeFailureContext({
      service: "api",
      operation: "report.submit",
      reportId: "8a637427-81d0-4115-9098-21bd9520048c",
      traceId: "e6103c37-995b-41ef-b0de-0654dfac06cb",
      route: "/v1/reports/12345678901234567?key=secret",
      stage: "verification",
      attempt: 2,
      statusCode: 502,
      providerErrorCode: "upstream_unavailable",
      queueCount: 3,
      oldestAgeMs: 420_000
    });
    expect(context).toMatchObject({ service: "api", operation: "report.submit", stage: "verification", attempt: 2, statusCode: 502, queueCount: 3, oldestAgeMs: 420_000 });
    expect(context).not.toHaveProperty("route");
    expect(context).not.toHaveProperty("providerErrorCode", "https://");
    expect(context.reportId).toBe("8a637427-81d0-4115-9098-21bd9520048c");
  });

  it("removes event requests, users, arbitrary extras, breadcrumb data, and local variables", () => {
    const event: ErrorEvent = {
      type: undefined,
      message: "failed for reporter@example.org",
      request: { url: "https://api.example/v1?token=secret", data: { report: "sensitive" } },
      user: { id: "12345678901234567" },
      extra: { body: "sensitive" },
      tags: { service: "api", "discord.error_code": "521004", "provider.error_code": "503", unsafe: "reporter@example.org" },
      breadcrumbs: [{ category: "http", message: "https://api.example/?token=secret", data: { body: "sensitive" } }],
      contexts: { lifecycle: { service: "api", operation: "report.submit", unsafe: "PRIVATE TEXT" } },
      exception: { values: [{ type: "Error", value: "bad token=secret", stacktrace: { frames: [{ filename: "C:\\Users\\someone\\app.js", vars: { token: "secret" }, context_line: "const token = 'secret'" }] } }] }
    };
    const safe = sanitizeSentryEvent(event);
    if (safe === null) throw new Error("Expected the error event to be sanitized");
    expect(safe.request).toBeUndefined();
    expect(safe.user).toBeUndefined();
    expect(safe.extra).toBeUndefined();
    expect(safe.tags).toEqual({ service: "api", "discord.error_code": "521004", "provider.error_code": "503" });
    expect(safe.message).not.toContain("reporter@example.org");
    expect(safe.breadcrumbs?.[0]?.message).not.toContain("https://");
    expect(safe.breadcrumbs?.[0]?.data).toBeUndefined();
    expect(safe.exception?.values?.[0]?.stacktrace?.frames?.[0]?.vars).toBeUndefined();
    expect(safe.exception?.values?.[0]?.stacktrace?.frames?.[0]?.context_line).toBeUndefined();
    expect(safe.contexts?.lifecycle).toEqual({ service: "api", operation: "report.submit" });
  });

  it("keeps route-level transaction context and strips SQL, URL, and body span data", () => {
    const event: TransactionEvent = {
      type: "transaction",
      transaction: "POST /v1/reports/12345678901234567?token=secret",
      request: { url: "https://api.example/?token=secret", data: "private" },
      spans: [{ span_id: "abc123", trace_id: "def456", start_timestamp: 1, op: "db.query", description: "SELECT * FROM reports WHERE evidence = 'private'", data: { "db.statement": "SELECT private", "db.system": "postgresql", "db.operation": "SELECT", url: "https://db.example" } } satisfies SpanJSON]
    };
    const safe = sanitizeSentryTransaction(event);
    if (safe === null) throw new Error("Expected the transaction to be sanitized");
    expect(safe.transaction).toBe("transaction");
    expect(safe.request).toBeUndefined();
    expect(safe.spans?.[0]?.description).toBe("db.query");
    expect(safe.spans?.[0]?.data).toEqual({ "db.system": "postgresql", "db.operation": "SELECT" });
  });

  it("restricts log attributes and sanitizes log messages", () => {
    const log = { level: "error" as const, message: "request https://api.example/?key=secret", attributes: { service: "bot", authorization: "Bearer token", "http.status_code": 503, report: "private" } };
    const safe = sanitizeSentryLog(log);
    expect(safe?.message).not.toContain("https://");
    expect(safe?.attributes).toEqual({ service: "bot", "http.status_code": 503 });
  });
});
