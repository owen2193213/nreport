import { setTimeout as delay } from "node:timers/promises";

import {
  DiscordDsaClient,
  DiscordDsaHttpError,
  DiscordDsaNetworkError,
  type DiscordDsaSessionState
} from "@discord-dsa/client";
import type { AppConfig } from "./config.js";
import type { Database, JobRow, ReportRow } from "./database.js";
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

function redactedError(error: unknown): { code: string; message: string; retryAfter?: number } {
  if (error instanceof DiscordDsaNetworkError) {
    return {
      code: "discord_network_error",
      message: "Temporary connection to Discord failed. Please retry this report."
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
    try {
      if (job.kind === "request_code") {
        await this.requestCode(job);
      } else {
        await this.verifyAndSubmit(job);
      }
      await this.database.completeJob(job.id);
    } catch (error) {
      const redacted = redactedError(error);
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
          { jobId: job.id, reportId: job.report_id, delaySeconds },
          "Report job scheduled for retry"
        );
        return;
      }
      await this.database.failJobAndReport(job, redacted.code, redacted.message);
      this.logger.error(
        { jobId: job.id, reportId: job.report_id, errorCode: redacted.code },
        "Report job failed"
      );
    }
  }

  private async requiredReport(reportId: string): Promise<ReportRow> {
    const report = await this.database.getReport(reportId);
    if (!report) throw new Error("Report no longer exists.");
    return report;
  }

  private async requestCode(job: JobRow): Promise<void> {
    const report = await this.requiredReport(job.report_id);
    await this.database.setStatus(report.id, "requesting_verification", "requesting_verification");
    const client = this.clientFor(report);
    try {
      await client.sendEmailCode(report.flow, report.reporter_email);
      const sessionState = await client.snapshotSession();
      await this.database.saveAwaitingVerification(
        report.id,
        encryptJson(sessionState, this.config.sessionEncryptionKey)
      );
    } finally {
      await client.close();
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
      const token = await client.verifyEmailCode(report.flow, report.reporter_email, code);
      const menu = await client.getMenu(report.flow);
      const payload = client.prepareSubmission(
        menu,
        toReportDraft(report.input, report.reporter_legal_name),
        token,
        DISCORD_FORM_LANGUAGE
      );
      await this.database.setStatus(report.id, "submitting", "submission_started");
      const result = await client.submitPrepared(payload);
      await this.database.markSubmitted(report.id, result.report_id);
    } finally {
      await client.close();
    }
  }
}
