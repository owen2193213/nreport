/* eslint-disable @typescript-eslint/require-await */
import { describe, expect, it, vi } from "vitest";
import { DiscordDsaHttpError } from "@discord-dsa/client";

import { LifecycleRunner } from "../src/lifecycle-runner-v2.js";

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
