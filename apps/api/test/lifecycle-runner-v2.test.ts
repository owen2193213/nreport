/* eslint-disable @typescript-eslint/require-await */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DiscordDsaHttpError, DiscordDsaNetworkError } from "@discord-dsa/client";

import { LifecycleRunner, type LifecycleFailureSignal } from "../src/lifecycle-runner-v2.js";

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function report() {
  return {
    id: "report-1",
    flow: "message" as const,
    country: "DE",
    reporter_email: "generated@example.test",
    reporter_legal_name: "Generated Name",
    timezone: "Europe/Berlin",
    locale: "de-DE",
    language: "de",
    proxy_session_id: "proxy-session",
    session_state: '{"fingerprint":"fixture-fingerprint","cookies":"fixture-cookies"}',
    status: "requesting_verification",
    request_input: {
      flow: "message" as const,
      useAi: false as const,
      country: "DE",
      category: "sub_other_hate_speech",
      finalText: "Final report text.",
      target: { messageUrl: "https://discord.com/channels/@me/123456789012345678/123456789012345679" }
    },
    prepared_input: {
      country: "DE",
      category: "sub_other_hate_speech",
      description: "Final report text.",
      finalText: "Final report text."
    },
    discord_report_id: "discord-1"
  };
}

describe("LifecycleRunner irreversible boundary", () => {
  it("removes interrupt listeners after repeated idle wait timeouts", async () => {
    class CountingAbortSignal extends EventTarget {
      public aborted = false;
      public activeListeners = 0;
      public maxActiveListeners = 0;
      public addedListeners = 0;
      public removedListeners = 0;

      public override addEventListener(
        type: string,
        listener: EventListenerOrEventListenerObject | null,
        options?: boolean | AddEventListenerOptions
      ): void {
        super.addEventListener(type, listener, options);
        if (type === "abort") {
          this.activeListeners += 1;
          this.addedListeners += 1;
          this.maxActiveListeners = Math.max(this.maxActiveListeners, this.activeListeners);
        }
      }

      public override removeEventListener(
        type: string,
        listener: EventListenerOrEventListenerObject | null,
        options?: boolean | EventListenerOptions
      ): void {
        super.removeEventListener(type, listener, options);
        if (type === "abort") {
          this.activeListeners -= 1;
          this.removedListeners += 1;
        }
      }
    }
    const interrupt = new CountingAbortSignal() as unknown as AbortSignal;
    const runner = new LifecycleRunner({ claimLifecycleJob: vi.fn(async () => null) } as never, {} as never,
      undefined, undefined, async () => undefined);
    const waitForInterrupt = (runner as unknown as {
      waitForInterrupt(milliseconds: number, interrupt: AbortSignal): Promise<boolean>;
    }).waitForInterrupt.bind(runner);

    for (let iteration = 0; iteration < 100; iteration += 1) {
      await waitForInterrupt(1, interrupt);
    }

    const trackedInterrupt = interrupt as unknown as CountingAbortSignal;
    expect(trackedInterrupt.addedListeners).toBe(100);
    expect(trackedInterrupt.removedListeners).toBe(100);
    expect(trackedInterrupt.activeListeners).toBe(0);
    expect(trackedInterrupt.maxActiveListeners).toBe(1);
  });

  it("runs stale-job recovery and deadline expiry during regular maintenance", async () => {
    const store = {
      recoverInterruptedJobs: vi.fn(),
      expireDeadlines: vi.fn(),
      claimLifecycleJob: vi.fn(async () => null)
    };
    const runner = new LifecycleRunner(store as never, {} as never);

    await runner.processOne();

    expect(store.recoverInterruptedJobs).toHaveBeenCalledOnce();
    expect(store.expireDeadlines).toHaveBeenCalledOnce();
    expect(store.recoverInterruptedJobs.mock.invocationCallOrder[0]).toBeLessThan(store.claimLifecycleJob.mock.invocationCallOrder[0]!);
  });

  it("consumes credit before the non-idempotent Discord submit call", async () => {
    const calls: string[] = [];
    const store = {
      claimLifecycleJob: vi.fn(async () => ({ id: "job-1", report_id: "report-1", kind: "verify_submit", payload: { code: "123456" }, attempts: 1, max_attempts: 1 })),
      getLifecycleReport: vi.fn(async () => report()),
      setStatus: vi.fn(async () => { calls.push("verifying"); return true; }),
      beginSubmission: vi.fn(async () => { calls.push("boundary"); return true; }),
      markSubmitted: vi.fn(() => { calls.push("persisted"); return Promise.resolve(true); }),
      completeLifecycleJob: vi.fn(),
      failBeforeSubmission: vi.fn(),
      failAfterSubmission: vi.fn(),
      retryLifecycleJob: vi.fn()
    };
    const client = {
      verifyEmailCode: vi.fn(async () => "token"),
      getMenu: vi.fn(async () => ({})),
      prepareSubmission: vi.fn(() => ({})),
      submitPrepared: vi.fn(async () => { calls.push("discord-submit"); return { report_id: "discord-1" }; }),
      close: vi.fn()
    };
    const runner = new LifecycleRunner(store as never, {} as never, () => client as never, {
      decrypt: (value: string) => value
    });

    await runner.processOne();

    expect(calls).toEqual(["verifying", "boundary", "discord-submit", "persisted"]);
    expect(store.markSubmitted).toHaveBeenCalledWith(expect.objectContaining({ id: "job-1", report_id: "report-1" }), "discord-1");
    expect(store.completeLifecycleJob).not.toHaveBeenCalled();
  });

  it("does not report a confirmed submission when persistence lost job ownership", async () => {
    const outcomes: unknown[] = [];
    const store = {
      claimLifecycleJob: vi.fn(async () => ({ id: "job-1", report_id: "report-1", kind: "verify_submit", payload: { code: "123456" }, attempts: 1, max_attempts: 1 })),
      getLifecycleReport: vi.fn(async () => report()), setStatus: vi.fn(async () => true),
      beginSubmission: vi.fn(async () => true), markSubmitted: vi.fn(async () => false),
      failAfterSubmission: vi.fn(), retryLifecycleJob: vi.fn()
    };
    const client = {
      verifyEmailCode: vi.fn(async () => "token"), getMenu: vi.fn(async () => ({})),
      prepareSubmission: vi.fn(() => ({})), submitPrepared: vi.fn(async () => ({ report_id: "discord-1" })),
      close: vi.fn()
    };
    const runner = new LifecycleRunner(store as never, {} as never, () => client as never,
      { decrypt: (value: string) => value }, undefined, (outcome) => { outcomes.push(outcome); });

    await runner.processOne();

    expect(outcomes.at(-1)).toMatchObject({ component: "job", outcome: "ownership_lost" });
    expect(store.failAfterSubmission).not.toHaveBeenCalled();
    expect(store.retryLifecycleJob).not.toHaveBeenCalled();
    expect(client.submitPrepared).toHaveBeenCalledOnce();
  });

  it("does not report waiting for email when session persistence lost job ownership", async () => {
    const outcomes: unknown[] = [];
    const store = {
      claimLifecycleJob: vi.fn(async () => ({ id: "job-code", report_id: "report-1", kind: "request_code", payload: {}, attempts: 1, max_attempts: 3 })),
      getLifecycleReport: vi.fn(async () => report()), setStatus: vi.fn(async () => true),
      saveAwaitingVerification: vi.fn(async () => false)
    };
    const client = {
      sendEmailCode: vi.fn(async () => undefined), snapshotSession: vi.fn(async () => ({})), close: vi.fn()
    };
    const runner = new LifecycleRunner(store as never, {} as never, () => client as never,
      { encrypt: () => "encrypted-session" }, undefined, (outcome) => { outcomes.push(outcome); });

    await runner.processOne();

    expect(outcomes.at(-1)).toMatchObject({ component: "job", outcome: "ownership_lost" });
    expect(client.sendEmailCode).toHaveBeenCalledOnce();
  });

  it("retains consumed credit and marks an ambiguous outcome after the boundary", async () => {
    const submissionError = new Error("connection lost");
    const outcomes: unknown[] = [];
    const store = {
      claimLifecycleJob: vi.fn(async () => ({ id: "job-1", report_id: "report-1", kind: "verify_submit", payload: { code: "123456" }, attempts: 1, max_attempts: 1 })),
      getLifecycleReport: vi.fn(async () => report()),
      setStatus: vi.fn(async () => true),
      beginSubmission: vi.fn(async () => true),
      markSubmitted: vi.fn(),
      completeLifecycleJob: vi.fn(),
      failBeforeSubmission: vi.fn(),
      failAfterSubmission: vi.fn(),
      retryLifecycleJob: vi.fn()
    };
    const client = {
      verifyEmailCode: vi.fn(async () => "token"),
      getMenu: vi.fn(async () => ({})),
      prepareSubmission: vi.fn(() => ({})),
      submitPrepared: vi.fn(async () => { throw submissionError; }),
      close: vi.fn()
    };
    const runner = new LifecycleRunner(store as never, {} as never, () => client as never, {
      decrypt: (value: string) => value
    }, undefined, (outcome) => { outcomes.push(outcome); });

    await runner.processOne();

    expect(store.failAfterSubmission).toHaveBeenCalledWith(
      expect.objectContaining({ id: "job-1", report_id: "report-1" }),
      "ambiguous_submission_state",
      expect.any(String)
    );
    expect(client.submitPrepared).toHaveBeenCalledTimes(1);
    expect(store.failAfterSubmission).toHaveBeenCalledTimes(1);
    expect(store.retryLifecycleJob).toHaveBeenCalledTimes(0);
    expect(store.markSubmitted).toHaveBeenCalledTimes(0);
    expect(store.failBeforeSubmission).not.toHaveBeenCalled();
    expect(outcomes.at(-1)).toMatchObject({ outcome: "ambiguous", error: submissionError });
  });

  it.each([
    ["request_code" as const, "requesting_verification" as const, "sendEmailCode" as const],
    ["verify_submit" as const, "verifying" as const, "verifyEmailCode" as const]
  ])("completes %s when its status transition is rejected but the claim remains owned", async (kind, status, blockedMethod) => {
    const outcomes: unknown[] = [];
    const job = {
      id: "job-1",
      report_id: "report-1",
      kind,
      payload: { code: "123456" },
      attempts: 1,
      max_attempts: 3,
      execution_token: 1
    };
    const store = {
      claimLifecycleJob: vi.fn().mockResolvedValueOnce(job).mockResolvedValue(null),
      getLifecycleReport: vi.fn(async () => report()),
      setStatus: vi.fn(async () => false),
      completeLifecycleJob: vi.fn(async () => true),
      failBeforeSubmission: vi.fn(),
      retryLifecycleJob: vi.fn()
    };
    const client = {
      sendEmailCode: vi.fn(),
      snapshotSession: vi.fn(),
      verifyEmailCode: vi.fn(),
      getMenu: vi.fn(),
      prepareSubmission: vi.fn(),
      close: vi.fn()
    };
    const runner = new LifecycleRunner(store as never, {} as never, () => client as never, {
      decrypt: (value: string) => value
    }, undefined, (outcome) => { outcomes.push(outcome); });

    await runner.processOne();

    expect(store.setStatus).toHaveBeenCalledWith(job, status);
    expect(store.completeLifecycleJob).toHaveBeenCalledWith(job);
    expect(client[blockedMethod]).not.toHaveBeenCalled();
    expect(client.close).toHaveBeenCalledOnce();
    expect(outcomes.at(-1)).toMatchObject({ component: "job", outcome: "completed" });
  });

  it("completes an obsolete request-code job when verification is already running", async () => {
    const outcomes: unknown[] = [];
    const job = {
      id: "job-code", report_id: "report-1", kind: "request_code" as const,
      payload: {}, attempts: 1, max_attempts: 3, execution_token: 1
    };
    const store = {
      claimLifecycleJob: vi.fn().mockResolvedValueOnce(job).mockResolvedValue(null),
      getLifecycleReport: vi.fn(async () => ({ ...report(), status: "verifying" })),
      completeLifecycleJob: vi.fn(async () => true)
    };
    const client = { sendEmailCode: vi.fn(), close: vi.fn() };
    const runner = new LifecycleRunner(store as never, {} as never, () => client as never,
      undefined, undefined, (outcome) => { outcomes.push(outcome); });

    await runner.processOne();

    expect(store.completeLifecycleJob).toHaveBeenCalledWith(job);
    expect(client.sendEmailCode).not.toHaveBeenCalled();
    expect(outcomes.at(-1)).toMatchObject({ component: "job", outcome: "completed" });
  });
});

describe("LifecycleRunner verify_submit session readiness race", () => {
  it("retries instead of failing when session_state has not been saved yet and attempts remain", async () => {
    const job = {
      id: "job-1", report_id: "report-1", kind: "verify_submit" as const,
      payload: { code: "123456" }, attempts: 1, max_attempts: 3, execution_token: 1
    };
    const store = {
      claimLifecycleJob: vi.fn().mockResolvedValueOnce(job).mockResolvedValue(null),
      getLifecycleReport: vi.fn(async () => ({ ...report(), session_state: null })),
      failBeforeSubmission: vi.fn(),
      retryLifecycleJob: vi.fn(async () => true)
    };
    const runner = new LifecycleRunner(store as never, {} as never, undefined, {
      decrypt: (value: string) => value
    });

    await runner.processOne();

    expect(store.retryLifecycleJob).toHaveBeenCalledWith(job, "session_not_ready", 3);
    expect(store.failBeforeSubmission).not.toHaveBeenCalled();
  });

  it("fails once attempts are exhausted and session_state is still missing", async () => {
    const job = {
      id: "job-1", report_id: "report-1", kind: "verify_submit" as const,
      payload: { code: "123456" }, attempts: 3, max_attempts: 3, execution_token: 1
    };
    const store = {
      claimLifecycleJob: vi.fn().mockResolvedValueOnce(job).mockResolvedValue(null),
      getLifecycleReport: vi.fn(async () => ({ ...report(), session_state: null })),
      failBeforeSubmission: vi.fn(),
      retryLifecycleJob: vi.fn()
    };
    const runner = new LifecycleRunner(store as never, {} as never, undefined, {
      decrypt: (value: string) => value
    });

    await runner.processOne();

    expect(store.retryLifecycleJob).not.toHaveBeenCalled();
    expect(store.failBeforeSubmission).toHaveBeenCalledWith(job, "session_not_ready", "Verification session was not ready.");
  });
});

describe("LifecycleRunner automatic appeal", () => {
  function reviewStore() {
    return {
      claimLifecycleJob: vi.fn(async () => ({
        id: "job-review",
        report_id: "report-1",
        kind: "submit_review",
        payload: { encryptedReviewUrl: "encrypted-review" },
        attempts: 1,
        max_attempts: 3
      })),
      getLifecycleReport: vi.fn(async () => report()),
      beginReviewSubmission: vi.fn(async () => true),
      markReviewRequested: vi.fn().mockResolvedValue(true),
      completeLifecycleJob: vi.fn(),
      retryLifecycleJob: vi.fn(),
      failReview: vi.fn()
    };
  }

  it("retries Discord's first explicit ineligibility response once after ten seconds", async () => {
    const store = reviewStore();
    const ineligible = new DiscordDsaHttpError("ineligible", 400, { responseSummary: "code 521004; rejected" });
    const client = {
      bootstrapFingerprint: vi.fn(),
      resolveReportReviewToken: vi.fn(async () => "review-token"),
      submitReportReviewToken: vi.fn()
        .mockRejectedValueOnce(ineligible)
        .mockResolvedValueOnce({ report_id: "discord-1" }),
      close: vi.fn()
    };
    const sleep = vi.fn(async () => undefined);
    const runner = new LifecycleRunner(store as never, {} as never, () => client as never, {
      decrypt: () => "https://discord.com/report-review#token=private"
    }, sleep);

    await runner.processOne();

    expect(sleep).toHaveBeenCalledWith(10_000);
    expect(client.submitReportReviewToken).toHaveBeenCalledTimes(2);
    expect(store.markReviewRequested).toHaveBeenCalledWith(expect.objectContaining({ id: "job-review", report_id: "report-1" }), "discord-1");
    expect(store.failReview).not.toHaveBeenCalled();
  });

  it("does not report a confirmed appeal when persistence lost job ownership", async () => {
    const outcomes: unknown[] = [];
    const store = reviewStore();
    store.markReviewRequested.mockResolvedValue(false);
    const client = {
      bootstrapFingerprint: vi.fn(),
      resolveReportReviewToken: vi.fn(async () => "review-token"),
      submitReportReviewToken: vi.fn(async () => ({ report_id: "discord-1" })),
      close: vi.fn()
    };
    const runner = new LifecycleRunner(store as never, {} as never, () => client as never,
      { decrypt: () => "https://discord.com/report-review#token=private" }, undefined,
      (outcome) => { outcomes.push(outcome); });

    await runner.processOne();

    expect(outcomes.at(-1)).toMatchObject({ component: "job", outcome: "ownership_lost" });
    expect(store.failReview).not.toHaveBeenCalled();
    expect(client.submitReportReviewToken).toHaveBeenCalledOnce();
  });

  it("records ineligibility after Discord repeats the explicit response", async () => {
    const store = reviewStore();
    const ineligible = new DiscordDsaHttpError("ineligible", 400, { responseSummary: "code 521004; rejected" });
    const client = {
      bootstrapFingerprint: vi.fn(),
      resolveReportReviewToken: vi.fn(async () => "review-token"),
      submitReportReviewToken: vi.fn(async () => { throw ineligible; }),
      close: vi.fn()
    };
    const runner = new LifecycleRunner(store as never, {} as never, () => client as never, {
      decrypt: () => "https://discord.com/report-review#token=private"
    }, async () => undefined);

    await runner.processOne();

    expect(client.submitReportReviewToken).toHaveBeenCalledTimes(2);
    expect(store.failReview).toHaveBeenCalledWith(
      expect.objectContaining({ id: "job-review", report_id: "report-1" }),
      "ineligible",
      "discord_review_ineligible",
      expect.any(String)
    );
  });
});

describe("LifecycleRunner background scheduling", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("claims two eligible jobs while the first job is still running", async () => {
    const jobs = [
      { id: "job-1", report_id: "report-1", kind: "request_code" as const, payload: {}, attempts: 1, max_attempts: 3 },
      { id: "job-2", report_id: "report-2", kind: "request_code" as const, payload: {}, attempts: 1, max_attempts: 3 }
    ];
    const releaseJobs = deferred();
    const started = new Set<string>();
    const store = {
      claimLifecycleJob: vi.fn(async () => jobs.shift() ?? null),
      getLifecycleReport: vi.fn(async (reportId: string) => ({ ...report(), id: reportId })),
      setStatus: vi.fn(async () => true),
      saveAwaitingVerification: vi.fn()
    };
    const runner = new LifecycleRunner(
      store as never,
      { lifecycleConcurrency: 2 } as never,
      (claimedReport) => ({
        sendEmailCode: vi.fn(async () => {
          started.add(claimedReport.id);
          await releaseJobs.promise;
        }),
        snapshotSession: vi.fn(async () => ({})),
        close: vi.fn()
      }) as never,
      { encrypt: () => "encrypted-session" },
      () => new Promise(() => undefined)
    );

    runner.start();
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(started).toEqual(new Set(["report-1", "report-2"]));
    } finally {
      releaseJobs.resolve();
      await runner.stop();
    }
  });

  it("claims a request-code job while an appeal worker is sleeping", async () => {
    const jobs = [
      { id: "job-review", report_id: "report-review", kind: "submit_review" as const, payload: { encryptedReviewUrl: "encrypted-review" }, attempts: 1, max_attempts: 3 },
      { id: "job-code", report_id: "report-code", kind: "request_code" as const, payload: {}, attempts: 1, max_attempts: 3 }
    ];
    const appealSleeping = deferred();
    const releaseAppeal = deferred();
    let requestCodeStarted = false;
    const store = {
      claimLifecycleJob: vi.fn(async () => jobs.shift() ?? null),
      getLifecycleReport: vi.fn(async (reportId: string) => ({ ...report(), id: reportId })),
      beginReviewSubmission: vi.fn(async () => true),
      markReviewRequested: vi.fn().mockResolvedValue(true),
      completeLifecycleJob: vi.fn(),
      retryLifecycleJob: vi.fn(),
      failReview: vi.fn(),
      setStatus: vi.fn(async () => true),
      saveAwaitingVerification: vi.fn().mockResolvedValue(true)
    };
    const ineligible = new DiscordDsaHttpError("ineligible", 400, { responseSummary: "code 521004; rejected" });
    const runner = new LifecycleRunner(
      store as never,
      { lifecycleConcurrency: 2 } as never,
      (claimedReport) => claimedReport.id === "report-review" ? ({
        bootstrapFingerprint: vi.fn(),
        resolveReportReviewToken: vi.fn(async () => "review-token"),
        submitReportReviewToken: vi.fn()
          .mockRejectedValueOnce(ineligible)
          .mockResolvedValueOnce({ report_id: "discord-1" }),
        close: vi.fn()
      }) as never : ({
        sendEmailCode: vi.fn(async () => { requestCodeStarted = true; }),
        snapshotSession: vi.fn(async () => ({})),
        close: vi.fn()
      }) as never,
      { decrypt: () => "https://discord.com/report-review#token=private", encrypt: () => "encrypted-session" },
      async (milliseconds) => {
        if (milliseconds === 10_000) {
          appealSleeping.resolve();
          await releaseAppeal.promise;
        } else {
          await new Promise(() => undefined);
        }
      }
    );

    runner.start();
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(requestCodeStarted).toBe(true);
    } finally {
      releaseAppeal.resolve();
      await runner.stop();
    }
  });

  it("releases a worker slot after an unexpected job failure", async () => {
    const jobs = [
      { id: "job-missing", report_id: "report-missing", kind: "request_code" as const, payload: {}, attempts: 1, max_attempts: 3 },
      { id: "job-code", report_id: "report-code", kind: "request_code" as const, payload: {}, attempts: 1, max_attempts: 3 }
    ];
    let requestCodeStarted = false;
    const store = {
      claimLifecycleJob: vi.fn(async () => jobs.shift() ?? null),
      getLifecycleReport: vi.fn(async (reportId: string) => reportId === "report-missing" ? null : ({ ...report(), id: reportId })),
      setStatus: vi.fn(async () => true),
      saveAwaitingVerification: vi.fn()
    };
    const runner = new LifecycleRunner(
      store as never,
      { lifecycleConcurrency: 1 } as never,
      () => ({
        sendEmailCode: vi.fn(async () => { requestCodeStarted = true; }),
        snapshotSession: vi.fn(async () => ({})),
        close: vi.fn()
      }) as never,
      { encrypt: () => "encrypted-session" },
      async (milliseconds) => {
        if (milliseconds === 1_500) return;
        await new Promise(() => undefined);
      }
    );

    runner.start();
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(requestCodeStarted).toBe(true);
    } finally {
      await runner.stop();
    }
  });

  it("runs maintenance again while a lifecycle job remains stalled", async () => {
    const jobStalled = deferred();
    const releaseJob = deferred();
    let maintenanceWaits = 0;
    const store = {
      recoverInterruptedJobs: vi.fn(),
      expireDeadlines: vi.fn(),
      claimLifecycleJob: vi.fn()
        .mockResolvedValueOnce({ id: "job-1", report_id: "report-1", kind: "request_code", payload: {}, attempts: 1, max_attempts: 3 })
        .mockResolvedValue(null),
      getLifecycleReport: vi.fn(async () => report()),
      setStatus: vi.fn(async () => true),
      saveAwaitingVerification: vi.fn()
    };
    const runner = new LifecycleRunner(
      store as never,
      { lifecycleConcurrency: 1 } as never,
      () => ({
        sendEmailCode: vi.fn(async () => {
          jobStalled.resolve();
          await releaseJob.promise;
        }),
        snapshotSession: vi.fn(async () => ({})),
        close: vi.fn()
      }) as never,
      { encrypt: () => "encrypted-session" },
      async (milliseconds) => {
        if (milliseconds === 30_000 && maintenanceWaits++ === 0) {
          await jobStalled.promise;
          return;
        }
        await new Promise(() => undefined);
      }
    );

    runner.start();
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(store.recoverInterruptedJobs).toHaveBeenCalledTimes(2);
      expect(store.expireDeadlines).toHaveBeenCalledTimes(2);
    } finally {
      releaseJob.resolve();
      await runner.stop();
    }
  });

  it("stops promptly while the maintenance cadence is waiting", async () => {
    const store = { claimLifecycleJob: vi.fn(async () => null), recoverInterruptedJobs: vi.fn(), expireDeadlines: vi.fn() };
    const runner = new LifecycleRunner(
      store as never,
      { lifecycleConcurrency: 1 } as never,
      undefined,
      undefined
    );
    runner.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(store.claimLifecycleJob).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(2);

    const stopPromise = runner.stop();
    await vi.advanceTimersByTimeAsync(0);
    await stopPromise;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("heartbeats a live post-boundary job while maintenance continues", async () => {
    const releaseSubmission = deferred<{ report_id: string }>();
    const store = {
      recoverInterruptedJobs: vi.fn(),
      expireDeadlines: vi.fn(),
      claimLifecycleJob: vi.fn()
        .mockResolvedValueOnce({ id: "job-1", report_id: "report-1", kind: "verify_submit", payload: { code: "123456" }, attempts: 1, max_attempts: 3, execution_token: 1 })
        .mockResolvedValue(null),
      heartbeatLifecycleJob: vi.fn(async () => true),
      getLifecycleReport: vi.fn(async () => report()),
      setStatus: vi.fn(async () => true),
      beginSubmission: vi.fn(async () => true),
      markSubmitted: vi.fn(),
      completeLifecycleJob: vi.fn(),
      failBeforeSubmission: vi.fn(),
      failAfterSubmission: vi.fn(),
      retryLifecycleJob: vi.fn()
    };
    const client = {
      verifyEmailCode: vi.fn(async () => "token"),
      getMenu: vi.fn(async () => ({})),
      prepareSubmission: vi.fn(() => ({})),
      submitPrepared: vi.fn(() => releaseSubmission.promise),
      close: vi.fn()
    };
    const runner = new LifecycleRunner(
      store as never,
      { lifecycleConcurrency: 1 } as never,
      () => client as never,
      { decrypt: (value: string) => value },
      (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))
    );

    runner.start();
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(store.beginSubmission).toHaveBeenCalledOnce();

      await vi.advanceTimersByTimeAsync(30_000);

      expect(store.heartbeatLifecycleJob).toHaveBeenCalledWith(expect.objectContaining({ id: "job-1", execution_token: 1 }));
      expect(store.recoverInterruptedJobs.mock.calls.length).toBeGreaterThanOrEqual(2);
      expect(store.expireDeadlines.mock.calls.length).toBeGreaterThanOrEqual(2);

      releaseSubmission.resolve({ report_id: "discord-1" });
      await vi.advanceTimersByTimeAsync(0);
      const settledHeartbeatCount = store.heartbeatLifecycleJob.mock.calls.length;
      await vi.advanceTimersByTimeAsync(30_000);
      expect(store.heartbeatLifecycleJob).toHaveBeenCalledTimes(settledHeartbeatCount);
    } finally {
      releaseSubmission.resolve({ report_id: "discord-1" });
      await vi.advanceTimersByTimeAsync(0);
      await runner.stop();
    }
  });

  it("abandons a stalled submission and closes its client when heartbeat ownership is lost", async () => {
    const releaseSubmission = deferred<{ report_id: string }>();
    const job = { id: "job-1", report_id: "report-1", kind: "verify_submit" as const, payload: { code: "123456" }, attempts: 1, max_attempts: 3, execution_token: 1 };
    const store = {
      recoverInterruptedJobs: vi.fn(),
      expireDeadlines: vi.fn(),
      claimLifecycleJob: vi.fn().mockResolvedValueOnce(job).mockResolvedValue(null),
      heartbeatLifecycleJob: vi.fn(async () => false),
      getLifecycleReport: vi.fn(async () => report()),
      setStatus: vi.fn(async () => true),
      beginSubmission: vi.fn(async () => true),
      markSubmitted: vi.fn(),
      completeLifecycleJob: vi.fn(),
      failBeforeSubmission: vi.fn(),
      failAfterSubmission: vi.fn(),
      retryLifecycleJob: vi.fn()
    };
    const client = {
      verifyEmailCode: vi.fn(async () => "token"),
      getMenu: vi.fn(async () => ({})),
      prepareSubmission: vi.fn(() => ({})),
      submitPrepared: vi.fn(() => releaseSubmission.promise),
      close: vi.fn()
    };
    const runner = new LifecycleRunner(
      store as never,
      { lifecycleConcurrency: 1 } as never,
      () => client as never,
      { decrypt: (value: string) => value },
      (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))
    );

    runner.start();
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(client.submitPrepared).toHaveBeenCalledOnce();

      await vi.advanceTimersByTimeAsync(30_000);

      expect(store.heartbeatLifecycleJob).toHaveBeenCalledWith(job);
      expect(client.close).toHaveBeenCalledOnce();
      expect(store.markSubmitted).not.toHaveBeenCalled();
      expect(store.failAfterSubmission).not.toHaveBeenCalled();
      expect(store.retryLifecycleJob).not.toHaveBeenCalled();
    } finally {
      releaseSubmission.resolve({ report_id: "discord-1" });
      await vi.advanceTimersByTimeAsync(0);
      await runner.stop();
    }
  });
});

describe("LifecycleRunner safe outcomes", () => {
  it("persists initialized client state without bootstrapping in retry cleanup", async () => {
    const job = {
      id: "job-1", report_id: "report-1", kind: "request_code" as const,
      payload: {}, attempts: 1, max_attempts: 3, execution_token: 1
    };
    const initializedSession = { fingerprint: "sticky-fingerprint", cookies: "sticky-cookies" };
    const retryLifecycleJob = vi.fn(async () => true);
    const store = {
      claimLifecycleJob: vi.fn(async () => job),
      getLifecycleReport: vi.fn(async () => ({ ...report(), session_state: null })),
      setStatus: vi.fn(async () => true),
      retryLifecycleJob
    };
    const runner = new LifecycleRunner(
      store as never,
      {} as never,
      () => ({
        sendEmailCode: vi.fn(async () => {
          throw new DiscordDsaNetworkError("Network request failed.", {
            cause: Object.assign(new Error("socket reset"), { code: "ECONNRESET" })
          });
        }),
        snapshotSession: vi.fn(),
        snapshotInitializedSession: vi.fn(() => initializedSession),
        close: vi.fn()
      }) as never,
      { encrypt: (value: unknown) => JSON.stringify(value) }
    );

    await runner.processOne();

    expect(retryLifecycleJob).toHaveBeenCalledWith(
      job, "discord_network_error", expect.any(Number), {
        recordConnectionProgress: true,
        encryptedSession: JSON.stringify(initializedSession)
      }
    );
  });

  it("reuses an encrypted verification token and session after a safe menu retry", async () => {
    const session = { fingerprint: "sticky-fingerprint", cookies: "cookie-state" };
    let persistedSession = JSON.stringify(session);
    const firstJob = {
      id: "job-1", report_id: "report-1", kind: "verify_submit" as const,
      payload: { code: JSON.stringify("123456") }, attempts: 1, max_attempts: 3, execution_token: 1
    };
    const secondJob = {
      ...firstJob, attempts: 2, execution_token: 2,
      payload: { encryptedVerifiedToken: JSON.stringify({ token: "verified-token" }) }
    };
    const verifyEmailCode = vi.fn(async () => "verified-token");
    const prepareSubmission = vi.fn(() => ({}));
    const retryLifecycleJob = vi.fn(async (_job: unknown, _code: string, _delay: number, options?: { encryptedSession?: string }) => {
      if (options?.encryptedSession !== undefined) persistedSession = options.encryptedSession;
      return true;
    });
    let clientIndex = 0;
    const store = {
      claimLifecycleJob: vi.fn().mockResolvedValueOnce(firstJob).mockResolvedValueOnce(secondJob).mockResolvedValue(null),
      getLifecycleReport: vi.fn(async () => ({ ...report(), session_state: persistedSession })),
      setStatus: vi.fn(async () => true),
      retryLifecycleJob,
      beginSubmission: vi.fn(async () => true),
      markSubmitted: vi.fn(async () => true)
    };
    const runner = new LifecycleRunner(
      store as never,
      {} as never,
      () => {
        const current = clientIndex++;
        return {
          verifyEmailCode,
          getMenu: vi.fn(async () => {
            if (current === 0) {
              throw new DiscordDsaNetworkError("Network request failed.", {
                cause: Object.assign(new Error("socket reset"), { code: "ECONNRESET" })
              });
            }
            return {};
          }),
          prepareSubmission,
          submitPrepared: vi.fn(async () => ({ report_id: "discord-report" })),
          snapshotInitializedSession: vi.fn(() => ({ ...session, cookies: "updated-cookies" })),
          close: vi.fn()
        } as never;
      },
      {
        decrypt: (value: string) => {
          try { return JSON.parse(value) as unknown; } catch { return value; }
        },
        encrypt: (value: unknown) => JSON.stringify(value)
      }
    );

    await runner.processOne();
    expect(retryLifecycleJob).toHaveBeenCalledWith(
      firstJob, "discord_network_error", expect.any(Number), {
        recordConnectionProgress: true,
        encryptedSession: JSON.stringify({ ...session, cookies: "updated-cookies" }),
        encryptedVerifiedToken: JSON.stringify({ token: "verified-token" })
      }
    );
    await runner.processOne();

    expect(verifyEmailCode).toHaveBeenCalledOnce();
    expect(prepareSubmission).toHaveBeenCalledWith(expect.anything(), expect.anything(), "verified-token", expect.any(String));
    expect(store.beginSubmission).toHaveBeenCalledOnce();
  });

  it("restarts once after the final safe attempt for a transient connection failure", async () => {
    const outcomes: unknown[] = [];
    const job = {
      id: "job-1", report_id: "report-1", trace_id: "33333333-3333-4333-8333-333333333333",
      kind: "request_code" as const, payload: {}, attempts: 3, max_attempts: 3, execution_token: 3
    };
    const store = {
      claimLifecycleJob: vi.fn(async () => job),
      getLifecycleReport: vi.fn(async () => ({ ...report(), session_state: null })),
      setStatus: vi.fn(async () => true),
      failBeforeSubmission: vi.fn(async () => "restarted" as const),
      retryLifecycleJob: vi.fn(async () => true)
    };
    const runner = new LifecycleRunner(
      store as never,
      {} as never,
      () => ({
        sendEmailCode: vi.fn(async () => {
          throw new DiscordDsaNetworkError("Network request failed.", { cause: Object.assign(new Error("socket reset"), { code: "ECONNRESET" }) });
        }),
        snapshotSession: vi.fn(), close: vi.fn()
      }) as never,
      undefined,
      undefined,
      (outcome) => { outcomes.push(outcome); },
      () => 0.5
    );

    await runner.processOne();

    expect(store.failBeforeSubmission).toHaveBeenCalledWith(
      job, "discord_network_error", "Discord preparation failed safely.", true
    );
    expect(store.retryLifecycleJob).not.toHaveBeenCalled();
    expect(outcomes.at(-1)).toMatchObject({ component: "job", outcome: "restarting", errorCategory: "discord_network_error" });
  });

  it.each([
    {
      name: "a nested ECONNREFUSED inside AggregateError",
      cause: new AggregateError([Object.assign(new Error("proxy refused the connection"), { code: "ECONNREFUSED" })]),
      eligible: true
    },
    {
      name: "a TLS certificate failure alongside a reset connection",
      cause: new AggregateError([
        Object.assign(new Error("connection reset"), { code: "ECONNRESET" }),
        Object.assign(new Error("certificate hostname mismatch"), { code: "ERR_TLS_CERT_ALTNAME_INVALID" })
      ]),
      eligible: false
    }
  ])("classifies $name without overriding permanent TLS causes", async ({ cause, eligible }) => {
    const job = {
      id: "job-1", report_id: "report-1", kind: "request_code" as const,
      payload: {}, attempts: 3, max_attempts: 3, execution_token: 3
    };
    const store = {
      claimLifecycleJob: vi.fn(async () => job),
      getLifecycleReport: vi.fn(async () => ({ ...report(), session_state: null })),
      setStatus: vi.fn(async () => true),
      failBeforeSubmission: vi.fn(async () => true),
      retryLifecycleJob: vi.fn(async () => true)
    };
    const runner = new LifecycleRunner(
      store as never,
      {} as never,
      () => ({
        sendEmailCode: vi.fn(async () => { throw new DiscordDsaNetworkError("Network request failed.", { cause }); }),
        snapshotSession: vi.fn(), close: vi.fn()
      }) as never
    );

    await runner.processOne();

    expect(store.failBeforeSubmission).toHaveBeenCalledWith(
      job, "discord_network_error", "Discord preparation failed safely.", eligible
    );
  });

  it("does not retry permanent DNS failures or spend the automatic restart budget", async () => {
    const job = {
      id: "job-1", report_id: "report-1", kind: "request_code" as const,
      payload: {}, attempts: 1, max_attempts: 3, execution_token: 1
    };
    const store = {
      claimLifecycleJob: vi.fn(async () => job),
      getLifecycleReport: vi.fn(async () => report()),
      setStatus: vi.fn(async () => true),
      failBeforeSubmission: vi.fn(async () => true),
      retryLifecycleJob: vi.fn(async () => true)
    };
    const runner = new LifecycleRunner(
      store as never,
      {} as never,
      () => ({
        sendEmailCode: vi.fn(async () => {
          throw new DiscordDsaNetworkError("Network request failed.", { cause: Object.assign(new Error("DNS name not found"), { code: "ENOTFOUND" }) });
        }),
        snapshotSession: vi.fn(), close: vi.fn()
      }) as never
    );

    await runner.processOne();

    expect(store.failBeforeSubmission).toHaveBeenCalledWith(
      job, "discord_network_error", "Discord preparation failed safely.", false
    );
    expect(store.retryLifecycleJob).not.toHaveBeenCalled();
  });

  it("does not turn a Discord rate limit into a fresh lifecycle restart", async () => {
    const job = {
      id: "job-1", report_id: "report-1", kind: "request_code" as const,
      payload: {}, attempts: 3, max_attempts: 3, execution_token: 3
    };
    const store = {
      claimLifecycleJob: vi.fn(async () => job),
      getLifecycleReport: vi.fn(async () => ({ ...report(), session_state: null })),
      setStatus: vi.fn(async () => true),
      failBeforeSubmission: vi.fn(async () => true),
      retryLifecycleJob: vi.fn(async () => true)
    };
    const runner = new LifecycleRunner(
      store as never,
      {} as never,
      () => ({
        sendEmailCode: vi.fn(async () => { throw new DiscordDsaHttpError("rate limited", 429, { retryAfterSeconds: 47 }); }),
        snapshotSession: vi.fn(), close: vi.fn()
      }) as never,
      undefined,
      undefined,
      undefined,
      () => 0
    );

    await runner.processOne();

    expect(store.failBeforeSubmission).toHaveBeenCalledWith(
      job, "discord_http_429", "Discord preparation failed safely.", false
    );
    expect(store.retryLifecycleJob).not.toHaveBeenCalled();
  });

  it("bounds jitter to twenty percent around the existing safe retry delay", async () => {
    const delays: number[] = [];
    for (const randomValue of [0, 1]) {
      const job = {
        id: "job-1", report_id: "report-1", kind: "request_code" as const,
        payload: {}, attempts: 1, max_attempts: 3, execution_token: 1
      };
      const store = {
        claimLifecycleJob: vi.fn(async () => job),
        getLifecycleReport: vi.fn(async () => report()),
        setStatus: vi.fn(async () => true),
        retryLifecycleJob: vi.fn(async (_job: unknown, _code: string, delaySeconds: number) => {
          delays.push(delaySeconds);
          return true;
        })
      };
      const runner = new LifecycleRunner(
        store as never,
        {} as never,
        () => ({
          sendEmailCode: vi.fn(async () => {
            throw new DiscordDsaNetworkError("Network request failed.", { cause: Object.assign(new Error("socket reset"), { code: "ECONNRESET" }) });
          }),
          snapshotSession: vi.fn(), close: vi.fn()
        }) as never,
        undefined,
        undefined,
        undefined,
        () => randomValue
      );

      await runner.processOne();
    }

    expect(delays).toEqual([8, 12]);
  });

  it("persists client construction failures as terminal lifecycle failures", async () => {
    const job = {
      id: "job-1", report_id: "report-1", kind: "request_code" as const,
      payload: {}, attempts: 1, max_attempts: 3, execution_token: 1
    };
    const store = {
      claimLifecycleJob: vi.fn(async () => job),
      getLifecycleReport: vi.fn(async () => report()),
      setStatus: vi.fn(async () => true),
      failBeforeSubmission: vi.fn(async () => true),
      retryLifecycleJob: vi.fn(async () => true)
    };
    const runner = new LifecycleRunner(store as never, {} as never, () => {
      throw new TypeError("Invalid proxy configuration.");
    });

    await expect(runner.processOne()).resolves.toBe(true);

    expect(store.failBeforeSubmission).toHaveBeenCalledWith(
      job, "discord_lifecycle_failed", "Discord preparation failed safely.", false
    );
    expect(store.retryLifecycleJob).not.toHaveBeenCalled();
  });

  it("reports a scheduled retry instead of a completed lifecycle job", async () => {
    const outcomes: unknown[] = [];
    const retryable = new DiscordDsaHttpError("temporarily unavailable", 503);
    const store = {
      claimLifecycleJob: vi.fn(async () => ({
        id: "job-1", report_id: "report-1", trace_id: "33333333-3333-4333-8333-333333333333",
        kind: "request_code" as const, payload: {}, attempts: 1, max_attempts: 3, execution_token: 1
      })),
      getLifecycleReport: vi.fn(async () => report()),
      setStatus: vi.fn(async () => true),
      retryLifecycleJob: vi.fn(async () => true)
    };
    const runner = new LifecycleRunner(
      store as never,
      {} as never,
      () => ({ sendEmailCode: vi.fn(async () => { throw retryable; }), close: vi.fn() }) as never,
      undefined,
      undefined,
      (outcome) => { outcomes.push(outcome); },
      () => 0.5
    );

    await runner.processOne();

    expect(outcomes.at(-1)).toMatchObject({
      component: "job", stage: "lifecycle_job", outcome: "retry_scheduled",
      jobKind: "request_code", attempts: 1, errorCategory: "discord_http_503", retryDelayMs: 10_000
    });
  });

  it("honors Discord's Retry-After delay for a retryable lifecycle request", async () => {
    const rateLimited = new DiscordDsaHttpError("rate limited", 429, { retryAfterSeconds: 47 });
    const store = {
      claimLifecycleJob: vi.fn(async () => ({
        id: "job-1", report_id: "report-1", kind: "request_code" as const,
        payload: {}, attempts: 1, max_attempts: 3, execution_token: 1
      })),
      getLifecycleReport: vi.fn(async () => report()),
      setStatus: vi.fn(async () => true),
      retryLifecycleJob: vi.fn(async () => true)
    };
    const runner = new LifecycleRunner(
      store as never, {} as never,
      () => ({ sendEmailCode: vi.fn(async () => { throw rateLimited; }), close: vi.fn() }) as never,
      undefined, undefined, undefined, () => 0.5
    );

    await runner.processOne();

    expect(store.retryLifecycleJob).toHaveBeenCalledWith(expect.anything(), "discord_http_429", 47);
  });

  it("stops cleanly when Retry-After exceeds the bounded wait, without an automatic restart", async () => {
    const outcomes: unknown[] = [];
    const job = {
      id: "job-1", report_id: "report-1", kind: "request_code" as const,
      payload: {}, attempts: 3, max_attempts: 3, execution_token: 3
    };
    const store = {
      claimLifecycleJob: vi.fn(async () => job),
      getLifecycleReport: vi.fn(async () => report()),
      setStatus: vi.fn(async () => true),
      retryLifecycleJob: vi.fn(async () => true),
      failBeforeSubmission: vi.fn(async () => true)
    };
    const serverWait = new DiscordDsaHttpError("temporarily unavailable", 503, { retryAfterSeconds: 301 });
    const runner = new LifecycleRunner(
      store as never,
      {} as never,
      () => ({ sendEmailCode: vi.fn(async () => { throw serverWait; }), close: vi.fn() }) as never,
      { decrypt: (value: string) => value, encrypt: () => "encrypted-session" },
      undefined, (outcome) => { outcomes.push(outcome); }
    );

    await runner.processOne();

    expect(store.retryLifecycleJob).not.toHaveBeenCalled();
    expect(outcomes.at(-1)).toMatchObject({ error: serverWait });
    expect(store.failBeforeSubmission).toHaveBeenCalledWith(
      job, "discord_http_503", "Discord preparation failed safely.", false
    );
  });

  it("does not claim a retry when its durable transition loses ownership", async () => {
    const outcomes: unknown[] = [];
    const retryable = new DiscordDsaHttpError("temporarily unavailable", 503);
    const store = {
      claimLifecycleJob: vi.fn(async () => ({
        id: "job-1", report_id: "report-1", kind: "request_code" as const,
        payload: {}, attempts: 1, max_attempts: 3, execution_token: 1
      })),
      getLifecycleReport: vi.fn(async () => report()),
      setStatus: vi.fn(async () => true),
      retryLifecycleJob: vi.fn(async () => false)
    };
    const runner = new LifecycleRunner(
      store as never, {} as never,
      () => ({ sendEmailCode: vi.fn(async () => { throw retryable; }), close: vi.fn() }) as never,
      undefined, undefined, (outcome) => { outcomes.push(outcome); }
    );

    await runner.processOne();

    expect(outcomes.at(-1)).toMatchObject({ component: "job", outcome: "ownership_lost" });
  });

  it("keeps the job trace on a safe heartbeat failure outcome", async () => {
    vi.useFakeTimers();
    const releaseSubmission = deferred<{ report_id: string }>();
    const outcomes: unknown[] = [];
    const job = {
      id: "sensitive-job-id", report_id: "11111111-1111-4111-8111-111111111111",
      trace_id: "33333333-3333-4333-8333-333333333333",
      kind: "verify_submit" as const, payload: { code: "123456" },
      attempts: 1, max_attempts: 3, execution_token: 1
    };
    const store = {
      recoverInterruptedJobs: vi.fn(), expireDeadlines: vi.fn(),
      claimLifecycleJob: vi.fn().mockResolvedValueOnce(job).mockResolvedValue(null),
      heartbeatLifecycleJob: vi.fn().mockRejectedValueOnce(new Error("sensitive database URL")),
      getLifecycleReport: vi.fn(async () => report()), setStatus: vi.fn(async () => true),
      beginSubmission: vi.fn(async () => true), markSubmitted: vi.fn(),
      completeLifecycleJob: vi.fn(), failBeforeSubmission: vi.fn(), failAfterSubmission: vi.fn(),
      retryLifecycleJob: vi.fn()
    };
    const runner = new LifecycleRunner(
      store as never, { lifecycleConcurrency: 1 } as never,
      () => ({
        verifyEmailCode: vi.fn(async () => "token"), getMenu: vi.fn(async () => ({})),
        prepareSubmission: vi.fn(() => ({})), submitPrepared: vi.fn(() => releaseSubmission.promise),
        close: vi.fn()
      }) as never,
      { decrypt: (value: string) => value },
      (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
      (outcome) => { outcomes.push(outcome); }
    );

    runner.start();
    try {
      await vi.advanceTimersByTimeAsync(30_000);
      expect(outcomes).toContainEqual(expect.objectContaining({
        component: "job", reportId: "11111111-1111-4111-8111-111111111111", traceId: "33333333-3333-4333-8333-333333333333",
        stage: "lifecycle_heartbeat", outcome: "failed",
        durationMs: expect.any(Number) as number,
        errorCategory: "lifecycle_heartbeat_failed"
      }));
      expect(JSON.stringify(outcomes)).not.toMatch(/123456|database URL/);
    } finally {
      releaseSubmission.resolve({ report_id: "discord-1" });
      await vi.advanceTimersByTimeAsync(0);
      await runner.stop();
      vi.useRealTimers();
    }
  });

  it("reports a failed job with operational fields only", async () => {
    const outcomes: unknown[] = [];
    const store = {
      recoverInterruptedJobs: vi.fn(),
      expireDeadlines: vi.fn(),
      claimLifecycleJob: vi.fn(async () => ({
        id: "sensitive-job-id",
        report_id: "11111111-1111-4111-8111-111111111111",
        trace_id: "33333333-3333-4333-8333-333333333333",
        kind: "request_code",
        payload: { evidence: "sensitive evidence", code: "123456" },
        attempts: 2,
        max_attempts: 3
      })),
      getLifecycleReport: vi.fn(async () => { throw new Error("sensitive provider response"); })
    };
    const runner = new LifecycleRunner(
      store as never,
      {} as never,
      undefined,
      undefined,
      undefined,
      (outcome) => { outcomes.push(outcome); }
    );

    await expect(runner.processOne()).rejects.toThrow("sensitive provider response");

    expect(outcomes.at(-1)).toMatchObject({
      component: "job",
      traceId: "33333333-3333-4333-8333-333333333333",
      stage: "lifecycle_job",
      outcome: "failed",
      jobKind: "request_code",
      attempts: 2,
      errorCategory: "lifecycle_job_failed"
    });
    expect(typeof (outcomes.at(-1) as { durationMs: unknown }).durationMs).toBe("number");
    expect(JSON.stringify(outcomes)).not.toMatch(/123456|provider response/);
  });

  it("reports maintenance completion without identifiers or payload data", async () => {
    const outcomes: unknown[] = [];
    const store = {
      recoverInterruptedJobs: vi.fn(),
      expireDeadlines: vi.fn(),
      claimLifecycleJob: vi.fn(async () => null)
    };
    const runner = new LifecycleRunner(
      store as never,
      {} as never,
      undefined,
      undefined,
      undefined,
      (outcome) => { outcomes.push(outcome); }
    );

    await runner.processOne();

    const maintenanceOutcome = outcomes.find(
      (outcome) => (outcome as { component?: string }).component === "maintenance"
    );
    expect(maintenanceOutcome).toMatchObject({
      component: "maintenance",
      stage: "lifecycle_maintenance",
      outcome: "completed"
    });
    expect(typeof (maintenanceOutcome as { durationMs: unknown }).durationMs).toBe("number");
  });

  it("surfaces committed receipt deadlines and recovered ambiguous reports with correlation", async () => {
    const outcomes: unknown[] = [];
    const store = {
      recoverInterruptedJobs: vi.fn().mockResolvedValue([{
        reportId: "22222222-2222-4222-8222-222222222222",
        traceId: "44444444-4444-4444-8444-444444444444",
        lifecycleAttempt: 2,
        stage: "submitting",
        eventType: "report_failed",
        outcome: "ambiguous",
        errorCategory: "ambiguous_submission_state"
      }]),
      expireDeadlines: vi.fn((onFailure?: (failure: LifecycleFailureSignal) => void) => {
        onFailure?.({
          reportId: "11111111-1111-4111-8111-111111111111",
          traceId: "33333333-3333-4333-8333-333333333333",
          lifecycleAttempt: 1,
          stage: "submitted",
          eventType: "report_receipt_timeout",
          outcome: "failed",
          errorCategory: "discord_receipt_timeout"
        });
        return Promise.resolve();
      }),
      claimLifecycleJob: vi.fn(async () => null)
    };
    const runner = new LifecycleRunner(
      store as never,
      {} as never,
      undefined,
      undefined,
      undefined,
      (outcome) => { outcomes.push(outcome); }
    );

    await runner.processOne();

    expect(outcomes).toContainEqual(expect.objectContaining({
      component: "report_failure",
      stage: "submitted",
      outcome: "failed",
      reportId: "11111111-1111-4111-8111-111111111111",
      traceId: "33333333-3333-4333-8333-333333333333",
      eventType: "report_receipt_timeout",
      errorCategory: "discord_receipt_timeout"
    }));
    expect(outcomes).toContainEqual(expect.objectContaining({
      component: "report_failure",
      stage: "submitting",
      outcome: "ambiguous",
      reportId: "22222222-2222-4222-8222-222222222222",
      traceId: "44444444-4444-4444-8444-444444444444",
      eventType: "report_failed",
      errorCategory: "ambiguous_submission_state"
    }));
  });

  it("reports a claim-loop failure using a fixed safe category and keeps running", async () => {
    vi.useFakeTimers();
    const outcomes: unknown[] = [];
    const store = {
      recoverInterruptedJobs: vi.fn(),
      expireDeadlines: vi.fn(),
      claimLifecycleJob: vi.fn()
        .mockRejectedValueOnce(new Error("sensitive database URL"))
        .mockResolvedValue(null)
    };
    const runner = new LifecycleRunner(
      store as never,
      { lifecycleConcurrency: 1 } as never,
      undefined,
      undefined,
      async (milliseconds) => {
        if (milliseconds === 1_500) return;
        await new Promise(() => undefined);
      },
      (outcome) => { outcomes.push(outcome); }
    );

    runner.start();
    try {
      await vi.advanceTimersByTimeAsync(0);
      const loopOutcome = outcomes.find(
        (outcome) => (outcome as { component?: string }).component === "loop"
      );
      expect(loopOutcome).toMatchObject({
        component: "loop",
        stage: "lifecycle_claim",
        outcome: "failed",
        errorCategory: "lifecycle_claim_failed"
      });
      expect(typeof (loopOutcome as { durationMs: unknown }).durationMs).toBe("number");
      expect(JSON.stringify(outcomes)).not.toContain("sensitive database URL");
    } finally {
      await runner.stop();
      vi.useRealTimers();
    }
  });

  it("isolates synchronous observer throws", async () => {
    const store = {
      recoverInterruptedJobs: vi.fn(),
      expireDeadlines: vi.fn(),
      claimLifecycleJob: vi.fn(async () => null)
    };
    const runner = new LifecycleRunner(
      store as never,
      {} as never,
      undefined,
      undefined,
      undefined,
      () => { throw new Error("observer failed"); }
    );

    await expect(runner.processOne()).resolves.toBe(false);
  });

  it("isolates asynchronous observer rejections without an unhandled rejection", async () => {
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    const store = {
      recoverInterruptedJobs: vi.fn(),
      expireDeadlines: vi.fn(),
      claimLifecycleJob: vi.fn(async () => null)
    };
    const runner = new LifecycleRunner(
      store as never,
      {} as never,
      undefined,
      undefined,
      undefined,
      async () => { throw new Error("observer failed asynchronously"); }
    );

    try {
      await expect(runner.processOne()).resolves.toBe(false);
      await new Promise((resolve) => setImmediate(resolve));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });
});
