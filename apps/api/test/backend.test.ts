import { Buffer } from "node:buffer";
import { randomBytes } from "node:crypto";

import { faker } from "@faker-js/faker";
import { DiscordDsaHttpError, DiscordDsaNetworkError } from "@discord-dsa/client";
import { describe, expect, it, vi } from "vitest";

import type { AppConfig } from "../src/config.js";
import {
  extractVerificationCode,
  inspectDiscordEmail,
  parseDiscordEmail
} from "../src/email.js";
import {
  Database,
  DISCORD_RECEIPT_TIMEOUT_SECONDS,
  DISCORD_REVIEW_CONFIRMATION_TIMEOUT_SECONDS,
  isRetryableFailure,
  ReviewRetryError,
  shouldExpireDiscordReceipt,
  statusAfterSessionPersistence,
  shouldResendVerification,
  shouldApplyDiscordStatus,
  VERIFICATION_EMAIL_RESEND_DELAYS_SECONDS,
  VERIFICATION_EMAIL_TIMEOUT_SECONDS,
  type ReportRow
} from "../src/database.js";
import {
  discordErrorCode,
  inspectNetworkCause,
  isAmbiguousReviewFailure,
  isRetryableDiscordFailure,
  isReviewAlreadyRequested,
  isReviewIneligible,
  redactedError
} from "../src/job-runner.js";
import {
  buildAcceptLanguage,
  generateEmailAlias,
  generateIdentity,
  supportedCountries
} from "../src/pseudonyms.js";
import {
  decryptJson,
  encryptJson,
  signInboundEmail,
  signReportEvent,
  verifyInboundSignature
} from "../src/security.js";
import { buildServer } from "../src/server.js";
import {
  DISCORD_FORM_LANGUAGE,
  parseCreateReportInput,
  parseRetryReportInput
} from "../src/validation.js";

function reviewReport(overrides: Partial<ReportRow> = {}): ReportRow {
  return {
    id: "report-1",
    idempotency_key: "create:interaction-1",
    request_hash: "request-hash",
    flow: "message_urf",
    country: "DE",
    report_type: "sub_other_hate_speech",
    submitter_discord_user_id: "123456789012345678",
    reporter_legal_name: "Test Reporter",
    reporter_email: "test.reporter@example.org",
    timezone: "Europe/Berlin",
    locale: "de-DE",
    language: "de",
    proxy_session_id: "123456789012",
    status: "submitted",
    input: {
      country: "DE",
      flow: "message_urf",
      messageUrl: "https://discord.com/channels/@me/123456789012345678/123456789012345679",
      reportReason: "The message contains hateful content.",
      reportType: "sub_other_hate_speech",
      submitterDiscordUserId: "123456789012345678"
    },
    session_state: null,
    discord_report_id: "1535782696062816367",
    discord_status: "closed_no_action",
    discord_status_updated_at: new Date("2026-08-09T00:00:00.000Z"),
    review_status: "ineligible",
    review_status_updated_at: new Date("2026-08-09T00:01:00.000Z"),
    review_confirmation_deadline: null,
    review_error_code: "discord_review_ineligible",
    review_error_message: "Discord says this DSA report is ineligible for review.",
    review_retry_requested_at: null,
    error_code: null,
    error_message: null,
    lifecycle_attempt: 1,
    retryable: false,
    failure_stage: null,
    retry_of_report_id: null,
    retried_as_report_id: null,
    retry_sequence: 0,
    verification_deadline: null,
    receipt_deadline: null,
    created_at: new Date("2026-08-09T00:00:00.000Z"),
    updated_at: new Date("2026-08-09T00:01:00.000Z"),
    ...overrides
  };
}

function reviewRetryDatabase(input: {
  report?: ReportRow | null;
  retainedJob?: boolean;
  jobState?: string;
  acceptedKeys?: string[];
} = {}): { database: Database; queries: string[] } {
  const report = input.report === undefined ? reviewReport() : input.report;
  const queries: string[] = [];
  const client = {
    query: (sql: string, values?: unknown[]) => {
      queries.push(sql);
      if (sql.includes("SELECT * FROM reports") && sql.includes("FOR UPDATE")) {
        return Promise.resolve({ rows: report ? [report] : [], rowCount: report ? 1 : 0 });
      }
      if (sql.includes("FROM review_retry_requests")) {
        const replayed = input.acceptedKeys?.includes(String(values?.[1])) === true;
        return Promise.resolve({ rows: replayed ? [{ "?column?": 1 }] : [], rowCount: replayed ? 1 : 0 });
      }
      if (sql.includes("FROM report_jobs") && sql.includes("submit_review")) {
        return Promise.resolve({
          rows:
            input.retainedJob === false
              ? []
              : [{ id: "job-1", state: input.jobState ?? "completed", payload: { encryptedReviewUrl: "encrypted" } }],
          rowCount: input.retainedJob === false ? 0 : 1
        });
      }
      if (sql.includes("UPDATE reports") && sql.includes("RETURNING *")) {
        return Promise.resolve({
          rows: [
            reviewReport({
              review_status: "queued",
              review_retry_requested_at: new Date()
            })
          ],
          rowCount: 1
        });
      }
      if (sql.includes("SELECT lifecycle_attempt")) {
        return Promise.resolve({ rows: [{ lifecycle_attempt: 1 }], rowCount: 1 });
      }
      if (sql.includes("INSERT INTO report_events")) {
        return Promise.resolve({
          rows: [{ id: "1", report_id: "report-1", event_type: "review_queued", metadata: {} }],
          rowCount: 1
        });
      }
      return Promise.resolve({ rows: [], rowCount: 1 });
    },
    release: () => undefined
  };
  const database = new Database("postgres://unused");
  (database as unknown as { pool: unknown }).pool = {
    connect: () => Promise.resolve(client)
  };
  return { database, queries };
}

describe("backend identity and validation", () => {
  it("extracts only safe diagnostics from a wrapped Discord network failure", () => {
    const lowLevel = Object.assign(new Error("proxy credentials must stay private"), {
      code: "UND_ERR_CONNECT_TIMEOUT",
      syscall: "connect",
      hostname: "secret-proxy.example",
      proxyUrl: "http://user:password@secret-proxy.example"
    });
    const wrapper = new Error("request failed", { cause: lowLevel });

    expect(inspectNetworkCause(wrapper)).toEqual({
      name: "Error",
      code: "UND_ERR_CONNECT_TIMEOUT",
      syscall: "connect",
      depth: 1
    });
    expect(JSON.stringify(inspectNetworkCause(wrapper))).not.toContain("secret");
    expect(JSON.stringify(inspectNetworkCause(wrapper))).not.toContain("password");
  });

  it("bounds malformed and cyclic network cause chains", () => {
    const cyclic = Object.assign(new Error("cyclic"), { code: 500 });
    cyclic.cause = cyclic;

    expect(inspectNetworkCause(cyclic)).toEqual({
      name: "Error",
      code: "500",
      depth: 0
    });
    expect(inspectNetworkCause("not an error")).toBeUndefined();
  });

  it("preserves safe Discord HTTP diagnostics for structured logs", () => {
    const error = new DiscordDsaHttpError("request failed", 400, {
      retryAfterSeconds: 7,
      responseSummary: "code 521004; Report is not eligible for report review"
    });
    const diagnostic = redactedError(error);

    expect(diagnostic).toEqual({
      type: "DiscordDsaHttpError",
      code: "discord_http_400",
      message:
        "Discord returned HTTP 400: code 521004; Report is not eligible for report review",
      httpStatus: 400,
      discordErrorCode: "521004",
      discordResponseSummary:
        "code 521004; Report is not eligible for report review",
      retryAfter: 7
    });
    expect(isReviewIneligible(error)).toBe(true);
    expect(
      isReviewIneligible(
        new DiscordDsaHttpError("request failed", 400, {
          responseSummary: "code 50035; Invalid Form Body"
        })
      )
    ).toBe(false);
  });

  it("classifies Discord appeal convergence and ineligibility codes", () => {
    const alreadyRequested = new DiscordDsaHttpError("request failed", 400, {
      responseSummary: "code 521002; DSA_RSL_ALREADY_REQUESTED"
    });
    const ineligible = new DiscordDsaHttpError("request failed", 400, {
      responseSummary: "code 521004; DSA_RSL_REPORT_INELIGIBLE"
    });

    expect(discordErrorCode(alreadyRequested.responseSummary)).toBe("521002");
    expect(isReviewAlreadyRequested(alreadyRequested)).toBe(true);
    expect(isReviewIneligible(alreadyRequested)).toBe(false);
    expect(isReviewAlreadyRequested(ineligible)).toBe(false);
    expect(isReviewIneligible(ineligible)).toBe(true);
  });

  it("retries only transient Discord transport failures", () => {
    const network = new DiscordDsaNetworkError("network failed");
    const rateLimited = new DiscordDsaHttpError("rate limited", 429);
    const serverError = new DiscordDsaHttpError("server failed", 503);
    const internalAppealError = new DiscordDsaHttpError("appeal failed", 400, {
      responseSummary: "code 522002; Internal error occurred while processing the appeal"
    });

    expect(isRetryableDiscordFailure(network)).toBe(true);
    expect(isRetryableDiscordFailure(rateLimited)).toBe(true);
    expect(isRetryableDiscordFailure(serverError)).toBe(true);
    expect(isRetryableDiscordFailure(internalAppealError)).toBe(false);
    expect(isRetryableDiscordFailure(new Error("local failure"))).toBe(false);
  });

  it("marks exhausted network and server failures ambiguous but rate limits failed", () => {
    expect(isAmbiguousReviewFailure(new DiscordDsaNetworkError("network failed"))).toBe(
      true
    );
    expect(isAmbiguousReviewFailure(new DiscordDsaHttpError("server failed", 500))).toBe(
      true
    );
    expect(isAmbiguousReviewFailure(new DiscordDsaHttpError("rate limited", 429))).toBe(
      false
    );
  });

  it("logs only bounded network classifications instead of connection secrets", () => {
    const cause = Object.assign(new Error("secret proxy failed"), {
      code: "UND_ERR_CONNECT_TIMEOUT",
      syscall: "connect",
      proxyUrl: "sensitive-proxy-value"
    });
    const diagnostic = redactedError(
      new DiscordDsaNetworkError("network request failed", { cause })
    );

    expect(diagnostic).toEqual({
      type: "DiscordDsaNetworkError",
      code: "discord_network_error",
      message: "Temporary connection to Discord failed. Please retry this report.",
      networkCause: {
        name: "Error",
        code: "UND_ERR_CONNECT_TIMEOUT",
        syscall: "connect",
        depth: 1
      }
    });
    expect(JSON.stringify(diagnostic)).not.toContain("secret-proxy");
    expect(JSON.stringify(diagnostic)).not.toContain("password");
  });

  it("keeps Discord's form language independent from the country locale", () => {
    const identity = generateIdentity("DE", "reports.example.org");

    expect(identity.language).toBe("de");
    expect(DISCORD_FORM_LANGUAGE).toBe("en");
  });

  it("generates a unique identity with localized session settings", () => {
    const identity = generateIdentity("de", "reports.example.org");
    expect(identity.country).toBe("DE");
    expect(identity.displayName).toContain(" ");
    expect(identity.internalReportId).toMatch(/^[a-z0-9-]+-[0-9a-hjkmnp-tv-z]{16}$/);
    expect(identity.email).toMatch(
      /^[a-z0-9.]+\.[0-9a-hjkmnp-tv-z]{16}@reports\.example\.org$/
    );
    expect(identity.timezone).toBe("Europe/Berlin");
    expect(identity.locale).toBe("de-DE");
    expect(identity.language).toBe("de");
  });

  it("generates reporter names independently from the selected country", () => {
    faker.seed(20_260_728);
    const germanName = generateIdentity("DE", "reports.example.org").displayName;
    faker.seed(20_260_728);
    const frenchName = generateIdentity("FR", "reports.example.org").displayName;

    expect(germanName).toBe(frenchName);
  });

  it("generates an internally consistent identity for every EU member state", () => {
    expect(supportedCountries()).toEqual([
      "AT", "BE", "BG", "CY", "CZ", "DE", "DK", "EE", "ES",
      "FI", "FR", "GR", "HR", "HU", "IE", "IT", "LT", "LU",
      "LV", "MT", "NL", "PL", "PT", "RO", "SE", "SI", "SK"
    ]);
    for (const country of supportedCountries()) {
      const identity = generateIdentity(country, "reports.example.org");
      expect(identity.country).toBe(country);
      expect(identity.displayName.trim().split(/\s+/).length).toBeGreaterThanOrEqual(2);
      expect(identity.internalReportId).toMatch(/^[a-z0-9-]+-[0-9a-hjkmnp-tv-z]{16}$/);
      expect(identity.email).toMatch(/^[a-z0-9.]+\.[0-9a-hjkmnp-tv-z]{16}@reports\.example\.org$/);
      expect(identity.locale).toMatch(/^[a-z]{2}-[A-Z]{2}$/);
      expect(identity.language).toMatch(/^[a-z]{2}$/);
      expect(identity.timezone).toContain("/");
      expect(buildAcceptLanguage(identity.locale, identity.language)).toContain(identity.locale);
    }
  });

  it("rejects caller-supplied reporter identities", () => {
    expect(() =>
      parseCreateReportInput({
        country: "DE",
        flow: "message_urf",
        reportReason: "The message contains cybercrime content.",
        reportType: "sub_other_cybercrime",
        messageUrl: "https://discord.com/channels/1/2/3",
        legalName: "Caller supplied"
      })
    ).toThrow(/generated by the service/);
  });

  it("accepts and validates internal Discord submitter ownership", () => {
    const input = parseCreateReportInput({
      country: "DE",
      flow: "message_urf",
      reportReason: "The message contains hateful content.",
      reportType: "sub_other_hate_speech",
      messageUrl: "https://discord.com/channels/427067963137589258/427069953078853633/1414818522701369355",
      submitterDiscordUserId: "1057381507204915281"
    });
    expect(input.submitterDiscordUserId).toBe("1057381507204915281");
    expect(() =>
      parseCreateReportInput({
        country: "DE",
        flow: "message_urf",
        reportReason: "The message contains hateful content.",
        reportType: "sub_other_hate_speech",
        messageUrl: "https://discord.com/channels/1/2/3",
        submitterDiscordUserId: "not-a-user"
      })
    ).toThrow(/Discord snowflake/);
  });

  it("preserves validated captured message evidence for durable analysis", () => {
    const input = parseCreateReportInput({
      country: "DE",
      flow: "message_urf",
      reportReason: "Illegal content",
      reportType: "sub_other_hate_speech",
      messageUrl:
        "https://discord.com/channels/123456789012345678/223456789012345678/323456789012345678",
      messageEvidence: {
        source: "message_link",
        status: "captured",
        capturedAt: "2026-07-20T00:01:00.000Z",
        snapshot: {
          messageId: "323456789012345678",
          channelId: "223456789012345678",
          channelName: "reports",
          serverId: "123456789012345678",
          serverName: "Example server",
          authorId: "423456789012345678",
          authorUsername: "example",
          authorDisplayName: "Example Display",
          authorAvatarUrl: "https://cdn.discordapp.com/avatar.png",
          authorBot: false,
          content: "  Exact e\u200Bvidence café 😀\u0000 with whitespace  ",
          createdAt: "2026-07-20T00:00:00.000Z",
          attachments: [{
            name: "evidence.png",
            url: "https://cdn.discordapp.com/evidence.png",
            contentType: "image/png",
            size: 1234,
            spoiler: true
          }],
          embeds: [{
            title: "E\u200Bvidence\u0000",
            description: "Embedded café 😀\u0000 text",
            url: "https://example.test/e"
          }]
        }
      }
    });

    expect(input.flow).toBe("message_urf");
    if (input.flow !== "message_urf") throw new Error("Expected a message report.");
    expect(input.messageEvidence?.status).toBe("captured");
    expect(
      input.messageEvidence?.status === "captured" &&
        input.messageEvidence.snapshot.content
    ).toBe("  Exact e\u200Bvidence café 😀 with whitespace  ");
    if (input.messageEvidence?.status !== "captured") {
      throw new Error("Expected captured message evidence.");
    }
    expect(input.messageEvidence.snapshot.embeds).toEqual([
      {
        title: "E\u200Bvidence",
        description: "Embedded café 😀 text",
        url: "https://example.test/e"
      }
    ]);
  });

  it("parses and validates referenced message evidence on message reports", () => {
    const input = parseCreateReportInput({
      country: "DE",
      flow: "message_urf",
      reportReason: "Illegal content",
      reportType: "sub_other_hate_speech",
      messageUrl:
        "https://discord.com/channels/123456789012345678/223456789012345678/323456789012345678",
      messageEvidence: {
        source: "message_link",
        status: "captured",
        capturedAt: "2026-07-20T00:01:00.000Z",
        snapshot: {
          messageId: "323456789012345678",
          channelId: "223456789012345678",
          channelName: "reports",
          serverId: "123456789012345678",
          serverName: "Example server",
          authorId: "423456789012345678",
          authorUsername: "example",
          authorDisplayName: "Example Display",
          authorAvatarUrl: "https://cdn.discordapp.com/avatar.png",
          authorBot: false,
          content: "Replying message",
          createdAt: "2026-07-20T00:00:00.000Z",
          attachments: [],
          embeds: [],
          referencedMessage: {
            messageId: "223456789012345679",
            authorId: "504116640007323648",
            authorUsername: "original_user",
            authorDisplayName: "Original User",
            authorBot: false,
            content: "Original message text",
            attachments: [
              {
                name: "context.png",
                contentType: "image/png",
                size: 512,
                spoiler: false
              }
            ]
          }
        }
      }
    });

    if (input.flow !== "message_urf" || input.messageEvidence?.status !== "captured") {
      throw new Error("Expected captured message evidence.");
    }
    expect(input.messageEvidence.snapshot.referencedMessage).toEqual({
      messageId: "223456789012345679",
      authorId: "504116640007323648",
      authorUsername: "original_user",
      authorDisplayName: "Original User",
      authorBot: false,
      content: "Original message text",
      attachments: [
        {
          name: "context.png",
          contentType: "image/png",
          size: 512,
          spoiler: false
        }
      ]
    });
  });

  it("rejects message evidence that does not match its Discord link", () => {
    const base = {
      country: "DE",
      flow: "message_urf",
      reportReason: "Illegal content",
      reportType: "sub_other_hate_speech",
      messageUrl:
        "https://discord.com/channels/123456789012345678/223456789012345678/323456789012345678",
      messageEvidence: {
        source: "context_menu",
        status: "captured",
        capturedAt: "2026-07-20T00:01:00.000Z",
        snapshot: {
          messageId: "923456789012345678",
          channelId: "223456789012345678",
          channelName: null,
          serverId: "123456789012345678",
          serverName: null,
          authorId: "423456789012345678",
          authorUsername: "example",
          authorDisplayName: null,
          authorAvatarUrl: null,
          authorBot: false,
          content: "Evidence",
          createdAt: "2026-07-20T00:00:00.000Z",
          attachments: [],
          embeds: []
        }
      }
    };
    expect(() => parseCreateReportInput(base)).toThrow(/must match messageUrl/);
    expect(() =>
      parseCreateReportInput({
        ...base,
        messageEvidence: {
          ...base.messageEvidence,
          snapshot: {
            ...base.messageEvidence.snapshot,
            messageId: "323456789012345678",
            serverId: "823456789012345678"
          }
        }
      })
    ).toThrow(/serverId must match/);
  });

  it("accepts unavailable link evidence and historical reports without evidence", () => {
    const base = {
      country: "DE",
      flow: "message_urf",
      reportReason: "Illegal content",
      reportType: "sub_other_hate_speech",
      messageUrl:
        "https://discord.com/channels/123456789012345678/223456789012345678/323456789012345678"
    };
    expect(parseCreateReportInput(base)).not.toHaveProperty("messageEvidence");
    expect(parseCreateReportInput({
      ...base,
      messageEvidence: {
        source: "message_link",
        status: "unavailable",
        attemptedAt: "2026-07-20T00:01:00.000Z"
      }
    })).toMatchObject({ messageEvidence: { status: "unavailable" } });
  });

  it("creates lookup indexes for captured message and author IDs", async () => {
    const queries: string[] = [];
    const database = new Database("postgres://unused");
    (database as unknown as { pool: unknown }).pool = {
      query: (sql: string) => {
        queries.push(sql);
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
    };

    await database.migrate();

    const schema = queries.join("\n");
    expect(schema).toContain("reports_message_author_id_idx");
    expect(schema).toContain("{messageEvidence,snapshot,authorId}");
    expect(schema).toContain("reports_message_id_idx");
    expect(schema).toContain("{messageEvidence,snapshot,messageId}");
  });

  it("accepts a validated resolved-user snapshot without requiring a schema migration", () => {
    const input = parseCreateReportInput({
      country: "DE",
      flow: "user_urf",
      reportReason: "The profile contains hateful content.",
      reportType: "sub_other_hate_speech",
      reportedUsername: "example",
      reportedUserId: "123456789012345678",
      reportedUserSnapshot: {
        userId: "123456789012345678",
        username: "example",
        globalDisplayName: "Example Display",
        avatarUrl: "https://cdn.discordapp.com/avatar.png",
        bannerUrl: "https://cdn.discordapp.com/banner.png",
        bot: false,
        resolvedAt: "2026-07-20T00:00:00.000Z"
      },
      profileElements: ["name"]
    });
    expect(input).toMatchObject({
      reportedUserId: "123456789012345678",
      reportedUsername: "example"
    });
    expect(() =>
      parseCreateReportInput({
        ...input,
        reportedUserId: "223456789012345678"
      })
    ).toThrow(/must match reportedUserId/);
    expect(() =>
      parseCreateReportInput({
        ...input,
        reportedUsername: "different"
      })
    ).toThrow(/must match reportedUsername/);
    expect(() =>
      parseCreateReportInput({
        ...input,
        reportedUserId: undefined
      })
    ).toThrow(/reportedUserId/);
  });

  it("rejects final report text over 512 characters", () => {
    expect(() =>
      parseCreateReportInput({
        country: "DE",
        flow: "message_urf",
        reportReason: "The message contains hateful content.",
        reportType: "sub_other_hate_speech",
        messageUrl:
          "https://discord.com/channels/427067963137589258/427069953078853633/1414818522701369355",
        context: "x".repeat(513)
      })
    ).toThrow(/context/);
  });

  it("requires and bounds the user-facing report reason", () => {
    const base = {
      country: "DE",
      flow: "message_urf",
      reportType: "sub_other_hate_speech",
      messageUrl:
        "https://discord.com/channels/427067963137589258/427069953078853633/1414818522701369355"
    };
    expect(() => parseCreateReportInput(base)).toThrow(/reportReason/);
    expect(() =>
      parseCreateReportInput({ ...base, reportReason: "x".repeat(513) })
    ).toThrow(/reportReason/);
    expect(
      parseCreateReportInput({ ...base, reportReason: "  Evidence-based reason.  " })
        .reportReason
    ).toBe("Evidence-based reason.");
  });

  it("rotates the email alias without changing the pseudonym", () => {
    const identity = generateIdentity("DE", "reports.example.org");
    const retryEmail = generateEmailAlias(
      identity.displayName,
      identity.language,
      "reports.example.org"
    );
    expect(retryEmail).not.toBe(identity.email);
    expect(retryEmail).toMatch(
      /^[a-z0-9.]+\.[0-9a-hjkmnp-tv-z]{16}@reports\.example\.org$/
    );
  });

  it("validates retry ownership and blocks unsafe failure stages", () => {
    expect(VERIFICATION_EMAIL_TIMEOUT_SECONDS).toBe(60);
    expect(DISCORD_RECEIPT_TIMEOUT_SECONDS).toBe(120);
    expect(DISCORD_REVIEW_CONFIRMATION_TIMEOUT_SECONDS).toBe(120);
    expect(
      parseRetryReportInput({ submitterDiscordUserId: "1197857362942378017" })
    ).toEqual({ submitterDiscordUserId: "1197857362942378017", mode: "manual" });
    expect(
      parseRetryReportInput({
        submitterDiscordUserId: "1197857362942378017",
        mode: "automatic"
      })
    ).toEqual({ submitterDiscordUserId: "1197857362942378017", mode: "automatic" });
    expect(() =>
      parseRetryReportInput({
        submitterDiscordUserId: "1197857362942378017",
        mode: "unsafe"
      })
    ).toThrow(/mode/);
    expect(() =>
      parseRetryReportInput({ submitterDiscordUserId: "invalid" })
    ).toThrow(/Discord snowflake/);
    expect(
      parseRetryReportInput({
        submitterDiscordUserId: "1197857362942378017",
        reportReason: "A clearer replacement reason.",
        context: "A rewritten final report."
      })
    ).toEqual({
      submitterDiscordUserId: "1197857362942378017",
      mode: "manual",
      reportReason: "A clearer replacement reason.",
      context: "A rewritten final report."
    });
    expect(() =>
      parseRetryReportInput({
        submitterDiscordUserId: "1197857362942378017",
        reportReason: "x".repeat(513)
      })
    ).toThrow(/too long/);
    expect(
      isRetryableFailure("requesting_verification", "report_processing_failed", 1)
    ).toBe(true);
    expect(isRetryableFailure("awaiting_verification", "verification_email_timeout", 0)).toBe(
      true
    );
    expect(isRetryableFailure("submitting", "report_processing_failed", 1)).toBe(false);
    expect(isRetryableFailure("verifying", "ambiguous_submission_state", 1)).toBe(false);
    expect(isRetryableFailure("verifying", "report_processing_failed", 2)).toBe(true);
    expect(isRetryableFailure("verifying", "report_processing_failed", 50)).toBe(true);
  });

  it("expires only submitted reports still waiting for Discord receipt", () => {
    const deadline = new Date("2026-07-20T12:02:00.000Z");
    expect(
      shouldExpireDiscordReceipt(
        { status: "submitted", discord_status: null, receipt_deadline: deadline },
        deadline
      )
    ).toBe(true);
    expect(
      shouldExpireDiscordReceipt(
        { status: "submitted", discord_status: "received", receipt_deadline: deadline },
        deadline
      )
    ).toBe(false);
    expect(
      shouldExpireDiscordReceipt(
        { status: "failed", discord_status: null, receipt_deadline: deadline },
        deadline
      )
    ).toBe(false);
  });

  it("preserves an email that arrives before session persistence completes", () => {
    expect(statusAfterSessionPersistence("requesting_verification")).toBe(
      "awaiting_verification"
    );
    expect(statusAfterSessionPersistence("verification_received")).toBe(
      "verification_received"
    );
  });

  it("resends only inside the fixed verification window", () => {
    expect(VERIFICATION_EMAIL_RESEND_DELAYS_SECONDS).toEqual([20, 40]);
    const deadline = new Date("2026-07-20T12:01:00.000Z");
    expect(
      shouldResendVerification(
        { status: "awaiting_verification", session_state: "encrypted", verification_deadline: deadline },
        new Date("2026-07-20T12:00:40.000Z")
      )
    ).toBe(true);
    expect(
      shouldResendVerification(
        { status: "verification_received", session_state: "encrypted", verification_deadline: null },
        new Date("2026-07-20T12:00:40.000Z")
      )
    ).toBe(false);
    expect(
      shouldResendVerification(
        { status: "awaiting_verification", session_state: "encrypted", verification_deadline: deadline },
        deadline
      )
    ).toBe(false);
  });
});

describe("manual appeal retry", () => {
  const retryInput = {
    reportId: "report-1",
    submitterDiscordUserId: "123456789012345678",
    idempotencyKey: "appeal-retry:interaction-1"
  };

  it("requeues the retained encrypted review job without exposing its payload", async () => {
    const { database, queries } = reviewRetryDatabase();

    const result = await database.retryIneligibleReview(retryInput);

    expect(result.replayed).toBe(false);
    expect(result.report.review_status).toBe("queued");
    expect(JSON.stringify(result)).not.toContain("encrypted");
    expect(queries.some((sql) => sql.includes("SET state = 'pending'") && sql.includes("attempts = 0")))
      .toBe(true);
    expect(queries.some((sql) => sql.includes("INSERT INTO report_events"))).toBe(true);
  });

  it("returns an idempotent replay without requeueing the job again", async () => {
    const { database, queries } = reviewRetryDatabase({
      report: reviewReport({
        review_status: "queued",
        review_retry_requested_at: new Date()
      }),
      acceptedKeys: [retryInput.idempotencyKey]
    });

    const result = await database.retryIneligibleReview(retryInput);

    expect(result).toMatchObject({ replayed: true, report: { id: "report-1" } });
    expect(queries.some((sql) => sql.includes("UPDATE report_jobs"))).toBe(false);
  });

  it("recognizes a delayed replay after a newer retry was accepted", async () => {
    const oldInput = { ...retryInput, idempotencyKey: "appeal-retry:interaction-old" };
    const { database, queries } = reviewRetryDatabase({
      report: reviewReport({
        review_status: "queued",
        review_retry_requested_at: new Date()
      }),
      acceptedKeys: [oldInput.idempotencyKey, "appeal-retry:interaction-new"]
    });

    await expect(database.retryIneligibleReview(oldInput)).resolves.toMatchObject({
      replayed: true,
      report: { id: "report-1" }
    });
    expect(queries.some((sql) => sql.includes("UPDATE report_jobs"))).toBe(false);
  });

  it.each([
    [
      "report_owner_mismatch",
      reviewReport({ submitter_discord_user_id: "999999999999999999" }),
      retryInput
    ],
    [
      "review_not_ineligible",
      reviewReport({ review_status: "request_ambiguous" }),
      retryInput
    ],
    [
      "review_retry_cooldown",
      reviewReport({
        review_retry_requested_at: new Date()
      }),
      retryInput
    ]
  ] as const)("rejects %s without mutating the job", async (code, report, input) => {
    const { database, queries } = reviewRetryDatabase({ report });

    await expect(database.retryIneligibleReview(input)).rejects.toMatchObject({
      name: "ReviewRetryError",
      code
    } satisfies Partial<ReviewRetryError>);
    expect(queries.some((sql) => sql.includes("UPDATE report_jobs"))).toBe(false);
  });

  it("rejects an ineligible report whose encrypted review job is unavailable", async () => {
    const { database } = reviewRetryDatabase({ retainedJob: false });

    await expect(database.retryIneligibleReview(retryInput)).rejects.toMatchObject({
      name: "ReviewRetryError",
      code: "review_retry_unavailable"
    } satisfies Partial<ReviewRetryError>);
  });

  it("rejects a retry while the retained review job is still pending", async () => {
    const { database } = reviewRetryDatabase({ jobState: "pending" });

    await expect(database.retryIneligibleReview(retryInput)).rejects.toMatchObject({
      name: "ReviewRetryError",
      code: "review_retry_unavailable"
    } satisfies Partial<ReviewRetryError>);
  });

  it("accepts a retry after the cooldown expires", async () => {
    const { database } = reviewRetryDatabase({
      report: reviewReport({
        review_retry_requested_at: new Date(Date.now() - 31_000)
      })
    });

    await expect(database.retryIneligibleReview(retryInput)).resolves.toMatchObject({
      replayed: false,
      report: { review_status: "queued" }
    });
  });

  it("rejects a missing report", async () => {
    const { database } = reviewRetryDatabase({ report: null });

    await expect(database.retryIneligibleReview(retryInput)).rejects.toMatchObject({
      name: "ReviewRetryError",
      code: "report_not_found"
    } satisfies Partial<ReviewRetryError>);
  });

  it("preserves the ineligibility retry marker across unrelated transient retries", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 1 });
    const database = new Database("postgres://unused");
    (database as unknown as { pool: unknown }).pool = { query };

    await database.retryJob(
      {
        id: "job-1",
        report_id: "report-1",
        kind: "submit_review",
        payload: { ineligibleRetryPending: true },
        attempts: 2,
        max_attempts: 3
      },
      "Temporary connection to Discord failed.",
      20
    );

    const sql = String(query.mock.calls[0]?.[0]);
    expect(sql).not.toContain("ineligibleRetryPending");
  });
});

describe("manual appeal retry API", () => {
  const config: AppConfig = {
    apiKey: "a".repeat(32),
    databaseUrl: "postgres://unused",
    emailDomain: "reports.example.org",
    environment: "test",
    port: 3000,
    proxyUrlTemplate: "http://proxy.example/{country}/{session}",
    sessionEncryptionKey: Buffer.alloc(32, 7),
    webhookSecret: "w".repeat(32),
    workerEnabled: false
  };

  it("makes a terminally ineligible appeal resubmittable instead of appeal-retryable", async () => {
    const ineligible = reviewReport({ review_status: "ineligible" });
    const database = {
      getReport: () => Promise.resolve(ineligible),
      getReportEvents: () => Promise.resolve([])
    } as unknown as Database;
    const server = await buildServer(config, database);

    const response = await server.inject({
      method: "GET",
      url: "/v1/reports/report-1",
      headers: { authorization: `Bearer ${config.apiKey}` }
    });
    await server.close();

    expect(response.json()).toMatchObject({
      reviewStatus: "ineligible",
      appealRetryable: false,
      resubmittable: true
    });
  });

  it.each([
    [false, 202],
    [true, 200]
  ])("returns the queued report when replayed is %s", async (replayed, statusCode) => {
    let acceptedInput: unknown;
    const queued = reviewReport({
      review_status: "queued",
      review_error_code: null,
      review_error_message: null
    });
    const database = {
      retryIneligibleReview: (input: unknown) => {
        acceptedInput = input;
        return Promise.resolve({ replayed, report: queued });
      },
      getReportEvents: () => Promise.resolve([])
    } as unknown as Database;
    const server = await buildServer(config, database);

    const response = await server.inject({
      method: "POST",
      url: "/v1/reports/report-1/retry-appeal",
      headers: {
        authorization: `Bearer ${config.apiKey}`,
        "idempotency-key": "appeal-retry:interaction-1"
      },
      payload: { submitterDiscordUserId: "123456789012345678" }
    });
    await server.close();

    expect(response.statusCode).toBe(statusCode);
    expect(response.json()).toMatchObject({
      internalReportId: "report-1",
      reviewStatus: "queued",
      appealRetryable: false
    });
    expect(acceptedInput).toEqual({
      reportId: "report-1",
      submitterDiscordUserId: "123456789012345678",
      idempotencyKey: "appeal-retry:interaction-1"
    });
  });

  it.each([
    ["report_not_found", 404],
    ["report_owner_mismatch", 403],
    ["review_not_ineligible", 409],
    ["review_retry_unavailable", 409],
    ["review_retry_cooldown", 409]
  ] as const)("maps %s without leaking the retained link", async (code, statusCode) => {
    const database = {
      retryIneligibleReview: () =>
        Promise.reject(new ReviewRetryError(code))
    } as unknown as Database;
    const server = await buildServer(config, database);

    const response = await server.inject({
      method: "POST",
      url: "/v1/reports/report-1/retry-appeal",
      headers: {
        authorization: `Bearer ${config.apiKey}`,
        "idempotency-key": "appeal-retry:interaction-1"
      },
      payload: { submitterDiscordUserId: "999999999999999999" }
    });
    await server.close();

    expect(response.statusCode).toBe(statusCode);
    expect(response.json()).toMatchObject({ error: { code } });
    expect(response.body).not.toContain("encrypted");
  });
});

describe("analytics API", () => {
  const config: AppConfig = {
    apiKey: "a".repeat(32),
    databaseUrl: "postgres://unused",
    emailDomain: "reports.example.org",
    environment: "test",
    port: 3000,
    proxyUrlTemplate: "http://proxy.example/{country}/{session}",
    sessionEncryptionKey: Buffer.alloc(32, 7),
    webhookSecret: "w".repeat(32),
    workerEnabled: false
  };
  const available = {
    availability: "available",
    scope: "personal",
    interval: {
      period: "7d",
      startAt: "2026-08-04T00:00:00.000Z",
      endAt: "2026-08-11T00:00:00.000Z",
      asOf: "2026-08-11T00:00:00.000Z",
      timezone: "UTC"
    }
  };

  it("serves authenticated personal analytics and owner-scoped action history", async () => {
    const reportAnalytics = vi.fn().mockResolvedValue(available);
    const actionHistory = vi.fn().mockResolvedValue({
      interval: available.interval,
      items: [],
      nextCursor: null
    });
    const database = { reportAnalytics, actionHistory } as unknown as Database;
    const server = await buildServer(config, database);
    const headers = { authorization: `Bearer ${config.apiKey}` };

    const analytics = await server.inject({
      method: "GET",
      url: "/v1/users/1197857362942378017/analytics?period=7d",
      headers
    });
    const history = await server.inject({
      method: "GET",
      url: "/v1/users/1197857362942378017/action-history?period=7d&limit=10",
      headers
    });
    await server.close();

    expect(analytics.statusCode).toBe(200);
    expect(history.statusCode).toBe(200);
    expect(reportAnalytics).toHaveBeenCalledWith("1197857362942378017", "7d");
    expect(actionHistory).toHaveBeenCalledWith(expect.objectContaining({
      discordUserId: "1197857362942378017",
      limit: 10,
      after: null
    }));
  });

  it("serves exact-range analytics and personal digest activity", async () => {
    const reportAnalyticsForInterval = vi.fn().mockResolvedValue(available);
    const digestActivity = vi.fn().mockResolvedValue({ eligible: true });
    const database = { reportAnalyticsForInterval, digestActivity } as unknown as Database;
    const server = await buildServer(config, database);
    const range = "startAt=2026-08-03T00%3A00%3A00.000Z&endAt=2026-08-10T00%3A00%3A00.000Z";
    const headers = { authorization: `Bearer ${config.apiKey}` };

    const analytics = await server.inject({
      method: "GET",
      url: `/v1/users/1197857362942378017/analytics?${range}`,
      headers
    });
    const activity = await server.inject({
      method: "GET",
      url: `/v1/users/1197857362942378017/digest-activity?${range}`,
      headers
    });
    await server.close();

    expect(analytics.statusCode).toBe(200);
    expect(activity.statusCode).toBe(200);
    expect(reportAnalyticsForInterval).toHaveBeenCalledWith(
      "1197857362942378017",
      expect.objectContaining({ period: "custom" })
    );
    expect(digestActivity).toHaveBeenCalledWith(
      "1197857362942378017",
      new Date("2026-08-03T00:00:00.000Z"),
      new Date("2026-08-10T00:00:00.000Z")
    );
  });

  it.each([
    "/v1/users/not-a-snowflake/action-history?period=7d",
    "/v1/users/1197857362942378017/analytics?period=quarter",
    "/v1/users/1197857362942378017/action-history?startAt=2026-08-01T00%3A00%3A00.000Z",
    "/v1/users/1197857362942378017/action-history?startAt=2026-08-02T00%3A00%3A00.000Z&endAt=2026-08-01T00%3A00%3A00.000Z",
    "/v1/users/1197857362942378017/action-history?period=7d&after=invalid",
    "/v1/users/1197857362942378017/action-history?period=7d&limit=26"
  ])("rejects an invalid analytics query without database work: %s", async (url) => {
    const reportAnalytics = vi.fn();
    const actionHistory = vi.fn();
    const database = { reportAnalytics, actionHistory } as unknown as Database;
    const server = await buildServer(config, database);

    const response = await server.inject({
      method: "GET",
      url,
      headers: { authorization: `Bearer ${config.apiKey}` }
    });
    await server.close();

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: { code: "invalid_analytics_query", message: "Invalid analytics query." }
    });
    expect(reportAnalytics).not.toHaveBeenCalled();
    expect(actionHistory).not.toHaveBeenCalled();
  });
});

describe("backend secrets and inbound email", () => {
  it("suppresses duplicate and out-of-order Discord status updates", () => {
    expect(shouldApplyDiscordStatus(null, "received")).toBe(true);
    expect(shouldApplyDiscordStatus("received", "received")).toBe(false);
    expect(shouldApplyDiscordStatus("received", "actioned")).toBe(true);
    expect(shouldApplyDiscordStatus("actioned", "received")).toBe(false);
    expect(shouldApplyDiscordStatus("closed_no_action", "review_not_approved")).toBe(true);
    expect(shouldApplyDiscordStatus("closed_no_action", "actioned")).toBe(true);
    expect(shouldApplyDiscordStatus("review_not_approved", "closed_no_action")).toBe(false);
  });

  it("encrypts persisted secrets and authenticates raw email", () => {
    const key = randomBytes(32);
    const encrypted = encryptJson({ code: "ABC123" }, key);
    expect(encrypted).not.toContain("ABC123");
    expect(decryptJson<{ code: string }>(encrypted, key)).toEqual({ code: "ABC123" });

    const raw = Buffer.from("Subject: Discord code\r\n\r\nYour code is ABC123");
    const timestamp = "1800000000";
    const signature = signInboundEmail(
      "a".repeat(32),
      timestamp,
      "ticket.0123456789abcdef@example.org",
      "message-1",
      raw
    );
    expect(
      verifyInboundSignature({
        secret: "a".repeat(32),
        timestamp,
        recipient: "ticket.0123456789abcdef@example.org",
        messageId: "message-1",
        rawEmail: raw,
        signature,
        now: 1_800_000_000_000
      })
    ).toBe(true);
  });

  it("signs lifecycle webhook payloads deterministically", () => {
    const signature = signReportEvent("s".repeat(32), "1800000000", "42", "{\"eventId\":\"42\"}");
    expect(signature).toMatch(/^[a-f0-9]{64}$/);
    expect(signature).toBe(
      signReportEvent("s".repeat(32), "1800000000", "42", "{\"eventId\":\"42\"}")
    );
  });

  it("extracts one repeated Discord verification code", async () => {
    const raw = Buffer.from(
      "From: Discord <noreply@discord.com>\r\n" +
        "Subject: Your verification code is Z8RYMD\r\n" +
        "Content-Type: text/plain\r\n\r\nUse Z8RYMD to continue."
    );
    await expect(extractVerificationCode(raw)).resolves.toBe("Z8RYMD");
  });

  it("prefers the Discord subject key over CSS hexadecimal values", async () => {
    const raw = Buffer.from(
      "From: Discord <noreply@discord.com>\r\n" +
        "Subject: Your one-time verification key is ZX7KMH\r\n" +
        "Content-Type: multipart/alternative; boundary=discord-boundary\r\n\r\n" +
        "--discord-boundary\r\nContent-Type: text/plain\r\n\r\n" +
        "Your verification key is ZX7KMH.\r\n" +
        "--discord-boundary\r\nContent-Type: text/html\r\n\r\n" +
        "<style>.button{color:#2E3338;background:#4F5660}</style>" +
        "<p>Your verification key is <strong>ZX7KMH</strong>.</p>\r\n" +
        "--discord-boundary--"
    );
    await expect(extractVerificationCode(raw)).resolves.toBe("ZX7KMH");
  });

  it("extracts a letter-only Discord verification key from the exact subject", async () => {
    const raw = Buffer.from(
      "From: Discord <noreply@discord.com>\r\n" +
        "Subject: Your one-time verification key is STLGSY\r\n" +
        "Content-Type: text/plain\r\n\r\nYour verification key is STLGSY."
    );
    await expect(extractVerificationCode(raw)).resolves.toBe("STLGSY");
  });

  it.each([
    "Dein einmaliger VerifizierungsschlÃ¼ssel lautet STLGSY",
    "=?UTF-8?Q?Dein_einmaliger_Verifizierungsschl=C3=BCssel_lautet_STLGSY?="
  ])("extracts a German Discord verification key from %s", async (subject) => {
    const raw = Buffer.from(
      "From: Discord <noreply@discord.com>\r\n" +
        `Subject: ${subject}\r\n` +
        "Content-Type: text/plain\r\n\r\n" +
        "Gib dafÃ¼r diesen Verifizierungscode im Meldeformular ein."
    );
    await expect(extractVerificationCode(raw)).resolves.toBe("STLGSY");
  });

  it("uses a contextual body phrase when the subject has no code", async () => {
    const raw = Buffer.from(
      "From: Discord <noreply@discord.com>\r\n" +
        "Subject: Verify your report\r\n" +
        "Content-Type: text/plain\r\n\r\nYour verification code is ab12cd."
    );
    await expect(extractVerificationCode(raw)).resolves.toBe("AB12CD");
  });

  it("does not treat ordinary six-letter words as verification codes", async () => {
    const raw = Buffer.from(
      "Subject: Please verify\r\nContent-Type: text/plain\r\n\r\nFollow normal instructions."
    );
    await expect(extractVerificationCode(raw)).resolves.toBeUndefined();
  });

  it.each(["QWERTY", "AB12CD."])(
    "accepts trusted Discord subject-ending verification token %s",
    async (token) => {
      const expected = token.replace(".", "");
      const raw = Buffer.from(
        "From: Discord <noreply@discord.com>\r\n" +
          `Subject: ModÃ¨le de vÃ©rification ${token}\r\n` +
          "Content-Type: text/plain\r\n\r\nComplete verification."
      );
      await expect(parseDiscordEmail(raw)).resolves.toEqual({
        kind: "verification",
        code: expected
      });
    }
  );

  it.each([
    ["alerts@example.org", "Unknown template QWERTY"],
    ["noreply@discord.com", "Unknown template qwerty"],
    ["noreply@discord.com", "Unknown template 123456"]
  ])("rejects unsafe subject-ending token from %s", async (sender, subject) => {
    const raw = Buffer.from(
      `From: Sender <${sender}>\r\nSubject: ${subject}\r\n` +
        "Content-Type: text/plain\r\n\r\nComplete verification."
    );
    await expect(parseDiscordEmail(raw)).resolves.toBeUndefined();
  });

  it("classifies and sanitizes an unmatched Discord lifecycle email", async () => {
    const raw = Buffer.from(
      "From: Discord <noreply@discord.com>\r\n" +
        "Subject: Discord report received: #1527695430949798110\r\n" +
        "Content-Type: text/plain\r\n\r\n" +
        "Reference ABC123 was sent to reporter@example.org."
    );
    await expect(inspectDiscordEmail(raw)).resolves.toEqual({
      kind: "ignored",
      diagnostic: {
        classification: "discord_lifecycle_subject_unmatched",
        senderAddresses: ["noreply@discord.com"],
        subject: "Discord report received: #1527695430949798110",
        textPreview: "Reference [redacted-code] was sent to [redacted-email]."
      }
    });
  });

  it("classifies a non-Discord sender without exposing body email addresses", async () => {
    const raw = Buffer.from(
      "From: Example <alerts@example.org>\r\n" +
        "Subject: Verify your report\r\n" +
        "Content-Type: text/plain\r\n\r\nContact private@example.org."
    );
    await expect(inspectDiscordEmail(raw)).resolves.toMatchObject({
      kind: "ignored",
      diagnostic: {
        classification: "non_discord_sender",
        senderAddresses: ["alerts@example.org"],
        textPreview: "Contact [redacted-email]."
      }
    });
  });

  it.each([
    {
      subject: "Report Received #1527695430949798110",
      text: "Your report reference number is #1527695430949798110.",
      status: "received"
    },
    {
      subject: "Report Actioned #1262026288437268564",
      text: "We reviewed your report and took action on the content.",
      status: "actioned"
    },
    {
      subject: "Report Closed #1527695430949798110",
      text: "We decided not to take action on the content in your report.",
      status: "closed_no_action"
    },
    {
      subject: "Report Closed #1450081430846574719",
      text: "We reviewed your report review request for report 1450081430846574719 and decided not to take action.",
      status: "review_not_approved"
    }
  ])("parses Discord lifecycle status $status", async ({ subject, text, status }) => {
    const reportId = subject.match(/\d{15,22}/)?.[0];
    const raw = Buffer.from(
      `From: Discord <noreply@discord.com>\r\nSubject: ${subject}\r\n` +
        `Content-Type: text/plain\r\n\r\n${text}`
    );
    await expect(parseDiscordEmail(raw)).resolves.toEqual({
      kind: "report_update",
      reportId,
      status
    });
  });

  it("extracts the tracked review link only from an eligible original closure", async () => {
    const raw = Buffer.from(
      "From: Discord <noreply@discord.com>\r\n" +
        "Subject: Report Closed #1510655259763019999\r\n" +
        "Content-Type: text/plain\r\n\r\n" +
        "We decided not to take action. If you think we made a mistake, you can request " +
        "we review this decision by clicking here: " +
        "https://click.discord.com/ls/click?upn=opaque-review-link"
    );

    await expect(parseDiscordEmail(raw)).resolves.toEqual({
      kind: "report_update",
      reportId: "1510655259763019999",
      status: "closed_no_action",
      reviewUrl: "https://click.discord.com/ls/click?upn=opaque-review-link"
    });
  });

  it("prefers the HTML review anchor when the plain-text tracking URL is corrupted", async () => {
    const raw = Buffer.from(
      "From: Discord <noreply@discord.com>\r\n" +
        "Subject: Report Closed #1510655259763019999\r\n" +
        'Content-Type: multipart/alternative; boundary="review-boundary"\r\n\r\n' +
        "--review-boundary\r\n" +
        "Content-Type: text/plain; charset=utf-8\r\n\r\n" +
        "If you think we made a mistake, you can request we review this decision by " +
        "clicking here: https://click.discord.com/ls/click?upn=corrupted-text-link\r\n" +
        "--review-boundary\r\n" +
        "Content-Type: text/html; charset=utf-8\r\n\r\n" +
        "<p>If you think we made a mistake, you can request we review this decision by " +
        'clicking <a href="https://click.discord.com/ls/click?upn=valid-html-link">' +
        "here</a>.</p>\r\n" +
        "--review-boundary--\r\n"
    );

    await expect(parseDiscordEmail(raw)).resolves.toEqual({
      kind: "report_update",
      reportId: "1510655259763019999",
      status: "closed_no_action",
      reviewUrl: "https://click.discord.com/ls/click?upn=valid-html-link"
    });
  });

  it("parses the review-request confirmation separately from the final decision", async () => {
    const raw = Buffer.from(
      "From: Discord <noreply@discord.com>\r\n" +
        "Subject: Report Review Request Received #1510655259763019999\r\n" +
        "Content-Type: text/plain\r\n\r\n" +
        "We have received the review request you filed for report #1510655259763019999."
    );

    await expect(parseDiscordEmail(raw)).resolves.toEqual({
      kind: "review_update",
      reportId: "1510655259763019999",
      status: "received"
    });
  });
});
