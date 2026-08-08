import { Buffer } from "node:buffer";

import { DiscordDsaHttpError, DiscordDsaNetworkError } from "@discord-dsa/client";
import type * as DiscordDsaClientModule from "@discord-dsa/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AppConfig } from "../src/config.js";
import type { Database, JobRow, ReportRow } from "../src/database.js";
import { encryptJson } from "../src/security.js";

const clientState = vi.hoisted(() => ({
  options: [] as Array<Record<string, unknown>>,
  sendEmailCode: vi.fn(() => Promise.resolve(undefined)),
  snapshotSession: vi.fn(() =>
    Promise.resolve({
      fingerprint: "test-fingerprint",
      cookies: '{"cookies":[]}'
    })
  ),
  bootstrapFingerprint: vi.fn(() => Promise.resolve("test-fingerprint")),
  resolveReportReviewToken: vi.fn(() => Promise.resolve("review-token")),
  submitReportReviewToken: vi.fn(() =>
    Promise.resolve({ report_id: "discord-report-1" })
  ),
  verifyEmailCode: vi.fn(() => Promise.resolve("email-token")),
  getMenu: vi.fn(() => Promise.resolve({ version: 1, variant: "test", nodes: [] })),
  prepareSubmission: vi.fn(() => ({ name: "message_urf" })),
  submitPrepared: vi.fn(() => Promise.resolve({ report_id: "discord-report-1" })),
  close: vi.fn(() => Promise.resolve(undefined))
}));

vi.mock("@discord-dsa/client", async (importOriginal) => {
  const actual = await importOriginal<typeof DiscordDsaClientModule>();
  return {
    ...actual,
    DiscordDsaClient: class {
      public constructor(options: Record<string, unknown>) {
        clientState.options.push(options);
      }

      public sendEmailCode = clientState.sendEmailCode;
      public snapshotSession = clientState.snapshotSession;
      public bootstrapFingerprint = clientState.bootstrapFingerprint;
      public resolveReportReviewToken = clientState.resolveReportReviewToken;
      public submitReportReviewToken = clientState.submitReportReviewToken;
      public verifyEmailCode = clientState.verifyEmailCode;
      public getMenu = clientState.getMenu;
      public prepareSubmission = clientState.prepareSubmission;
      public submitPrepared = clientState.submitPrepared;
      public close = clientState.close;
    }
  };
});

import { JobRunner } from "../src/job-runner.js";

const config: AppConfig = {
  apiKey: "a".repeat(32),
  databaseUrl: "postgres://example",
  emailDomain: "reports.example.org",
  environment: "test",
  port: 3000,
  proxyUrlTemplate: "http://proxy.example/{country}/{session}",
  sessionEncryptionKey: Buffer.alloc(32, 7),
  webhookSecret: "w".repeat(32),
  workerEnabled: true
};

function report(overrides: Partial<ReportRow> = {}): ReportRow {
  return {
    id: "report-1",
    flow: "message_urf",
    country: "DE",
    reporter_email: "reporter@example.org",
    timezone: "Europe/Berlin",
    locale: "de-DE",
    language: "de",
    proxy_session_id: "111111111111",
    status: "requesting_verification",
    session_state: null,
    discord_report_id: null,
    input: {
      country: "DE",
      flow: "message_urf",
      reportReason: "Threatening message.",
      reportType: "threatening_behavior",
      messageUrl: "https://discord.com/channels/@me/1/2"
    },
    ...overrides
  } as ReportRow;
}

function job(overrides: Partial<JobRow> = {}): JobRow {
  return {
    id: "job-1",
    report_id: "report-1",
    kind: "request_code",
    payload: {},
    attempts: 1,
    max_attempts: 3,
    ...overrides
  };
}

function logger() {
  return {
    info: vi.fn<(data: Record<string, unknown>, message: string) => void>(),
    error: vi.fn<(data: Record<string, unknown>, message: string) => void>()
  };
}

describe("JobRunner proxy rotation", () => {
  beforeEach(() => {
    clientState.options.length = 0;
    vi.clearAllMocks();
    clientState.bootstrapFingerprint.mockResolvedValue("test-fingerprint");
    clientState.resolveReportReviewToken.mockResolvedValue("review-token");
    clientState.submitReportReviewToken.mockResolvedValue({
      report_id: "discord-report-1"
    });
    clientState.sendEmailCode.mockResolvedValue(undefined);
    clientState.snapshotSession.mockResolvedValue({
      fingerprint: "test-fingerprint",
      cookies: '{"cookies":[]}'
    });
    clientState.verifyEmailCode.mockResolvedValue("email-token");
    clientState.getMenu.mockResolvedValue({ version: 1, variant: "test", nodes: [] });
    clientState.prepareSubmission.mockReturnValue({ name: "message_urf" });
    clientState.submitPrepared.mockResolvedValue({ report_id: "discord-report-1" });
    clientState.close.mockResolvedValue(undefined);
  });

  it("uses and persists a fresh same-country proxy session on a verification retry", async () => {
    let savedProxySessionId: string | undefined;
    const database = {
      getReport: () => Promise.resolve(report()),
      setStatus: () => Promise.resolve(undefined),
      saveAwaitingVerification: (
        _reportId: string,
        _encryptedSession: string,
        proxySessionId: string
      ) => {
        savedProxySessionId = proxySessionId;
        return Promise.resolve(undefined);
      },
      retryJob: (_job: JobRow, message: string) =>
        Promise.reject(new Error(`unexpected retry: ${message}`)),
      completeJob: () => Promise.resolve(undefined)
    } as unknown as Database;
    const runner = new JobRunner(database, config, logger());

    await (runner as unknown as { processJob(value: JobRow): Promise<void> }).processJob(
      job({ attempts: 2 })
    );

    expect(savedProxySessionId).toMatch(/^\d{12}$/);
    expect(savedProxySessionId).not.toBe("111111111111");
    expect(clientState.options[0]?.proxyUrl).toBe(
      `http://proxy.example/DE/${savedProxySessionId}`
    );
  });

  it("uses the report's original proxy session for the first verification attempt", async () => {
    let savedProxySessionId: string | undefined;
    const database = {
      getReport: () => Promise.resolve(report()),
      setStatus: () => Promise.resolve(undefined),
      saveAwaitingVerification: (
        _reportId: string,
        _encryptedSession: string,
        proxySessionId: string
      ) => {
        savedProxySessionId = proxySessionId;
        return Promise.resolve(undefined);
      },
      completeJob: () => Promise.resolve(undefined)
    } as unknown as Database;
    const runner = new JobRunner(database, config, logger());

    await (runner as unknown as { processJob(value: JobRow): Promise<void> }).processJob(
      job({ attempts: 1 })
    );

    expect(savedProxySessionId).toBe("111111111111");
    expect(clientState.options[0]?.proxyUrl).toBe(
      "http://proxy.example/DE/111111111111"
    );
  });

  it("keeps verification resends on the persisted sticky proxy session", async () => {
    const database = {
      getReport: () =>
        Promise.resolve(report({
          status: "awaiting_verification",
          session_state: encryptJson(
            { fingerprint: "test-fingerprint", cookies: '{"cookies":[]}' },
            config.sessionEncryptionKey
          ),
          verification_deadline: new Date(Date.now() + 30_000)
        })),
      saveResentVerificationSession: () => Promise.resolve(true),
      completeJob: () => Promise.resolve(undefined)
    } as unknown as Database;
    const runner = new JobRunner(database, config, logger());

    await (runner as unknown as { processJob(value: JobRow): Promise<void> }).processJob(
      job({ payload: { resend: true, resendNumber: 1 }, max_attempts: 1 })
    );

    expect(clientState.options[0]).toMatchObject({
      proxyUrl: "http://proxy.example/DE/111111111111",
      sessionState: {
        fingerprint: "test-fingerprint",
        cookies: '{"cookies":[]}'
      }
    });
  });

  it("preflights an appeal proxy before submission and schedules a network retry", async () => {
    const operations: string[] = [];
    clientState.bootstrapFingerprint.mockImplementation(() => {
      operations.push("preflight");
      return Promise.resolve("test-fingerprint");
    });
    clientState.resolveReportReviewToken.mockImplementation(() => {
      operations.push("resolve");
      return Promise.resolve("review-token");
    });
    clientState.submitReportReviewToken.mockImplementation(() => {
      operations.push("submit");
      return Promise.reject(new DiscordDsaNetworkError("network failed"));
    });
    clientState.close.mockImplementation(() => {
      operations.push("close");
      return Promise.resolve(undefined);
    });
    let retryDelay: number | undefined;
    const database = {
      getReport: () =>
        Promise.resolve(report({
          status: "submitted",
          discord_report_id: "discord-report-1",
          review_status: "queued"
        })),
      retryJob: (_job: JobRow, _message: string, delaySeconds: number) => {
        retryDelay = delaySeconds;
        return Promise.resolve(undefined);
      }
    } as unknown as Database;
    const attemptLogger = logger();
    const runner = new JobRunner(database, config, attemptLogger);
    const reviewJob = job({
      kind: "submit_review",
      payload: {
        encryptedReviewUrl: encryptJson(
          { reviewUrl: "https://discord.com/report-review#token=review-token" },
          config.sessionEncryptionKey
        )
      },
      attempts: 1
    });

    await (runner as unknown as { processJob(value: JobRow): Promise<void> }).processJob(
      reviewJob
    );

    expect(operations).toEqual(["preflight", "resolve", "submit", "close"]);
    expect(retryDelay).toBe(10);
    expect(clientState.options[0]?.fingerprintMaxAttempts).toBe(1);
    expect(clientState.options[0]?.proxyUrl).toMatch(
      /^http:\/\/proxy\.example\/DE\/\d{12}$/
    );
    const proxySessionId = String(clientState.options[0]?.proxyUrl).split("/").at(-1);
    expect(JSON.stringify(attemptLogger.info.mock.calls)).not.toContain(proxySessionId);
    expect(JSON.stringify(attemptLogger.error.mock.calls)).not.toContain(proxySessionId);
    expect(
      attemptLogger.info.mock.calls.map(([data]) => data).find(
        (data) => data.event === "proxy_rotation_scheduled"
      )
    ).toMatchObject({ stage: "submit_report_review" });
  });

  it("treats Discord code 521002 as a successfully requested appeal", async () => {
    clientState.submitReportReviewToken.mockRejectedValue(
      new DiscordDsaHttpError("already requested", 400, {
        responseSummary: "code 521002; DSA_RSL_ALREADY_REQUESTED"
      })
    );
    let markedRequested = false;
    let markedFailed = false;
    const database = {
      getReport: () =>
        Promise.resolve(report({
          status: "submitted",
          discord_report_id: "discord-report-1",
          review_status: "queued"
        })),
      markReviewRequested: () => {
        markedRequested = true;
        return Promise.resolve(undefined);
      },
      failReviewRequest: () => {
        markedFailed = true;
        return Promise.resolve(undefined);
      },
      completeJob: () => Promise.resolve(undefined)
    } as unknown as Database;
    const convergenceLogger = logger();
    const runner = new JobRunner(database, config, convergenceLogger);

    await (runner as unknown as { processJob(value: JobRow): Promise<void> }).processJob(
      job({
        kind: "submit_review",
        attempts: 2,
        payload: {
          encryptedReviewUrl: encryptJson(
            { reviewUrl: "https://discord.com/report-review#token=review-token" },
            config.sessionEncryptionKey
          )
        }
      })
    );

    expect(markedRequested).toBe(true);
    expect(markedFailed).toBe(false);
    expect(
      convergenceLogger.info.mock.calls.map(([data]) => data).find(
        (data) => data.event === "proxy_attempt_succeeded"
      )
    ).toMatchObject({ attempt: 2, rotationCount: 1 });
  });

  it.each([
    [new DiscordDsaNetworkError("network failed"), true, "review_request_ambiguous"],
    [new DiscordDsaHttpError("server failed", 503), true, "review_request_ambiguous"],
    [new DiscordDsaHttpError("rate limited", 429), false, "review_request_failed"]
  ])(
    "persists the exhausted appeal outcome for %s",
    async (failure, expectedAmbiguous, expectedCode) => {
      clientState.submitReportReviewToken.mockRejectedValue(failure);
      let outcome: { ambiguous: boolean; code: string } | undefined;
      const database = {
        getReport: () =>
          Promise.resolve(report({
            status: "submitted",
            discord_report_id: "discord-report-1",
            review_status: "queued"
          })),
        failReviewRequest: (
          _reportId: string,
          ambiguous: boolean,
          code: string
        ) => {
          outcome = { ambiguous, code };
          return Promise.resolve(undefined);
        },
        completeJob: () => Promise.resolve(undefined)
      } as unknown as Database;
      const runner = new JobRunner(database, config, logger());

      await (runner as unknown as { processJob(value: JobRow): Promise<void> }).processJob(
        job({
          kind: "submit_review",
          attempts: 3,
          payload: {
            encryptedReviewUrl: encryptJson(
              { reviewUrl: "https://discord.com/report-review#token=review-token" },
              config.sessionEncryptionKey
            )
          }
        })
      );

      expect(outcome).toEqual({ ambiguous: expectedAmbiguous, code: expectedCode });
    }
  );

  it("honors Discord Retry-After when rotating an appeal proxy", async () => {
    clientState.submitReportReviewToken.mockRejectedValue(
      new DiscordDsaHttpError("rate limited", 429, { retryAfterSeconds: 17 })
    );
    let retryDelay: number | undefined;
    const database = {
      getReport: () =>
        Promise.resolve(report({
          status: "submitted",
          discord_report_id: "discord-report-1",
          review_status: "queued"
        })),
      retryJob: (_job: JobRow, _message: string, delaySeconds: number) => {
        retryDelay = delaySeconds;
        return Promise.resolve(undefined);
      }
    } as unknown as Database;
    const runner = new JobRunner(database, config, logger());

    await (runner as unknown as { processJob(value: JobRow): Promise<void> }).processJob(
      job({
        kind: "submit_review",
        payload: {
          encryptedReviewUrl: encryptJson(
            { reviewUrl: "https://discord.com/report-review#token=review-token" },
            config.sessionEncryptionKey
          )
        }
      })
    );

    expect(retryDelay).toBe(17);
  });

  it("preserves Discord code 521004 as an ineligible appeal", async () => {
    clientState.submitReportReviewToken.mockRejectedValue(
      new DiscordDsaHttpError("ineligible", 400, {
        responseSummary: "code 521004; DSA_RSL_REPORT_INELIGIBLE"
      })
    );
    let markedIneligible = false;
    const database = {
      getReport: () =>
        Promise.resolve(report({
          status: "submitted",
          discord_report_id: "discord-report-1",
          review_status: "queued"
        })),
      markReviewIneligible: () => {
        markedIneligible = true;
        return Promise.resolve(undefined);
      },
      completeJob: () => Promise.resolve(undefined)
    } as unknown as Database;
    const runner = new JobRunner(database, config, logger());

    await (runner as unknown as { processJob(value: JobRow): Promise<void> }).processJob(
      job({
        kind: "submit_review",
        payload: {
          encryptedReviewUrl: encryptJson(
            { reviewUrl: "https://discord.com/report-review#token=review-token" },
            config.sessionEncryptionKey
          )
        }
      })
    );

    expect(markedIneligible).toBe(true);
  });

  it("does not retry a terminal verification HTTP error", async () => {
    clientState.sendEmailCode.mockRejectedValue(new DiscordDsaHttpError("bad request", 400));
    let retried = false;
    let failed = false;
    const database = {
      getReport: () => Promise.resolve(report()),
      setStatus: () => Promise.resolve(undefined),
      retryJob: () => {
        retried = true;
        return Promise.resolve(undefined);
      },
      failJobAndReport: () => {
        failed = true;
        return Promise.resolve(undefined);
      }
    } as unknown as Database;
    const runner = new JobRunner(database, config, logger());

    await (runner as unknown as { processJob(value: JobRow): Promise<void> }).processJob(
      job()
    );

    expect(retried).toBe(false);
    expect(failed).toBe(true);
  });

  it("never retries an initial report after its final submission POST starts", async () => {
    clientState.submitPrepared.mockRejectedValue(
      new DiscordDsaNetworkError("submission connection lost")
    );
    let retried = false;
    let failed = false;
    const database = {
      getReport: () =>
        Promise.resolve(report({
          status: "verification_received",
          session_state: encryptJson(
            { fingerprint: "test-fingerprint", cookies: '{"cookies":[]}' },
            config.sessionEncryptionKey
          )
        })),
      setStatus: () => Promise.resolve(undefined),
      retryJob: () => {
        retried = true;
        return Promise.resolve(undefined);
      },
      failJobAndReport: () => {
        failed = true;
        return Promise.resolve(undefined);
      }
    } as unknown as Database;
    const runner = new JobRunner(database, config, logger());

    await (runner as unknown as { processJob(value: JobRow): Promise<void> }).processJob(
      job({
        kind: "verify_submit",
        payload: {
          encryptedCode: encryptJson({ code: "ABC123" }, config.sessionEncryptionKey)
        }
      })
    );

    expect(retried).toBe(false);
    expect(failed).toBe(true);
  });
});
