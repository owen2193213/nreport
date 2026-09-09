/* eslint-disable @typescript-eslint/require-await */
import { describe, expect, it, vi } from "vitest";
import { DiscordDsaHttpError } from "@discord-dsa/client";

import { LifecycleRunner } from "../src/lifecycle-runner-v2.js";

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function waitFor(condition: () => boolean, timeoutMilliseconds = 500): Promise<void> {
  const deadline = Date.now() + timeoutMilliseconds;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for condition.");
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
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
    session_state: "encrypted-session",
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
      markSubmitted: vi.fn(async () => { calls.push("persisted"); }),
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
    expect(store.markSubmitted).toHaveBeenCalledWith("job-1", "report-1", "discord-1");
    expect(store.completeLifecycleJob).not.toHaveBeenCalled();
  });

  it("retains consumed credit and marks an ambiguous outcome after the boundary", async () => {
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
      submitPrepared: vi.fn(async () => { throw new Error("connection lost"); }),
      close: vi.fn()
    };
    const runner = new LifecycleRunner(store as never, {} as never, () => client as never, {
      decrypt: (value: string) => value
    });

    await runner.processOne();

    expect(store.failAfterSubmission).toHaveBeenCalledWith(
      "job-1",
      "report-1",
      "ambiguous_submission_state",
      expect.any(String)
    );
    expect(client.submitPrepared).toHaveBeenCalledTimes(1);
    expect(store.failAfterSubmission).toHaveBeenCalledTimes(1);
    expect(store.retryLifecycleJob).toHaveBeenCalledTimes(0);
    expect(store.markSubmitted).toHaveBeenCalledTimes(0);
    expect(store.failBeforeSubmission).not.toHaveBeenCalled();
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
      markReviewRequested: vi.fn(),
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
    expect(store.markReviewRequested).toHaveBeenCalledWith("job-review", "report-1", "discord-1");
    expect(store.failReview).not.toHaveBeenCalled();
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
      "job-review",
      "report-1",
      "ineligible",
      "discord_review_ineligible",
      expect.any(String)
    );
  });
});

describe("LifecycleRunner background scheduling", () => {
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
      await waitFor(() => started.size === 2);
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
      markReviewRequested: vi.fn(),
      completeLifecycleJob: vi.fn(),
      retryLifecycleJob: vi.fn(),
      failReview: vi.fn(),
      setStatus: vi.fn(async () => true),
      saveAwaitingVerification: vi.fn()
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
      await appealSleeping.promise;
      await waitFor(() => requestCodeStarted);
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
      await waitFor(() => requestCodeStarted);
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
      await jobStalled.promise;
      await waitFor(() => store.recoverInterruptedJobs.mock.calls.length >= 2);
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
      undefined,
      () => new Promise(() => undefined)
    );
    runner.start();
    await waitFor(() => store.claimLifecycleJob.mock.calls.length === 1);

    const stopPromise = runner.stop();
    const stoppedPromptly = await Promise.race([
      stopPromise.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 100))
    ]);

    expect(stoppedPromptly).toBe(true);
    await stopPromise;
  });
});

describe("LifecycleRunner safe outcomes", () => {
  it("reports a failed job with operational fields only", async () => {
    const outcomes: unknown[] = [];
    const store = {
      recoverInterruptedJobs: vi.fn(),
      expireDeadlines: vi.fn(),
      claimLifecycleJob: vi.fn(async () => ({
        id: "sensitive-job-id",
        report_id: "sensitive-report-id",
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
      (outcome) => outcomes.push(outcome)
    );

    await expect(runner.processOne()).rejects.toThrow("sensitive provider response");

    expect(outcomes.at(-1)).toMatchObject({
      component: "job",
      outcome: "failed",
      jobKind: "request_code",
      attempts: 2,
      errorCategory: "lifecycle_job_failed"
    });
    expect(typeof (outcomes.at(-1) as { durationMs: unknown }).durationMs).toBe("number");
    expect(JSON.stringify(outcomes)).not.toMatch(/sensitive|123456/);
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
      (outcome) => outcomes.push(outcome)
    );

    await runner.processOne();

    const maintenanceOutcome = outcomes.find(
      (outcome) => (outcome as { component?: string }).component === "maintenance"
    );
    expect(maintenanceOutcome).toMatchObject({
      component: "maintenance",
      outcome: "completed"
    });
    expect(typeof (maintenanceOutcome as { durationMs: unknown }).durationMs).toBe("number");
  });

  it("reports a claim-loop failure using a fixed safe category and keeps running", async () => {
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
      (outcome) => outcomes.push(outcome)
    );

    runner.start();
    try {
      await waitFor(() => outcomes.some((outcome) => (outcome as { component?: string }).component === "loop"));
      const loopOutcome = outcomes.find(
        (outcome) => (outcome as { component?: string }).component === "loop"
      );
      expect(loopOutcome).toMatchObject({
        component: "loop",
        outcome: "failed",
        errorCategory: "lifecycle_claim_failed"
      });
      expect(typeof (loopOutcome as { durationMs: unknown }).durationMs).toBe("number");
      expect(JSON.stringify(outcomes)).not.toContain("sensitive database URL");
    } finally {
      await runner.stop();
    }
  });
});
