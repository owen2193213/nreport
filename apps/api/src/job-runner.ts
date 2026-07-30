import { setTimeout as delay } from "node:timers/promises";

import {
  DiscordDsaClient,
  DiscordDsaHttpError,
  DiscordDsaNetworkError,
  type DiscordDsaSessionState
} from "@discord-dsa/client";
import type { AppConfig } from "./config.js";
import {
  shouldResendVerification,
  type Database,
  type JobRow,
  type ReportRow
} from "./database.js";
import { buildAcceptLanguage, buildProxyUrl } from "./pseudonyms.js";
import { decryptJson, encryptJson } from "./security.js";
import { DISCORD_FORM_LANGUAGE, toReportDraft } from "./validation.js";

interface JobLogger {
  error(data: Record<string, unknown>, message: string): void;
  info(data: Record<string, unknown>, message: string): void;
}

class SessionNotReadyError extends Error {
  public constructor() {
    super("Discord session state is not ready yet.");
    this.name = "SessionNotReadyError";
  }
}

class ReviewSubmissionStartedError extends Error {
  public constructor(cause: unknown) {
    super("Discord review submission started but its local outcome could not be persisted.", {
      cause
    });
    this.name = "ReviewSubmissionStartedError";
  }
}

interface NetworkCauseDiagnostic {
  name: string;
  code?: string;
  syscall?: string;
  depth: number;
}

interface RedactedError {
  code: string;
  message: string;
  retryAfter?: number;
  networkCause?: NetworkCauseDiagnostic;
}

function safeDiagnosticValue(
  value: unknown,
  pattern: RegExp,
  maximumLength: number
): string | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const normalized = String(value).slice(0, maximumLength);
  return pattern.test(normalized) ? normalized : undefined;
}

function safeProperty(value: object, property: string): unknown {
  try {
    return (value as Record<string, unknown>)[property];
  } catch {
    return undefined;
  }
}

export function inspectNetworkCause(error: unknown): NetworkCauseDiagnostic | undefined {
  const visited = new Set<object>();
  let current = error;
  let fallback: NetworkCauseDiagnostic | undefined;
  for (let depth = 0; depth < 6 && typeof current === "object" && current !== null; depth += 1) {
    if (visited.has(current)) break;
    visited.add(current);

    const name =
      safeDiagnosticValue(safeProperty(current, "name"), /^[A-Za-z][A-Za-z0-9_.-]*$/, 80) ??
      "Error";
    const code = safeDiagnosticValue(
      safeProperty(current, "code"),
      /^[A-Za-z0-9_.-]+$/,
      80
    );
    const syscall = safeDiagnosticValue(
      safeProperty(current, "syscall"),
      /^[A-Za-z0-9_.-]+$/,
      40
    );
    const diagnostic = {
      name,
      ...(code === undefined ? {} : { code }),
      ...(syscall === undefined ? {} : { syscall }),
      depth
    };
    fallback ??= diagnostic;
    if (code !== undefined || syscall !== undefined) return diagnostic;
    current = safeProperty(current, "cause");
  }
  return fallback;
}

function redactedError(error: unknown): RedactedError {
  if (error instanceof DiscordDsaNetworkError) {
    const networkCause = inspectNetworkCause(error);
    return {
      code: "discord_network_error",
      message: "Temporary connection to Discord failed. Please retry this report.",
      ...(networkCause === undefined ? {} : { networkCause })
    };
  }
  if (error instanceof DiscordDsaHttpError) {
    const detail = error.responseSummary === undefined ? "" : `: ${error.responseSummary}`;
    return {
      code: `discord_http_${error.status}`,
      message: `Discord returned HTTP ${error.status}${detail}`.slice(0, 500),
      ...(error.retryAfterSeconds === undefined
        ? {}
        : { retryAfter: error.retryAfterSeconds })
    };
  }
  if (error instanceof Error) {
    return { code: "report_processing_failed", message: error.message.slice(0, 500) };
  }
  return { code: "report_processing_failed", message: "Unknown report processing error." };
}

export class JobRunner {
  private stopped = false;
  private runningPromise: Promise<void> | undefined;
  private nextTimeoutSweepAt = 0;

  public constructor(
    private readonly database: Database,
    private readonly config: AppConfig,
    private readonly logger: JobLogger
  ) {}

  public start(): void {
    if (this.runningPromise !== undefined) return;
    this.runningPromise = this.run();
  }

  public async stop(): Promise<void> {
    this.stopped = true;
    await this.runningPromise;
  }

  private async run(): Promise<void> {
    await this.database.recoverInterruptedJobs();
    while (!this.stopped) {
      try {
        if (Date.now() >= this.nextTimeoutSweepAt) {
          const expiredReportIds = await this.database.expireVerificationWaits();
          const expiredReceiptReportIds = await this.database.expireDiscordReceiptWaits();
          const expiredReviewReportIds =
            await this.database.expireReviewConfirmationWaits();
          this.nextTimeoutSweepAt = Date.now() + 5_000;
          for (const reportId of expiredReportIds) {
            this.logger.info(
              { event: "verification_wait_expired", reportId },
              "Verification email wait expired"
            );
          }
          for (const reportId of expiredReceiptReportIds) {
            this.logger.info(
              { event: "discord_receipt_wait_expired", reportId },
              "Discord receipt confirmation wait expired"
            );
          }
          for (const reportId of expiredReviewReportIds) {
            this.logger.info(
              { event: "review_confirmation_wait_expired", reportId },
              "Discord review confirmation email wait expired"
            );
          }
        }
        const job = await this.database.claimJob();
        if (!job) {
          await delay(750);
          continue;
        }
        await this.processJob(job);
      } catch (error) {
        this.logger.error({ error: redactedError(error) }, "Job loop failed");
        await delay(1_500);
      }
    }
  }

  private clientFor(report: ReportRow, sessionState?: DiscordDsaSessionState): DiscordDsaClient {
    const proxyUrl = buildProxyUrl(
      this.config.proxyUrlTemplate,
      report.country,
      report.proxy_session_id
    );
    if (proxyUrl === undefined) {
      throw new Error("DSA_PROXY_URL_TEMPLATE is not configured.");
    }
    return new DiscordDsaClient({
      proxyUrl,
      timezone: report.timezone,
      locale: report.locale,
      extraHeaders: {
        "accept-language": buildAcceptLanguage(report.locale, report.language)
      },
      ...(sessionState === undefined ? {} : { sessionState })
    });
  }

  private async processJob(job: JobRow): Promise<void> {
    const startedAt = Date.now();
    this.logger.info(
      {
        event: "report_job_started",
        jobId: job.id,
        reportId: job.report_id,
        jobKind: job.kind,
        attempt: job.attempts,
        resend: job.payload.resend === true
      },
      "Report job started"
    );
    try {
      if (job.kind === "request_code") {
        await this.requestCode(job);
      } else if (job.kind === "submit_review") {
        await this.submitReview(job);
      } else {
        await this.verifyAndSubmit(job);
      }
      await this.database.completeJob(job.id);
      this.logger.info(
        {
          event: "report_job_completed",
          jobId: job.id,
          reportId: job.report_id,
          jobKind: job.kind,
          durationMs: Date.now() - startedAt
        },
        "Report job completed"
      );
    } catch (error) {
      const redacted = redactedError(error);
      if (job.kind === "request_code" && job.payload.resend === true) {
        await this.database.completeJob(job.id);
        this.logger.error(
          {
            jobId: job.id,
            reportId: job.report_id,
            resendNumber: job.payload.resendNumber,
            errorCode: redacted.code,
            errorMessage: redacted.message,
            networkCause: redacted.networkCause,
            durationMs: Date.now() - startedAt,
            event: "verification_resend_failed"
          },
          "Verification email resend failed; original deadline remains active"
        );
        return;
      }
      if (error instanceof ReviewSubmissionStartedError) {
        let outcomePersisted = false;
        try {
          await this.database.failReviewRequest(
            job.report_id,
            true,
            "review_request_ambiguous",
            "Discord review request submission could not be confirmed."
          );
          outcomePersisted = true;
        } catch (persistenceError) {
          this.logger.error(
            {
              event: "review_ambiguity_persistence_failed",
              jobId: job.id,
              reportId: job.report_id,
              error: redactedError(persistenceError)
            },
            "Discord review request is ambiguous and its status could not be persisted"
          );
        }
        if (outcomePersisted) await this.database.completeJob(job.id);
        this.logger.error(
          {
            event: "review_request_ambiguous",
            jobId: job.id,
            reportId: job.report_id,
            errorCode: redacted.code,
            networkCause: redacted.networkCause,
            durationMs: Date.now() - startedAt
          },
          "Discord review request result is ambiguous; automatic retry is disabled"
        );
        return;
      }
      if (job.kind === "submit_review") {
        if (job.attempts < job.max_attempts) {
          const delaySeconds = Math.min(60, 2 ** job.attempts * 5);
          await this.database.retryJob(job, redacted.message, delaySeconds);
          this.logger.info(
            {
              event: "review_link_resolution_retry_scheduled",
              jobId: job.id,
              reportId: job.report_id,
              errorCode: redacted.code,
              networkCause: redacted.networkCause,
              delaySeconds,
              durationMs: Date.now() - startedAt
            },
            "Discord review link resolution retry scheduled"
          );
        } else {
          await this.database.failReviewRequest(
            job.report_id,
            false,
            "review_link_resolution_failed",
            "The Discord review link could not be resolved."
          );
          await this.database.completeJob(job.id);
          this.logger.error(
            {
              event: "review_link_resolution_failed",
              jobId: job.id,
              reportId: job.report_id,
              errorCode: redacted.code,
              networkCause: redacted.networkCause,
              durationMs: Date.now() - startedAt
            },
            "Discord review link resolution failed"
          );
        }
        return;
      }
      const canRetry =
        job.attempts < job.max_attempts &&
        (job.kind === "request_code" || error instanceof SessionNotReadyError);
      if (canRetry) {
        const delaySeconds = Math.max(
          redacted.retryAfter ?? 0,
          Math.min(60, 2 ** job.attempts * 5)
        );
        await this.database.retryJob(job, redacted.message, delaySeconds);
        this.logger.info(
          {
            event: "report_job_retry_scheduled",
            jobId: job.id,
            reportId: job.report_id,
            jobKind: job.kind,
            errorCode: redacted.code,
            errorMessage: redacted.message,
            networkCause: redacted.networkCause,
            delaySeconds,
            durationMs: Date.now() - startedAt
          },
          "Report job scheduled for retry"
        );
        return;
      }
      await this.database.failJobAndReport(job, redacted.code, redacted.message);
      this.logger.error(
        {
          event: "report_job_failed",
          jobId: job.id,
          reportId: job.report_id,
          jobKind: job.kind,
          errorCode: redacted.code,
          errorMessage: redacted.message,
          networkCause: redacted.networkCause,
          durationMs: Date.now() - startedAt
        },
        "Report job failed"
      );
    }
  }

  private async runStage<T>(
    job: JobRow,
    stage: string,
    operation: () => Promise<T>
  ): Promise<T> {
    const startedAt = Date.now();
    this.logger.info(
      {
        event: "report_job_stage_started",
        jobId: job.id,
        reportId: job.report_id,
        jobKind: job.kind,
        stage
      },
      "Report job stage started"
    );
    try {
      const result = await operation();
      this.logger.info(
        {
          event: "report_job_stage_completed",
          jobId: job.id,
          reportId: job.report_id,
          jobKind: job.kind,
          stage,
          durationMs: Date.now() - startedAt
        },
        "Report job stage completed"
      );
      return result;
    } catch (error) {
      const redacted = redactedError(error);
      this.logger.error(
        {
          event: "report_job_stage_failed",
          jobId: job.id,
          reportId: job.report_id,
          jobKind: job.kind,
          stage,
          errorCode: redacted.code,
          errorMessage: redacted.message,
          networkCause: redacted.networkCause,
          durationMs: Date.now() - startedAt
        },
        "Report job stage failed"
      );
      throw error;
    }
  }

  private async requiredReport(reportId: string): Promise<ReportRow> {
    const report = await this.database.getReport(reportId);
    if (!report) throw new Error("Report no longer exists.");
    return report;
  }

  private async requestCode(job: JobRow): Promise<void> {
    const report = await this.requiredReport(job.report_id);
    if (job.payload.resend === true) {
      if (!shouldResendVerification(report)) {
        this.logger.info(
          {
            event: "verification_resend_skipped",
            jobId: job.id,
            reportId: report.id,
            resendNumber: job.payload.resendNumber,
            reportStatus: report.status
          },
          "Verification email resend skipped because report is no longer waiting"
        );
        return;
      }
      const sessionState = decryptJson<DiscordDsaSessionState>(
        report.session_state!,
        this.config.sessionEncryptionKey
      );
      const resendNumber =
        typeof job.payload.resendNumber === "number" ? job.payload.resendNumber : 0;
      const client = this.clientFor(report, sessionState);
      try {
        await this.runStage(job, "resend_verification_email", () =>
          client.sendEmailCode(report.flow, report.reporter_email)
        );
        const refreshedSession = await this.runStage(job, "snapshot_resend_session", () =>
          client.snapshotSession()
        );
        const persisted = await this.database.saveResentVerificationSession(
          report.id,
          encryptJson(refreshedSession, this.config.sessionEncryptionKey),
          resendNumber
        );
        this.logger.info(
          {
            event: "verification_resend_completed",
            jobId: job.id,
            reportId: report.id,
            resendNumber,
            persisted
          },
          "Verification email resend request completed"
        );
      } finally {
        await this.runStage(job, "close_discord_session", () => client.close());
      }
      return;
    }
    await this.database.setStatus(report.id, "requesting_verification", "requesting_verification");
    const client = this.clientFor(report);
    try {
      await this.runStage(job, "request_verification_email", () =>
        client.sendEmailCode(report.flow, report.reporter_email)
      );
      const sessionState = await this.runStage(job, "snapshot_initial_session", () =>
        client.snapshotSession()
      );
      await this.database.saveAwaitingVerification(
        report.id,
        encryptJson(sessionState, this.config.sessionEncryptionKey)
      );
    } finally {
      await this.runStage(job, "close_discord_session", () => client.close());
    }
  }

  private async verifyAndSubmit(job: JobRow): Promise<void> {
    const report = await this.requiredReport(job.report_id);
    const encryptedCode = job.payload.encryptedCode;
    if (typeof encryptedCode !== "string") throw new Error("Verification job has no code.");
    if (!report.session_state) throw new SessionNotReadyError();
    const { code } = decryptJson<{ code: string }>(
      encryptedCode,
      this.config.sessionEncryptionKey
    );
    const sessionState = decryptJson<DiscordDsaSessionState>(
      report.session_state,
      this.config.sessionEncryptionKey
    );
    const client = this.clientFor(report, sessionState);
    try {
      await this.database.setStatus(report.id, "verifying", "verification_started");
      const token = await this.runStage(job, "verify_email_code", () =>
        client.verifyEmailCode(report.flow, report.reporter_email, code)
      );
      const menu = await this.runStage(job, "fetch_report_menu", () =>
        client.getMenu(report.flow)
      );
      const payload = client.prepareSubmission(
        menu,
        toReportDraft(report.input, report.reporter_legal_name),
        token,
        DISCORD_FORM_LANGUAGE
      );
      await this.database.setStatus(report.id, "submitting", "submission_started");
      const result = await this.runStage(job, "submit_report", () =>
        client.submitPrepared(payload)
      );
      await this.database.markSubmitted(report.id, result.report_id);
    } finally {
      await this.runStage(job, "close_discord_session", () => client.close());
    }
  }

  private async submitReview(job: JobRow): Promise<void> {
    const report = await this.requiredReport(job.report_id);
    const encryptedReviewUrl = job.payload.encryptedReviewUrl;
    if (typeof encryptedReviewUrl !== "string") {
      throw new Error("Review job has no encrypted review link.");
    }
    if (!report.discord_report_id) {
      throw new Error("Review job report has no Discord report ID.");
    }
    const { reviewUrl } = decryptJson<{ reviewUrl: string }>(
      encryptedReviewUrl,
      this.config.sessionEncryptionKey
    );
    const client = this.clientFor(report);
    try {
      const token = await this.runStage(job, "resolve_review_link", () =>
        client.resolveReportReviewToken(reviewUrl)
      );
      let result;
      try {
        result = await this.runStage(job, "submit_report_review", () =>
          client.submitReportReviewToken(token)
        );
      } catch (error) {
        const redacted = redactedError(error);
        const ambiguous = error instanceof DiscordDsaNetworkError;
        try {
          await this.database.failReviewRequest(
            report.id,
            ambiguous,
            ambiguous ? "review_request_ambiguous" : "review_request_failed",
            ambiguous
              ? "Discord review request submission could not be confirmed."
              : "Discord did not accept the automatic review request."
          );
        } catch (persistenceError) {
          throw new ReviewSubmissionStartedError(persistenceError);
        }
        this.logger.error(
          {
            event: ambiguous ? "review_request_ambiguous" : "review_request_failed",
            jobId: job.id,
            reportId: report.id,
            errorCode: redacted.code,
            networkCause: redacted.networkCause
          },
          ambiguous
            ? "Discord review request result is ambiguous"
            : "Discord review request failed"
        );
        return;
      }
      if (result.report_id !== report.discord_report_id) {
        try {
          await this.database.failReviewRequest(
            report.id,
            false,
            "review_report_id_mismatch",
            "Discord returned a different report ID for the review request."
          );
        } catch (error) {
          throw new ReviewSubmissionStartedError(error);
        }
        return;
      }
      try {
        await this.database.markReviewRequested(report.id, result.report_id);
      } catch (error) {
        throw new ReviewSubmissionStartedError(error);
      }
    } finally {
      try {
        await client.close();
      } catch (error) {
        this.logger.error(
          {
            event: "review_session_close_failed",
            jobId: job.id,
            reportId: report.id,
            error: redactedError(error)
          },
          "Discord review session close failed"
        );
      }
    }
  }
}
