import {
  DiscordDsaClient,
  DiscordDsaHttpError,
  DiscordDsaNetworkError,
  type DiscordDsaSessionState
} from "@discord-dsa/client";

import type { AppConfig } from "./config.js";
import { buildAcceptLanguage, buildProxyUrl } from "./pseudonyms.js";
import { decryptJson, encryptJson } from "./security.js";
import { DISCORD_FORM_LANGUAGE, toReportDraft, type PreparedReportInput } from "./validation.js";

export interface LifecycleJob {
  id: string;
  report_id: string;
  kind: "request_code" | "verify_submit" | "submit_review";
  payload: Record<string, unknown>;
  attempts: number;
  max_attempts: number;
  execution_token: number;
  trace_id: string;
}

export interface LifecycleReport {
  id: string;
  trace_id: string;
  flow: "message" | "profile" | "server";
  country: string;
  reporter_email: string;
  reporter_legal_name: string;
  timezone: string;
  locale: string;
  language: string;
  proxy_session_id: string;
  session_state: string | null;
  request_input: PreparedReportInput["request"];
  prepared_input: Omit<PreparedReportInput, "request">;
  status: string;
  discord_report_id: string | null;
}

export interface LifecycleFailureSignal {
  reportId: string;
  traceId: string;
  lifecycleAttempt: number;
  stage: "verification" | "submitted" | "review_confirmation" | "submitting" | "review_submission";
  eventType: "report_failed" | "report_receipt_timeout" | "review_confirmation_timeout" | "review_request_ambiguous";
  outcome: "failed" | "ambiguous";
  errorCategory:
    | "verification_timeout"
    | "discord_receipt_timeout"
    | "review_confirmation_timeout"
    | "ambiguous_submission_state"
    | "review_request_ambiguous"
    | "lifecycle_attempts_exhausted";
}

interface LifecycleStore {
  claimLifecycleJob(): Promise<LifecycleJob | null>;
  heartbeatLifecycleJob(job: LifecycleJob): Promise<boolean>;
  getLifecycleReport(reportId: string): Promise<LifecycleReport | null>;
  setStatus(job: LifecycleJob, status: "requesting_verification" | "verifying"): Promise<boolean>;
  saveAwaitingVerification(job: LifecycleJob, encryptedSession: string): Promise<boolean | "superseded">;
  beginSubmission(job: LifecycleJob): Promise<boolean>;
  markSubmitted(job: LifecycleJob, discordReportId: string): Promise<boolean>;
  completeLifecycleJob(job: LifecycleJob): Promise<boolean>;
  retryLifecycleJob(
    job: LifecycleJob,
    code: string,
    delaySeconds: number,
    options?: LifecycleRetryOptions
  ): Promise<boolean | "superseded">;
  failBeforeSubmission(
    job: LifecycleJob,
    code: string,
    message: string,
    automaticNetworkRestartEligible?: boolean,
    encryptedSession?: string
  ): Promise<boolean | "restarted" | "superseded">;
  failAfterSubmission(job: LifecycleJob, code: string, message: string): Promise<boolean>;
  markReviewRequested(job: LifecycleJob, discordReportId: string): Promise<boolean>;
  beginReviewSubmission(job: LifecycleJob): Promise<boolean>;
  failReview(job: LifecycleJob, status: "ineligible" | "request_failed" | "request_ambiguous", code: string, message: string): Promise<boolean>;
  expireDeadlines?(onFailure?: (failure: LifecycleFailureSignal) => void): Promise<void>;
  recoverInterruptedJobs?(onFailure?: (failure: LifecycleFailureSignal) => void): Promise<LifecycleFailureSignal[] | void>;
  purgeDiagnostics?(): Promise<void>;
  reconcilePendingInboundMessages?(): Promise<{ processed: number; remaining: number; oldestPendingAgeMs: number | null }>;
}

export interface LifecycleRetryOptions {
  recordConnectionProgress?: boolean;
  encryptedSession?: string;
  encryptedVerifiedToken?: string;
}

interface LifecycleClient {
  sendEmailCode(flow: "message_urf" | "user_urf" | "guild_urf", email: string): Promise<unknown>;
  snapshotSession(): Promise<DiscordDsaSessionState>;
  snapshotInitializedSession?(): DiscordDsaSessionState | null;
  verifyEmailCode(flow: "message_urf" | "user_urf" | "guild_urf", email: string, code: string): Promise<string>;
  getMenu(flow: "message_urf" | "user_urf" | "guild_urf"): Promise<unknown>;
  prepareSubmission(menu: never, draft: ReturnType<typeof toReportDraft>, token: string, language: string): unknown;
  submitPrepared(payload: never): Promise<{ report_id: string }>;
  bootstrapFingerprint(): Promise<unknown>;
  resolveReportReviewToken(reviewUrl: string): Promise<string>;
  submitReportReviewToken(token: string): Promise<{ report_id: string }>;
  close(): Promise<void>;
}

interface RunnerCodecs {
  decrypt(value: string): unknown;
  encrypt(value: unknown): string;
}

type RunnerSleep = (milliseconds: number, signal?: AbortSignal) => Promise<unknown>;

export type LifecycleRunnerOutcome =
  | {
      component: "job";
      stage: "lifecycle_job";
      outcome: LifecycleJobResult["outcome"];
      jobKind: LifecycleJob["kind"];
      attempts: number;
      durationMs: number;
      reportId: string;
      traceId: string;
      errorCategory?: string;
      error?: unknown;
      retryDelayMs?: number;
      submissionCertainty?: "not_started" | "confirmed" | "ambiguous";
    }
  | {
      component: "loop" | "maintenance";
      stage: "lifecycle_claim" | "lifecycle_maintenance";
      outcome: "completed" | "failed";
      durationMs: number;
      errorCategory?: string;
      error?: unknown;
    }
  | {
      component: "report_failure";
      stage: LifecycleFailureSignal["stage"];
      outcome: LifecycleFailureSignal["outcome"];
      durationMs: number;
      reportId: string;
      traceId: string;
      lifecycleAttempt: number;
      eventType: LifecycleFailureSignal["eventType"];
      errorCategory: LifecycleFailureSignal["errorCategory"];
    }
  | {
      component: "job";
      stage: "lifecycle_heartbeat";
      outcome: "failed";
      durationMs: number;
      reportId: string;
      traceId: string;
      errorCategory?: string;
      error?: unknown;
    };

interface LifecycleJobResult {
  outcome: "completed" | "waiting_for_email" | "retry_scheduled" | "restarting" | "failed" | "ambiguous" | "ownership_lost";
  errorCategory?: string;
  error?: unknown;
  retryDelayMs?: number;
  submissionCertainty?: "not_started" | "confirmed" | "ambiguous";
}

export class LifecycleRunner {
  private running: Promise<void>[] | undefined;
  private stopping = false;
  private lastMaintenanceAt = 0;
  private lastDiagnosticsPurgeAt = 0;
  private stopController: AbortController | undefined;
  private readonly clientFactory: (report: LifecycleReport, session?: DiscordDsaSessionState) => LifecycleClient;
  private readonly codecs: RunnerCodecs;
  private readonly sleep: RunnerSleep;
  private readonly concurrency: number;

  public constructor(
    private readonly store: LifecycleStore,
    config: AppConfig,
    clientFactory?: (report: LifecycleReport, session?: DiscordDsaSessionState) => LifecycleClient,
    codecs?: Partial<RunnerCodecs>,
    sleep: RunnerSleep = cancellableDelay,
    private readonly onOutcome: (outcome: LifecycleRunnerOutcome) => void | Promise<void> = () => undefined,
    private readonly random: () => number = Math.random
  ) {
    this.clientFactory = clientFactory ?? ((report, session) => defaultClient(config, report, session));
    this.codecs = {
      decrypt: codecs?.decrypt ?? ((value) => decryptJson(value, config.sessionEncryptionKey)),
      encrypt: codecs?.encrypt ?? ((value) => encryptJson(value, config.sessionEncryptionKey))
    };
    this.sleep = sleep;
    this.concurrency = config.lifecycleConcurrency ?? 2;
  }

  public start(): void {
    if (this.running !== undefined) return;
    this.stopping = false;
    this.stopController = new AbortController();
    this.running = [
      ...Array.from({ length: this.concurrency }, () => this.jobLoop()),
      this.maintenanceLoop()
    ];
  }

  public async stop(): Promise<void> {
    this.stopping = true;
    this.stopController?.abort();
    await Promise.all(this.running ?? []);
    this.running = undefined;
    this.stopController = undefined;
  }

  public async processOne(): Promise<boolean> {
    if (Date.now() - this.lastMaintenanceAt >= 30_000) {
      await this.runMaintenance();
      this.lastMaintenanceAt = Date.now();
    }
    const job = await this.store.claimLifecycleJob();
    if (job === null) return false;
    await this.processJob(job);
    return true;
  }

  private async processJob(job: LifecycleJob): Promise<void> {
    const startedAt = Date.now();
    const ownership = new JobOwnership();
    const settled = new AbortController();
    const heartbeat = this.heartbeatJob(job, ownership, settled.signal);
    try {
      const result = await this.dispatchJob(job, ownership);
      this.notify({
        component: "job",
        stage: "lifecycle_job",
        ...result,
        jobKind: job.kind,
        attempts: job.attempts,
        durationMs: elapsedSince(startedAt),
        reportId: job.report_id,
        traceId: job.trace_id
      });
    } catch (error) {
      this.notify({
        component: "job",
        stage: "lifecycle_job",
        outcome: isOwnershipLost(error) ? "ownership_lost" : "failed",
        jobKind: job.kind,
        attempts: job.attempts,
        durationMs: elapsedSince(startedAt),
        reportId: job.report_id,
        traceId: job.trace_id,
        error,
        ...(isOwnershipLost(error) ? {} : { errorCategory: safeJobErrorCategory(error) })
      });
      if (!isOwnershipLost(error)) throw error;
    } finally {
      settled.abort();
      await heartbeat;
    }
  }

  private async dispatchJob(job: LifecycleJob, ownership: JobOwnership): Promise<LifecycleJobResult> {
    if (job.kind === "request_code") return this.requestCode(job, ownership);
    if (job.kind === "verify_submit") return this.verifyAndSubmit(job, ownership);
    return this.submitReview(job, ownership);
  }

  private async submitReview(job: LifecycleJob, ownership: JobOwnership): Promise<LifecycleJobResult> {
    const report = await this.requiredReport(job.report_id);
    const encryptedReviewUrl = job.payload.encryptedReviewUrl;
    if (typeof encryptedReviewUrl !== "string" || report.discord_report_id === null) {
      await this.store.failReview(job, "request_failed", "review_context_missing", "The automatic appeal could not be prepared.");
      return failedResult("review_context_missing", new Error("Automatic appeal context is missing."));
    }
    const decoded = this.codecs.decrypt(encryptedReviewUrl);
    const reviewUrl = typeof decoded === "string" ? decoded : (decoded as { reviewUrl?: unknown }).reviewUrl;
    if (typeof reviewUrl !== "string") {
      await this.store.failReview(job, "request_failed", "review_url_invalid", "The automatic appeal link was invalid.");
      return failedResult("review_url_invalid", new Error("Automatic appeal URL is invalid."));
    }
    let client: LifecycleClient | undefined;
    let submissionStarted = false;
    try {
      client = this.clientFactory(report);
      await ownership.wait(client.bootstrapFingerprint());
      const token = await ownership.wait(client.resolveReportReviewToken(reviewUrl));
      submissionStarted = await this.store.beginReviewSubmission(job);
      if (!submissionStarted) {
        await this.store.completeLifecycleJob(job);
        return ownershipLostResult();
      }
      let result: { report_id: string };
      try {
        result = await ownership.wait(client.submitReportReviewToken(token));
      } catch (error) {
        if (isOwnershipLost(error)) throw error;
        if (discordResponseCode(error) !== "521004") throw error;
        await ownership.wait(this.sleep(10_000));
        try {
          result = await ownership.wait(client.submitReportReviewToken(token));
        } catch (retryError) {
          if (isOwnershipLost(retryError)) throw retryError;
          if (discordResponseCode(retryError) === "521002") {
            return (await this.store.markReviewRequested(job, report.discord_report_id))
              ? completedResult("confirmed")
              : ownershipLostResult();
          }
          throw retryError;
        }
      }
      if (result.report_id !== report.discord_report_id) {
        await this.store.failReview(job, "request_failed", "review_report_id_mismatch", "Discord returned a different report ID for the appeal.");
        return failedResult("review_report_id_mismatch", new Error("Discord returned a different report ID for the appeal."));
      }
      return (await this.store.markReviewRequested(job, result.report_id))
        ? completedResult("confirmed")
        : ownershipLostResult();
    } catch (error) {
      if (isOwnershipLost(error)) throw error;
      const responseCode = discordResponseCode(error);
      if (responseCode === "521002") {
        return (await this.store.markReviewRequested(job, report.discord_report_id))
          ? completedResult("confirmed")
          : ownershipLostResult();
      } else if (responseCode === "521004") {
        await this.store.failReview(job, "ineligible", "discord_review_ineligible", "Discord says this report is ineligible for appeal.");
        return failedResult("discord_review_ineligible", error);
      } else if (submissionStarted && ambiguous(error)) {
        await this.store.failReview(job, "request_ambiguous", "review_request_ambiguous", "The automatic appeal outcome could not be confirmed.");
        return ambiguousResult("review_request_ambiguous", error);
      } else if (
        !submissionStarted && job.attempts < job.max_attempts && retryable(error) &&
        !retryAfterExceedsMaxAutomaticWait(error)
      ) {
        const delaySeconds = retryDelaySeconds(job.attempts, error);
        await this.store.retryLifecycleJob(job, discordFailureCode(error), delaySeconds);
        return retryResult(discordFailureCode(error), delaySeconds, error);
      } else {
        const code = discordFailureCode(error);
        await this.store.failReview(job, "request_failed", code, `Discord did not accept the automatic appeal (${code}).`);
        return failedResult(code, error);
      }
    } finally {
      await client?.close();
    }
  }

  private async requestCode(job: LifecycleJob, ownership: JobOwnership): Promise<LifecycleJobResult> {
    const report = await this.requiredReport(job.report_id);
    let client: LifecycleClient | undefined;
    try {
      const restoredSession = job.attempts > 1 && report.session_state !== null
        ? decodeSession(this.codecs.decrypt(report.session_state))
        : undefined;
      client = this.clientFactory(report, restoredSession);
      if (report.status === "verifying") {
        return (await this.store.completeLifecycleJob(job))
          ? { outcome: "completed" }
          : ownershipLostResult();
      }
      if (report.status === "verification_received") {
        const initialized = client.snapshotInitializedSession?.();
        const savedSession = initialized ?? await ownership.wait(client.snapshotSession());
        const saved = await this.store.saveAwaitingVerification(job, this.codecs.encrypt(savedSession));
        if (saved === "superseded") return { outcome: "completed" };
        return saved
          ? { outcome: "waiting_for_email", submissionCertainty: "not_started" }
          : ownershipLostResult();
      }
      if (!(await this.store.setStatus(job, "requesting_verification"))) {
        return (await this.store.completeLifecycleJob(job))
          ? { outcome: "completed" }
          : ownershipLostResult();
      }
      await ownership.wait(client.sendEmailCode(transportFlow(report.flow), report.reporter_email));
      const savedSession = await ownership.wait(client.snapshotSession());
      const saved = await this.store.saveAwaitingVerification(job, this.codecs.encrypt(savedSession));
      if (saved === "superseded") return { outcome: "completed" };
      return saved
        ? { outcome: "waiting_for_email", submissionCertainty: "not_started" }
        : ownershipLostResult();
    } catch (error) {
      if (isOwnershipLost(error)) throw error;
      return this.handleBeforeBoundaryFailure(job, error, client);
    } finally {
      await client?.close();
    }
  }

  private async verifyAndSubmit(job: LifecycleJob, ownership: JobOwnership): Promise<LifecycleJobResult> {
    const report = await this.requiredReport(job.report_id);
    if (report.session_state === null) {
      // The verification email can arrive, and this job can be scheduled, before the
      // request_code job has finished saving session_state. Retry instead of failing
      // outright so the credit is not released for a race that will resolve itself.
      if (job.attempts < job.max_attempts) {
        return (await this.store.retryLifecycleJob(job, "session_not_ready", 3))
          ? retryResult("session_not_ready", 3)
          : ownershipLostResult();
      }
      await this.store.failBeforeSubmission(job, "session_not_ready", "Verification session was not ready.");
      return failedResult("session_not_ready", new Error("Verification session was not ready after the final attempt."));
    }
    let client: LifecycleClient | undefined;
    let crossedBoundary = false;
    let verifiedToken: string | undefined;
    try {
      const session = decodeSession(this.codecs.decrypt(report.session_state));
      client = this.clientFactory(report, session);
      if (!(await this.store.setStatus(job, "verifying"))) {
        return (await this.store.completeLifecycleJob(job))
          ? { outcome: "completed" }
          : ownershipLostResult();
      }
      const flow = transportFlow(report.flow);
      const storedToken = job.payload.encryptedVerifiedToken;
      if (typeof storedToken === "string") {
        const decodedToken = this.codecs.decrypt(storedToken);
        verifiedToken = typeof decodedToken === "string"
          ? decodedToken
          : (decodedToken as { token?: unknown }).token as string | undefined;
        if (typeof verifiedToken !== "string" || verifiedToken.length === 0) {
          throw new Error("Stored Discord verification token is invalid.");
        }
      } else {
        const rawCode = job.payload.encryptedCode ?? job.payload.code;
        if (typeof rawCode !== "string") {
          await this.store.failBeforeSubmission(job, "verification_code_missing", "Verification code was unavailable.");
          return failedResult("verification_code_missing", new Error("Verification code was unavailable in stored job data."));
        }
        const decoded = this.codecs.decrypt(rawCode);
        const code = typeof decoded === "string" ? decoded : (decoded as { code?: unknown }).code;
        if (typeof code !== "string") {
          await this.store.failBeforeSubmission(job, "verification_code_invalid", "Verification code was invalid.");
          return failedResult("verification_code_invalid", new Error("Verification code was invalid after decrypting stored job data."));
        }
        verifiedToken = await ownership.wait(client.verifyEmailCode(flow, report.reporter_email, code));
      }
      const menu = await ownership.wait(client.getMenu(flow));
      if (verifiedToken === undefined) throw new Error("Discord verification token is unavailable.");
      const payload = client.prepareSubmission(
        menu as never,
        toReportDraft({ request: report.request_input, ...report.prepared_input }, report.reporter_legal_name),
        verifiedToken,
        DISCORD_FORM_LANGUAGE
      );
      crossedBoundary = await this.store.beginSubmission(job);
      if (!crossedBoundary) {
        await this.store.completeLifecycleJob(job);
        return ownershipLostResult();
      }
      const result = await ownership.wait(client.submitPrepared(payload as never));
      return (await this.store.markSubmitted(job, result.report_id))
        ? completedResult("confirmed")
        : ownershipLostResult();
    } catch (error) {
      if (isOwnershipLost(error)) throw error;
      if (crossedBoundary) {
        const code = ambiguous(error) ? "ambiguous_submission_state" : discordFailureCode(error);
        await this.store.failAfterSubmission(
          job,
          code,
          "Discord submission started, but its final outcome could not be safely retried."
        );
        return ambiguous(error)
          ? ambiguousResult(code, error)
          : failedResult(code, error);
      } else {
        return this.handleBeforeBoundaryFailure(job, error, client, verifiedToken);
      }
    } finally {
      await client?.close();
    }
  }

  private async handleBeforeBoundaryFailure(
    job: LifecycleJob,
    error: unknown,
    client?: LifecycleClient,
    verifiedToken?: string
  ): Promise<LifecycleJobResult> {
    const code = discordFailureCode(error);
    if (
      job.attempts < job.max_attempts && retryable(error) &&
      !retryAfterExceedsMaxAutomaticWait(error)
    ) {
      const delaySeconds = retryDelaySeconds(job.attempts, error, this.random);
      const initializedSession = client?.snapshotInitializedSession?.();
      const retryOptions: LifecycleRetryOptions = {
        ...((job.kind !== "submit_review" && isTransientConnectionFailure(error))
          ? { recordConnectionProgress: true }
          : {}),
        ...(initializedSession === null || initializedSession === undefined
          ? {}
          : { encryptedSession: this.codecs.encrypt(initializedSession) }),
        ...(verifiedToken === undefined ? {} : { encryptedVerifiedToken: this.codecs.encrypt({ token: verifiedToken }) })
      };
      const saved = Object.keys(retryOptions).length === 0
        ? await this.store.retryLifecycleJob(job, code, delaySeconds)
        : await this.store.retryLifecycleJob(job, code, delaySeconds, retryOptions);
      if (saved === "superseded") return { outcome: "completed" };
      return saved
        ? retryResult(code, delaySeconds, error)
        : ownershipLostResult();
    }
    const automaticNetworkRestartEligible =
      job.attempts >= job.max_attempts &&
      (job.kind === "request_code" || job.kind === "verify_submit") &&
      !retryAfterExceedsMaxAutomaticWait(error) &&
      isTransientConnectionFailure(error);
    const initializedSession = client?.snapshotInitializedSession?.();
    const failureOutcome = initializedSession === null || initializedSession === undefined
      ? await this.store.failBeforeSubmission(
        job, code, "Discord preparation failed safely.", automaticNetworkRestartEligible
      )
      : await this.store.failBeforeSubmission(
        job, code, "Discord preparation failed safely.", automaticNetworkRestartEligible,
        this.codecs.encrypt(initializedSession)
      );
    if (failureOutcome === "restarted") return restartingResult(code, error);
    if (failureOutcome === "superseded") return { outcome: "completed" };
    if (!failureOutcome) return ownershipLostResult();
    return failedResult(code, error);
  }

  private async requiredReport(reportId: string): Promise<LifecycleReport> {
    const report = await this.store.getLifecycleReport(reportId);
    if (report === null) throw new Error("Report no longer exists.");
    return report;
  }

  private async jobLoop(): Promise<void> {
    while (!this.stopping) {
      const claimStartedAt = Date.now();
      let job: LifecycleJob | null;
      try {
        job = await this.store.claimLifecycleJob();
      } catch (error) {
        this.notify({
          component: "loop",
          stage: "lifecycle_claim",
          outcome: "failed",
          durationMs: elapsedSince(claimStartedAt),
          errorCategory: "lifecycle_claim_failed",
          error
        });
        await this.waitForStop(1_500);
        continue;
      }
      if (job === null) {
        await this.waitForStop(750);
        continue;
      }
      try {
        await this.processJob(job);
      } catch {
        await this.waitForStop(1_500);
      }
    }
  }

  private async maintenanceLoop(): Promise<void> {
    while (!this.stopping) {
      try {
        await this.runMaintenance();
      } catch {
        // The safe outcome is emitted by runMaintenance; the next cadence retries it.
      }
      if (this.stopping) return;
      await this.waitForStop(30_000);
    }
  }

  private async heartbeatJob(job: LifecycleJob, ownership: JobOwnership, settled: AbortSignal): Promise<void> {
    if (this.store.heartbeatLifecycleJob === undefined) return;
    while (true) {
      const jobSettled = await this.waitForInterrupt(30_000, settled);
      if (jobSettled) return;
      const heartbeatStartedAt = Date.now();
      try {
        if (!(await this.store.heartbeatLifecycleJob(job))) {
          ownership.lose();
          return;
        }
      } catch (error) {
        this.notify({
          component: "job",
          stage: "lifecycle_heartbeat",
          outcome: "failed",
          durationMs: elapsedSince(heartbeatStartedAt),
          reportId: job.report_id,
          traceId: job.trace_id,
          errorCategory: "lifecycle_heartbeat_failed",
          error
        });
      }
    }
  }

  private async runMaintenance(): Promise<void> {
    const startedAt = Date.now();
    try {
      const reconciliation = await this.store.reconcilePendingInboundMessages?.();
      let reportedDuringRecovery = false;
      const recoveredFailures = await this.store.recoverInterruptedJobs?.((failure) => {
        reportedDuringRecovery = true;
        this.notify({
          component: "report_failure",
          durationMs: 0,
          ...failure
        });
      });
      // Keep support for simple stores that return failures without invoking
      // the callback. The repository callback fires only after each commit so
      // earlier durable failures are still reported if a later batch fails.
      if (!reportedDuringRecovery) {
        for (const failure of recoveredFailures ?? []) {
          this.notify({ component: "report_failure", durationMs: 0, ...failure });
        }
      }
      await this.store.expireDeadlines?.((failure) => this.notify({
        component: "report_failure",
        durationMs: 0,
        ...failure
      }));
      if (Date.now() - this.lastDiagnosticsPurgeAt >= 60 * 60_000) {
        // Diagnostics are best-effort: a retention failure must not prevent
        // deadline recovery or the next lifecycle maintenance pass.
        try {
          await this.store.purgeDiagnostics?.();
        } catch (error) {
          this.notify({
            component: "maintenance", stage: "lifecycle_maintenance", outcome: "failed",
            durationMs: 0, errorCategory: error instanceof Error ? error.name : "UnknownError", error
          });
        }
        this.lastDiagnosticsPurgeAt = Date.now();
      }
      this.notify({
        component: "maintenance",
        stage: "lifecycle_maintenance",
        outcome: "completed",
        durationMs: elapsedSince(startedAt),
        ...(reconciliation === undefined ? {} : {
          pendingInboundProcessed: reconciliation.processed,
          pendingInboundRemaining: reconciliation.remaining,
          oldestPendingInboundAgeMs: reconciliation.oldestPendingAgeMs
        })
      });
    } catch (error) {
      this.notify({
        component: "maintenance",
        stage: "lifecycle_maintenance",
        outcome: "failed",
        durationMs: elapsedSince(startedAt),
        errorCategory: "lifecycle_maintenance_failed",
        error
      });
      throw error;
    }
  }

  private async waitForStop(milliseconds: number): Promise<void> {
    if (this.stopping) return;
    const stopSignal = this.stopController?.signal;
    if (stopSignal === undefined) {
      await this.sleep(milliseconds);
      return;
    }
    await this.waitForInterrupt(milliseconds, stopSignal);
  }

  private async waitForInterrupt(milliseconds: number, interrupt: AbortSignal): Promise<boolean> {
    const controller = new AbortController();
    let interruptListener: (() => void) | undefined;
    const interrupted = new Promise<boolean>((resolve) => {
      if (interrupt.aborted) {
        resolve(true);
        return;
      }
      interruptListener = () => resolve(true);
      interrupt.addEventListener("abort", interruptListener, { once: true });
    });
    const sleeping = this.sleep(milliseconds, controller.signal).then(
      () => false,
      (error: unknown) => {
        if (controller.signal.aborted) return true;
        throw error;
      }
    );
    try {
      return await Promise.race([sleeping, interrupted]);
    } finally {
      controller.abort();
      if (interruptListener !== undefined) {
        interrupt.removeEventListener("abort", interruptListener);
      }
    }
  }

  private notify(outcome: LifecycleRunnerOutcome): void {
    try {
      void Promise.resolve(this.onOutcome(outcome)).catch(() => undefined);
    } catch {
      // Observability must not interrupt queue progress.
    }
  }
}

function elapsedSince(startedAt: number): number {
  return Math.max(0, Date.now() - startedAt);
}

class LifecycleOwnershipLostError extends Error {
  public constructor() {
    super("Lifecycle job ownership was lost.");
  }
}

class JobOwnership {
  private lost = false;
  private readonly lostPromise: Promise<never>;
  private resolveLost!: (error: LifecycleOwnershipLostError) => void;

  public constructor() {
    this.lostPromise = new Promise<never>((_resolve, reject) => {
      this.resolveLost = reject;
    });
    void this.lostPromise.catch(() => undefined);
  }

  public lose(): void {
    if (this.lost) return;
    this.lost = true;
    this.resolveLost(new LifecycleOwnershipLostError());
  }

  public async wait<T>(operation: Promise<T>): Promise<T> {
    if (this.lost) throw new LifecycleOwnershipLostError();
    return Promise.race([operation, this.lostPromise]);
  }
}

function isOwnershipLost(error: unknown): error is LifecycleOwnershipLostError {
  return error instanceof LifecycleOwnershipLostError;
}

function cancellableDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted === true) {
      resolve();
      return;
    }
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    timer.unref?.();
    signal?.addEventListener("abort", finish, { once: true });
  });
}

function safeJobErrorCategory(error: unknown): string {
  if (isOwnershipLost(error)) return "lifecycle_ownership_lost";
  const category = discordFailureCode(error);
  return category === "discord_lifecycle_failed" ? "lifecycle_job_failed" : category;
}

function discordResponseCode(error: unknown): string | undefined {
  return error instanceof DiscordDsaHttpError
    ? /^code ([A-Za-z0-9_.-]{1,40})(?:;|$)/.exec(error.responseSummary ?? "")?.[1]
    : undefined;
}

function defaultClient(
  config: AppConfig,
  report: LifecycleReport,
  session?: DiscordDsaSessionState
): LifecycleClient {
  const proxyUrl = buildProxyUrl(config.proxyUrlTemplate, report.country, report.proxy_session_id);
  if (proxyUrl === undefined) throw new Error("DSA_PROXY_URL_TEMPLATE is not configured.");
  return new DiscordDsaClient({
    proxyUrl,
    fingerprintMaxAttempts: 1,
    timezone: report.timezone,
    locale: report.locale,
    extraHeaders: { "accept-language": buildAcceptLanguage(report.locale, report.language) },
    ...(session === undefined ? {} : { sessionState: session })
  });
}

function transportFlow(flow: LifecycleReport["flow"]): "message_urf" | "user_urf" | "guild_urf" {
  return flow === "message" ? "message_urf" : flow === "profile" ? "user_urf" : "guild_urf";
}

function retryable(error: unknown): boolean {
  return isTransientNetworkFailure(error) ||
    (error instanceof DiscordDsaHttpError && (error.status === 429 || error.status >= 500));
}

function isTransientConnectionFailure(error: unknown): boolean {
  return isTransientNetworkFailure(error) || (error instanceof DiscordDsaHttpError && error.status >= 500);
}

const TRANSIENT_NETWORK_CODES = new Set([
  "ECONNABORTED", "ECONNREFUSED", "ECONNRESET", "EHOSTDOWN", "EHOSTUNREACH", "EPIPE", "EAI_AGAIN",
  "ENETDOWN", "ENETUNREACH", "ETIMEDOUT", "UND_ERR_BODY_TIMEOUT", "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_SOCKET", "UND_ERR_REQUEST_TIMEOUT"
]);

const PERMANENT_NETWORK_CODES = new Set([
  "EAI_NONAME", "ENOTFOUND", "ERR_INVALID_ARG_TYPE", "ERR_INVALID_URL", "ERR_INVALID_PROTOCOL",
  "ERR_TLS_CERT_ALTNAME_INVALID", "CERT_HAS_EXPIRED", "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN", "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "ERR_TLS_CERT_SIGNATURE_ALGORITHM_UNSUPPORTED"
]);

const MAX_AUTOMATIC_WAIT_SECONDS = 300;

function retryAfterExceedsMaxAutomaticWait(error: unknown): boolean {
  if (!(error instanceof DiscordDsaHttpError) || error.retryAfterSeconds === undefined) return false;
  return !Number.isFinite(error.retryAfterSeconds) || error.retryAfterSeconds > MAX_AUTOMATIC_WAIT_SECONDS;
}

function isTransientNetworkFailure(error: unknown): boolean {
  if (!(error instanceof DiscordDsaNetworkError)) return false;
  const causes = errorCauseChain(error);
  if (causes.some((cause) => causeStatus(cause) === 407 || isProxyAuthenticationFailure(cause))) return false;
  const codes = causes.map(causeCode).filter((code): code is string => code !== undefined);
  if (codes.some((code) => PERMANENT_NETWORK_CODES.has(code))) return false;
  return codes.some((code) => TRANSIENT_NETWORK_CODES.has(code));
}

function errorCauseChain(error: unknown): unknown[] {
  const causes: unknown[] = [];
  const visited = new Set<unknown>();
  const pending: unknown[] = [error];
  while (pending.length > 0 && causes.length < 64) {
    const current = pending.pop();
    if (current === null || typeof current !== "object" || visited.has(current)) continue;
    visited.add(current);
    causes.push(current);
    if ("cause" in current) pending.push((current as { cause?: unknown }).cause);
    if ("errors" in current && Array.isArray((current as { errors?: unknown }).errors)) {
      pending.push(...((current as { errors: unknown[] }).errors.slice(0, 16)));
    }
  }
  return causes;
}

function decodeSession(value: unknown): DiscordDsaSessionState {
  let state = value;
  if (typeof state === "string") {
    try { state = JSON.parse(state) as unknown; } catch { /* handled as invalid below */ }
  }
  if (state === null || typeof state !== "object") throw new Error("Stored Discord session is invalid.");
  const candidate = state as { fingerprint?: unknown; cookies?: unknown };
  if (typeof candidate.fingerprint !== "string" || typeof candidate.cookies !== "string") {
    throw new Error("Stored Discord session is invalid.");
  }
  return { fingerprint: candidate.fingerprint, cookies: candidate.cookies };
}

function causeCode(value: unknown): string | undefined {
  if (value === null || typeof value !== "object" || !("code" in value)) return undefined;
  const code = (value as { code?: unknown }).code;
  return typeof code === "string" ? code.toUpperCase() : undefined;
}

function causeStatus(value: unknown): number | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const candidate = value as { status?: unknown; statusCode?: unknown };
  const status = typeof candidate.statusCode === "number" ? candidate.statusCode : candidate.status;
  return typeof status === "number" ? status : undefined;
}

function isProxyAuthenticationFailure(value: unknown): boolean {
  if (value === null || typeof value !== "object" || !("message" in value)) return false;
  const message = (value as { message?: unknown }).message;
  return typeof message === "string" && /Proxy response \(407\) !== 200 when HTTP Tunneling/i.test(message);
}

function ambiguous(error: unknown): boolean {
  return error instanceof DiscordDsaNetworkError || !(error instanceof DiscordDsaHttpError) || error.status >= 500;
}

function discordFailureCode(error: unknown): string {
  if (error instanceof DiscordDsaNetworkError) return "discord_network_error";
  if (error instanceof DiscordDsaHttpError) return `discord_http_${error.status}`;
  return "discord_lifecycle_failed";
}

function retryDelaySeconds(attempts: number, error?: unknown, random: () => number = Math.random): number {
  if (error instanceof DiscordDsaHttpError && error.retryAfterSeconds !== undefined) {
    return Math.max(1, Math.ceil(error.retryAfterSeconds));
  }
  const baseDelay = Math.min(60, 5 * 2 ** attempts);
  const randomValue = Math.max(0, Math.min(1, random()));
  return Math.max(1, Math.round(baseDelay * (0.8 + randomValue * 0.4)));
}

function retryResult(errorCategory: string, delaySeconds: number, error?: unknown): LifecycleJobResult {
  return {
    outcome: "retry_scheduled",
    errorCategory,
    ...(error === undefined ? {} : { error }),
    retryDelayMs: delaySeconds * 1_000,
    submissionCertainty: "not_started"
  };
}

function failedResult(errorCategory: string, error?: unknown): LifecycleJobResult {
  return {
    outcome: "failed", errorCategory, submissionCertainty: "not_started", ...(error === undefined ? {} : { error })
  };
}

function restartingResult(errorCategory: string, error?: unknown): LifecycleJobResult {
  return { outcome: "restarting", errorCategory, submissionCertainty: "not_started", ...(error === undefined ? {} : { error }) };
}

function ambiguousResult(errorCategory: string, error?: unknown): LifecycleJobResult {
  return {
    outcome: "ambiguous", errorCategory, submissionCertainty: "ambiguous", ...(error === undefined ? {} : { error })
  };
}

function completedResult(submissionCertainty: "confirmed"): LifecycleJobResult {
  return { outcome: "completed", submissionCertainty };
}

function ownershipLostResult(): LifecycleJobResult {
  return { outcome: "ownership_lost" };
}
