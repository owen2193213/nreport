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
  trace_id?: string;
}

export interface LifecycleReport {
  id: string;
  trace_id?: string;
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
  discord_report_id: string | null;
}

interface LifecycleStore {
  claimLifecycleJob(): Promise<LifecycleJob | null>;
  heartbeatLifecycleJob(job: LifecycleJob): Promise<boolean>;
  getLifecycleReport(reportId: string): Promise<LifecycleReport | null>;
  setStatus(job: LifecycleJob, status: "requesting_verification" | "verifying"): Promise<boolean>;
  saveAwaitingVerification(job: LifecycleJob, encryptedSession: string): Promise<boolean>;
  beginSubmission(job: LifecycleJob): Promise<boolean>;
  markSubmitted(job: LifecycleJob, discordReportId: string): Promise<boolean>;
  completeLifecycleJob(job: LifecycleJob): Promise<boolean>;
  retryLifecycleJob(job: LifecycleJob, code: string, delaySeconds: number): Promise<boolean>;
  failBeforeSubmission(job: LifecycleJob, code: string, message: string): Promise<boolean>;
  failAfterSubmission(job: LifecycleJob, code: string, message: string): Promise<boolean>;
  markReviewRequested(job: LifecycleJob, discordReportId: string): Promise<boolean>;
  beginReviewSubmission(job: LifecycleJob): Promise<boolean>;
  failReview(job: LifecycleJob, status: "ineligible" | "request_failed" | "request_ambiguous", code: string, message: string): Promise<boolean>;
  expireDeadlines?(): Promise<void>;
  recoverInterruptedJobs?(): Promise<void>;
}

interface LifecycleClient {
  sendEmailCode(flow: "message_urf" | "user_urf" | "guild_urf", email: string): Promise<unknown>;
  snapshotSession(): Promise<DiscordDsaSessionState>;
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
      outcome: "completed" | "failed";
      jobKind: LifecycleJob["kind"];
      attempts: number;
      durationMs: number;
      traceId?: string;
      errorCategory?: string;
    }
  | {
      component: "loop" | "maintenance";
      stage: "lifecycle_claim" | "lifecycle_heartbeat" | "lifecycle_maintenance";
      outcome: "completed" | "failed";
      durationMs: number;
      errorCategory?: string;
    };

export class LifecycleRunner {
  private running: Promise<void>[] | undefined;
  private stopping = false;
  private lastMaintenanceAt = 0;
  private stopSignal: Promise<void> | undefined;
  private resolveStop: (() => void) | undefined;
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
    private readonly onOutcome: (outcome: LifecycleRunnerOutcome) => void | Promise<void> = () => undefined
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
    this.stopSignal = new Promise((resolve) => {
      this.resolveStop = resolve;
    });
    this.running = [
      ...Array.from({ length: this.concurrency }, () => this.jobLoop()),
      this.maintenanceLoop()
    ];
  }

  public async stop(): Promise<void> {
    this.stopping = true;
    this.resolveStop?.();
    await Promise.all(this.running ?? []);
    this.running = undefined;
    this.stopSignal = undefined;
    this.resolveStop = undefined;
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
    let settleHeartbeat!: () => void;
    const settled = new Promise<void>((resolve) => {
      settleHeartbeat = resolve;
    });
    const heartbeat = this.heartbeatJob(job, ownership, settled);
    try {
      await this.dispatchJob(job, ownership);
      this.notify({
        component: "job",
        stage: "lifecycle_job",
        outcome: "completed",
        jobKind: job.kind,
        attempts: job.attempts,
        durationMs: elapsedSince(startedAt),
        ...(job.trace_id === undefined ? {} : { traceId: job.trace_id })
      });
    } catch (error) {
      this.notify({
        component: "job",
        stage: "lifecycle_job",
        outcome: "failed",
        jobKind: job.kind,
        attempts: job.attempts,
        durationMs: elapsedSince(startedAt),
        ...(job.trace_id === undefined ? {} : { traceId: job.trace_id }),
        errorCategory: safeJobErrorCategory(error)
      });
      if (!isOwnershipLost(error)) throw error;
    } finally {
      settleHeartbeat();
      await heartbeat;
    }
  }

  private async dispatchJob(job: LifecycleJob, ownership: JobOwnership): Promise<void> {
    if (job.kind === "request_code") await this.requestCode(job, ownership);
    else if (job.kind === "verify_submit") await this.verifyAndSubmit(job, ownership);
    else await this.submitReview(job, ownership);
  }

  private async submitReview(job: LifecycleJob, ownership: JobOwnership): Promise<void> {
    const report = await this.requiredReport(job.report_id);
    const encryptedReviewUrl = job.payload.encryptedReviewUrl;
    if (typeof encryptedReviewUrl !== "string" || report.discord_report_id === null) {
      await this.store.failReview(job, "request_failed", "review_context_missing", "The automatic appeal could not be prepared.");
      return;
    }
    const decoded = this.codecs.decrypt(encryptedReviewUrl);
    const reviewUrl = typeof decoded === "string" ? decoded : (decoded as { reviewUrl?: unknown }).reviewUrl;
    if (typeof reviewUrl !== "string") {
      await this.store.failReview(job, "request_failed", "review_url_invalid", "The automatic appeal link was invalid.");
      return;
    }
    const client = this.clientFactory(report);
    let submissionStarted = false;
    try {
      await ownership.wait(client.bootstrapFingerprint());
      const token = await ownership.wait(client.resolveReportReviewToken(reviewUrl));
      submissionStarted = await this.store.beginReviewSubmission(job);
      if (!submissionStarted) {
        await this.store.completeLifecycleJob(job);
        return;
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
            await this.store.markReviewRequested(job, report.discord_report_id);
            return;
          }
          throw retryError;
        }
      }
      if (result.report_id !== report.discord_report_id) {
        await this.store.failReview(job, "request_failed", "review_report_id_mismatch", "Discord returned a different report ID for the appeal.");
        return;
      }
      await this.store.markReviewRequested(job, result.report_id);
    } catch (error) {
      if (isOwnershipLost(error)) throw error;
      const responseCode = discordResponseCode(error);
      if (responseCode === "521002") {
        await this.store.markReviewRequested(job, report.discord_report_id);
      } else if (responseCode === "521004") {
        await this.store.failReview(job, "ineligible", "discord_review_ineligible", "Discord says this report is ineligible for appeal.");
      } else if (submissionStarted && ambiguous(error)) {
        await this.store.failReview(job, "request_ambiguous", "review_request_ambiguous", "The automatic appeal outcome could not be confirmed.");
      } else if (!submissionStarted && job.attempts < job.max_attempts && retryable(error)) {
        await this.store.retryLifecycleJob(job, discordFailureCode(error), Math.min(60, 5 * 2 ** job.attempts));
      } else {
        await this.store.failReview(job, "request_failed", "review_request_failed", "Discord did not accept the automatic appeal.");
      }
    } finally {
      await client.close();
    }
  }

  private async requestCode(job: LifecycleJob, ownership: JobOwnership): Promise<void> {
    const report = await this.requiredReport(job.report_id);
    const client = this.clientFactory(report);
    try {
      if (!(await this.store.setStatus(job, "requesting_verification"))) return;
      await ownership.wait(client.sendEmailCode(transportFlow(report.flow), report.reporter_email));
      const session = await ownership.wait(client.snapshotSession());
      await this.store.saveAwaitingVerification(job, this.codecs.encrypt(session));
    } catch (error) {
      if (isOwnershipLost(error)) throw error;
      await this.handleBeforeBoundaryFailure(job, error);
    } finally {
      await client.close();
    }
  }

  private async verifyAndSubmit(job: LifecycleJob, ownership: JobOwnership): Promise<void> {
    const report = await this.requiredReport(job.report_id);
    if (report.session_state === null) {
      await this.store.failBeforeSubmission(job, "session_not_ready", "Verification session was not ready.");
      return;
    }
    const session = this.codecs.decrypt(report.session_state) as DiscordDsaSessionState;
    const rawCode = job.payload.encryptedCode ?? job.payload.code;
    if (typeof rawCode !== "string") {
      await this.store.failBeforeSubmission(job, "verification_code_missing", "Verification code was unavailable.");
      return;
    }
    const decoded = this.codecs.decrypt(rawCode);
    const code = typeof decoded === "string" ? decoded : (decoded as { code?: unknown }).code;
    if (typeof code !== "string") {
      await this.store.failBeforeSubmission(job, "verification_code_invalid", "Verification code was invalid.");
      return;
    }
    const client = this.clientFactory(report, session);
    let crossedBoundary = false;
    try {
      if (!(await this.store.setStatus(job, "verifying"))) return;
      const flow = transportFlow(report.flow);
      const token = await ownership.wait(client.verifyEmailCode(flow, report.reporter_email, code));
      const menu = await ownership.wait(client.getMenu(flow));
      const payload = client.prepareSubmission(
        menu as never,
        toReportDraft({ request: report.request_input, ...report.prepared_input }, report.reporter_legal_name),
        token,
        DISCORD_FORM_LANGUAGE
      );
      crossedBoundary = await this.store.beginSubmission(job);
      if (!crossedBoundary) {
        await this.store.completeLifecycleJob(job);
        return;
      }
      const result = await ownership.wait(client.submitPrepared(payload as never));
      await this.store.markSubmitted(job, result.report_id);
    } catch (error) {
      if (isOwnershipLost(error)) throw error;
      if (crossedBoundary) {
        await this.store.failAfterSubmission(
          job,
          ambiguous(error) ? "ambiguous_submission_state" : discordFailureCode(error),
          "Discord submission started, but its final outcome could not be safely retried."
        );
      } else {
        await this.handleBeforeBoundaryFailure(job, error);
      }
    } finally {
      await client.close();
    }
  }

  private async handleBeforeBoundaryFailure(job: LifecycleJob, error: unknown): Promise<void> {
    const code = discordFailureCode(error);
    if (job.attempts < job.max_attempts && retryable(error)) {
      await this.store.retryLifecycleJob(job, code, Math.min(60, 5 * 2 ** job.attempts));
      return;
    }
    await this.store.failBeforeSubmission(job, code, "Discord preparation failed safely.");
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
      } catch {
        this.notify({
          component: "loop",
          stage: "lifecycle_claim",
          outcome: "failed",
          durationMs: elapsedSince(claimStartedAt),
          errorCategory: "lifecycle_claim_failed"
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

  private async heartbeatJob(job: LifecycleJob, ownership: JobOwnership, settled: Promise<void>): Promise<void> {
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
      } catch {
        this.notify({
          component: "loop",
          stage: "lifecycle_heartbeat",
          outcome: "failed",
          durationMs: elapsedSince(heartbeatStartedAt),
          errorCategory: "lifecycle_heartbeat_failed"
        });
      }
    }
  }

  private async runMaintenance(): Promise<void> {
    const startedAt = Date.now();
    try {
      await Promise.all([
        this.store.recoverInterruptedJobs?.(),
        this.store.expireDeadlines?.()
      ]);
      this.notify({
        component: "maintenance",
        stage: "lifecycle_maintenance",
        outcome: "completed",
        durationMs: elapsedSince(startedAt)
      });
    } catch (error) {
      this.notify({
        component: "maintenance",
        stage: "lifecycle_maintenance",
        outcome: "failed",
        durationMs: elapsedSince(startedAt),
        errorCategory: "lifecycle_maintenance_failed"
      });
      throw error;
    }
  }

  private async waitForStop(milliseconds: number): Promise<void> {
    if (this.stopping) return;
    const stopSignal = this.stopSignal;
    if (stopSignal === undefined) {
      await this.sleep(milliseconds);
      return;
    }
    await this.waitForInterrupt(milliseconds, stopSignal);
  }

  private async waitForInterrupt(milliseconds: number, interrupt: Promise<void>): Promise<boolean> {
    const controller = new AbortController();
    const sleeping = this.sleep(milliseconds, controller.signal).then(
      () => false,
      (error: unknown) => {
        if (controller.signal.aborted) return true;
        throw error;
      }
    );
    try {
      return await Promise.race([sleeping, interrupt.then(() => true)]);
    } finally {
      controller.abort();
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
  return error instanceof DiscordDsaNetworkError ||
    (error instanceof DiscordDsaHttpError && (error.status === 429 || error.status >= 500));
}

function ambiguous(error: unknown): boolean {
  return error instanceof DiscordDsaNetworkError || !(error instanceof DiscordDsaHttpError) || error.status >= 500;
}

function discordFailureCode(error: unknown): string {
  if (error instanceof DiscordDsaNetworkError) return "discord_network_error";
  if (error instanceof DiscordDsaHttpError) return `discord_http_${error.status}`;
  return "discord_lifecycle_failed";
}
