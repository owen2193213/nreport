/* eslint-disable @typescript-eslint/require-await, @typescript-eslint/no-unused-vars */
import { describe, expect, it, vi } from "vitest";

import { REPORT_SCHEMA_SQL, reportRetryableModes, ReportMutationError, ReportRepository } from "../src/report-repository.js";

const input = {
  flow: "message" as const,
  useAi: true as const,
  target: {
    messageUrl: "https://discord.com/channels/@me/123456789012345678/123456789012345679"
  },
  description: "Potentially unlawful content."
};

function repositoryWithQueries(responses: (sql: string) => { rows: unknown[]; rowCount: number }) {
  const client = {
    query: vi.fn(async (sql: string, _values?: unknown[]) => responses(sql)),
    release: vi.fn()
  };
  return {
    repository: new ReportRepository({ connect: async () => client } as never),
    client
  };
}

describe("transactional report creation", () => {
  it("reserves one credit and persists report, preparation job, and event atomically", async () => {
    const { repository, client } = repositoryWithQueries((sql) => {
      if (sql.includes("FROM api_accounts") && sql.includes("FOR UPDATE")) {
        return { rows: [{ status: "active", available_credits: 1 }], rowCount: 1 };
      }
      if (sql.includes("FROM account_reports") && sql.includes("idempotency_key")) {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes("INSERT INTO account_reports")) {
        return {
          rows: [{ id: "report-1", account_id: "account-1", status: "queued" }],
          rowCount: 1
        };
      }
      return { rows: [], rowCount: 1 };
    });

    const result = await repository.create("account-1", "create:1", input);

    expect(result.created).toBe(true);
    expect(client.query.mock.calls.some(([sql]) => String(sql).includes("kind, dedupe_key") && String(sql).includes("prepare_report"))).toBe(true);
    expect(client.query.mock.calls.some(([sql]) => String(sql).includes("report_events") && String(sql).includes("report_queued"))).toBe(true);
    expect(client.query).toHaveBeenCalledWith("COMMIT");
    const insert = client.query.mock.calls.find(([sql]) => String(sql).includes("INSERT INTO account_reports"));
    expect(insert?.[0]).toContain("trace_id");
    expect(insert?.[1]).toEqual(expect.arrayContaining([expect.stringMatching(/^[0-9a-f-]{36}$/)]));
  });

  it("returns an exact idempotent replay without reserving another credit", async () => {
    const { repository, client } = repositoryWithQueries((sql) => {
      if (sql.includes("FROM api_accounts")) {
        return { rows: [{ status: "active", available_credits: 0 }], rowCount: 1 };
      }
      if (sql.includes("FROM account_reports") && sql.includes("idempotency_key")) {
        return {
          rows: [{ id: "report-1", account_id: "account-1", request_hash: ReportRepository.requestHash(input), status: "queued" }],
          rowCount: 1
        };
      }
      return { rows: [], rowCount: 1 };
    });

    const result = await repository.create("account-1", "create:1", input);

    expect(result.created).toBe(false);
    expect(client.query.mock.calls.some(([sql]) => String(sql).startsWith("UPDATE api_accounts"))).toBe(false);
  });

  it("distinguishes conflicting replay, suspension, and exhausted credits", async () => {
    for (const scenario of ["conflict", "suspended", "exhausted"] as const) {
      const { repository } = repositoryWithQueries((sql) => {
        if (sql.includes("FROM api_accounts")) {
          return {
            rows: [{ status: scenario === "suspended" ? "suspended" : "active", available_credits: scenario === "exhausted" ? 0 : 1 }],
            rowCount: 1
          };
        }
        if (sql.includes("FROM account_reports") && sql.includes("idempotency_key")) {
          return scenario === "conflict"
            ? { rows: [{ request_hash: "different" }], rowCount: 1 }
            : { rows: [], rowCount: 0 };
        }
        return { rows: [], rowCount: 1 };
      });

      const error = await repository.create("account-1", "create:1", input).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(ReportMutationError);
      expect(error).toMatchObject({
        code: scenario === "conflict" ? "idempotency_conflict" : scenario === "suspended" ? "account_suspended" : "credits_exhausted"
      });
    }
  });
});

describe("JSON persistence", () => {
  it("rejects a stale preparation worker before it can change a report", async () => {
    const client = {
      query: vi.fn(async () => ({ rows: [], rowCount: 0 })),
      release: vi.fn()
    };
    const repository = new ReportRepository({ connect: async () => client } as never);

    await expect(repository.completePreparation(
      "job-1", "report-1",
      { country: "DE", category: "illegal", description: "Evidence", finalText: "Report", legalReference: null, researchSummary: null, sources: [] },
      { legalName: "Name", email: "alias@example.test", locale: "de-DE", timezone: "Europe/Berlin", language: "de", proxySessionId: "proxy" },
      { aiRequests: 0, inputTokens: 0, outputTokens: 0, searchRequests: 0 },
      9
    )).resolves.toBe(false);

    expect(client.query.mock.calls.some((call) => String((call as unknown[])[0]).includes("prepared_input = $2"))).toBe(false);
  });

  it("serializes legal source arrays as JSON instead of PostgreSQL arrays", async () => {
    const sources = [{ title: "EUR-Lex", url: "https://eur-lex.europa.eu/" }];
    const client = {
      query: vi.fn(async (sql: string, _values?: unknown[]) => {
        if (sql.includes("kind = 'prepare_report'") && sql.includes("state = 'running'")) {
          return { rows: [{ ok: 1 }], rowCount: 1 };
        }
        if (sql.includes("SELECT account_id, preparation_ai_requests")) {
          return { rows: [{ account_id: "account-1", preparation_ai_requests: "0", preparation_input_tokens: "0", preparation_output_tokens: "0", preparation_search_requests: "0" }], rowCount: 1 };
        }
        if (sql.includes("UPDATE account_reports") && sql.includes("research_sources = $5")) {
          return { rows: [{ account_id: "account-1", lifecycle_attempt: 1 }], rowCount: 1 };
        }
        if (sql.includes("INSERT INTO account_report_events")) return { rows: [{ id: "1" }], rowCount: 1 };
        return { rows: [], rowCount: 1 };
      }),
      release: vi.fn()
    };
    const repository = new ReportRepository({ connect: async () => client } as never);

    await repository.completePreparation(
      "job-1", "report-1",
      { country: "DE", category: "illegal", description: "Evidence", finalText: "Report", legalReference: "Law", researchSummary: "Summary", sources },
      { legalName: "Name", email: "alias@example.test", locale: "de-DE", timezone: "Europe/Berlin", language: "de", proxySessionId: "proxy" },
      { aiRequests: 0, inputTokens: 0, outputTokens: 0, searchRequests: 0 },
      1
    );

    const update = client.query.mock.calls.find(([sql]) => String(sql).includes("research_sources = $5"));
    expect(update?.[1]?.[4]).toBe('[{"title":"EUR-Lex","url":"https://eur-lex.europa.eu/"}]');
  });
});

describe("verification state races", () => {
  it("stores the session without moving an already received verification code backwards", async () => {
    const client = {
      query: vi.fn(async (sql: string, _values?: unknown[]) => {
        if (sql.includes("UPDATE account_reports") && sql.includes("session_state")) {
          return { rows: [{ account_id: "account-1", lifecycle_attempt: 1, status: "verification_received" }], rowCount: 1 };
        }
        if (sql.includes("INSERT INTO account_report_events")) return { rows: [{ id: "1" }], rowCount: 1 };
        return { rows: [], rowCount: 1 };
      }),
      release: vi.fn()
    };
    const repository = new ReportRepository({ connect: async () => client } as never);

    expect(await repository.saveAwaitingVerification({ id: "job-1", report_id: "report-1", execution_token: 1 } as never, "encrypted-session")).toBe(true);

    const update = client.query.mock.calls.find(([sql]) => String(sql).includes("session_state"));
    expect(String(update?.[0])).toContain("status IN ('requesting_verification', 'verification_received')");
    expect(String(update?.[0])).toContain("CASE WHEN status = 'verification_received'");
    expect(client.query.mock.calls.some(([sql, values]) => String(sql).includes("account_report_events") && values?.includes("awaiting_verification"))).toBe(false);
  });
});

describe("deadline expiry", () => {
  it("fails consumed retry chains on verification timeout without refunding them", async () => {
    const client = {
      query: vi.fn(async (sql: string, _values?: unknown[]) => {
        if (sql.includes("SELECT account_id FROM account_reports WHERE id = $1")) {
          return { rows: [{ account_id: "account-1" }], rowCount: 1 };
        }
        if (sql.includes("FROM api_accounts WHERE id = $1 FOR UPDATE")) {
          return { rows: [{ ok: 1 }], rowCount: 1 };
        }
        if (sql.includes("report.verification_deadline") && sql.includes("FOR UPDATE OF report, chain")) {
          return { rows: [{ account_id: "account-1", credit_chain_id: "chain-1", credit_state: "consumed", lifecycle_attempt: 2 }], rowCount: 1 };
        }
        if (sql.includes("INSERT INTO account_report_events")) return { rows: [{ id: "1" }], rowCount: 1 };
        return { rows: [], rowCount: 1 };
      }),
      release: vi.fn()
    };
    const poolQuery = vi.fn(async (sql: string) => (
      sql.includes("report.verification_deadline") ? { rows: [{ id: "retry-1" }], rowCount: 1 } : { rows: [], rowCount: 0 }
    ));
    const repository = new ReportRepository({ connect: async () => client, query: poolQuery } as never);

    await repository.expireDeadlines();

    expect(client.query.mock.calls.some(([sql]) => String(sql).includes("available_credits = available_credits + 1"))).toBe(false);
    expect(client.query.mock.calls.some(([sql, values]) => String(sql).includes("verification_timeout") && values?.includes("retry-1"))).toBe(true);
  });

  it("locks the account row before the report/chain, matching create()'s lock order, and releases a reserved credit", async () => {
    const client = {
      query: vi.fn(async (sql: string, _values?: unknown[]) => {
        if (sql.includes("SELECT account_id FROM account_reports WHERE id = $1")) {
          return { rows: [{ account_id: "account-1" }], rowCount: 1 };
        }
        if (sql.includes("FROM api_accounts WHERE id = $1 FOR UPDATE")) {
          return { rows: [{ ok: 1 }], rowCount: 1 };
        }
        if (sql.includes("report.verification_deadline") && sql.includes("FOR UPDATE OF report, chain")) {
          return { rows: [{ account_id: "account-1", credit_chain_id: "chain-1", credit_state: "reserved", lifecycle_attempt: 1 }], rowCount: 1 };
        }
        if (sql.startsWith("UPDATE api_accounts") && sql.includes("reserved_credits > 0")) {
          return { rows: [{ id: "account-1" }], rowCount: 1 };
        }
        if (sql.startsWith("UPDATE report_credit_chains") && sql.includes("state = 'released'")) {
          return { rows: [{ id: "chain-1" }], rowCount: 1 };
        }
        if (sql.includes("INSERT INTO account_report_events")) return { rows: [{ id: "1" }], rowCount: 1 };
        return { rows: [], rowCount: 1 };
      }),
      release: vi.fn()
    };
    const poolQuery = vi.fn(async (sql: string) => (
      sql.includes("report.verification_deadline") ? { rows: [{ id: "report-1" }], rowCount: 1 } : { rows: [], rowCount: 0 }
    ));
    const repository = new ReportRepository({ connect: async () => client, query: poolQuery } as never);

    await repository.expireDeadlines();

    const calls = client.query.mock.calls.map(([sql]) => String(sql));
    const accountLockIndex = calls.findIndex((sql) => sql.includes("FROM api_accounts WHERE id = $1 FOR UPDATE"));
    const reportLockIndex = calls.findIndex((sql) => sql.includes("FOR UPDATE OF report, chain"));
    expect(accountLockIndex).toBeGreaterThanOrEqual(0);
    expect(reportLockIndex).toBeGreaterThan(accountLockIndex);
    expect(calls.some((sql) => sql.includes("available_credits = available_credits + 1"))).toBe(true);
  });

  it("runs receipt-timeout and review-timeout expiry in their own transactions, separate from the verification loop", async () => {
    const connectCalls: string[] = [];
    const client = { query: vi.fn(async (_sql: string) => ({ rows: [], rowCount: 0 })), release: vi.fn() };
    const poolQuery = vi.fn(async (_sql: string) => ({ rows: [], rowCount: 0 }));
    const repository = new ReportRepository({
      connect: async () => { connectCalls.push("connect"); return client; },
      query: poolQuery
    } as never);

    await repository.expireDeadlines();

    // No verification candidates, so only the two batch passes should connect.
    expect(connectCalls.length).toBe(2);
    const sqlCalls = client.query.mock.calls.map(([sql]) => String(sql));
    expect(sqlCalls.some((sql) => sql.includes("discord_receipt_timeout"))).toBe(true);
    expect(sqlCalls.some((sql) => sql.includes("review_confirmation_timeout"))).toBe(true);
  });
});

describe("lifecycle job leases", () => {
  it("refreshes a lease only while the lifecycle job is running", async () => {
    const query = vi.fn(async (_sql: string, values?: unknown[]) =>
      values?.[1] === 2
        ? { rows: [{ id: "job-1" }], rowCount: 1 }
        : { rows: [], rowCount: 0 }
    );
    const repository = new ReportRepository({ query } as never);
    const staleJob = { id: "job-1", report_id: "report-1", execution_token: 1 };
    const currentJob = { ...staleJob, execution_token: 2 };

    await expect(repository.heartbeatLifecycleJob(staleJob as never)).resolves.toBe(false);
    await expect(repository.heartbeatLifecycleJob(currentJob as never)).resolves.toBe(true);

    expect(query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("SET locked_at = now(), updated_at = now()"),
      ["job-1", 1]
    );
    expect(String(query.mock.calls[0]?.[0])).toContain("WHERE id = $1 AND attempts = $2 AND state = 'running'");
    expect(String(query.mock.calls[0]?.[0])).toContain("RETURNING id");
  });

  it("returns a new execution token when recovery is followed by reclaim", async () => {
    const client = {
      query: vi.fn(async () => ({ rows: [], rowCount: 0 })),
      release: vi.fn()
    };
    const reclaimed = {
      id: "job-1",
      report_id: "report-1",
      kind: "verify_submit",
      payload: {},
      attempts: 2,
      max_attempts: 3,
      execution_token: 2
    };
    const query = vi.fn(async (_sql: string) => ({ rows: [reclaimed], rowCount: 1 }));
    const repository = new ReportRepository({ connect: async () => client, query } as never);

    await repository.recoverInterruptedJobs();
    await expect(repository.claimLifecycleJob()).resolves.toEqual(reclaimed);

    const claimSql = String(query.mock.calls[0]?.[0]);
    expect(claimSql).toContain("attempts = attempts + 1");
    expect(claimSql).toContain("job.attempts AS execution_token");
  });

  it("recovery changes only running lifecycle jobs with stale leases", async () => {
    const { repository, client } = repositoryWithQueries(() => ({ rows: [], rowCount: 0 }));

    await repository.recoverInterruptedJobs();

    const lifecycleRecoveryStatements = client.query.mock.calls
      .map(([sql]) => String(sql))
      .filter((sql) => sql.includes("job.locked_at < now() - interval '2 minutes'"));
    expect(lifecycleRecoveryStatements).toHaveLength(4);
    for (const sql of lifecycleRecoveryStatements) {
      expect(sql).toContain("job.state = 'running'");
      expect(sql).toContain("job.locked_at < now() - interval '2 minutes'");
    }
  });

  it.each([
    ["requesting-verification status", (repository: ReportRepository, job: unknown) =>
      (repository as unknown as { setStatus(value: unknown, status: string): Promise<boolean> }).setStatus(job, "requesting_verification")],
    ["verifying status", (repository: ReportRepository, job: unknown) =>
      (repository as unknown as { setStatus(value: unknown, status: string): Promise<boolean> }).setStatus(job, "verifying")],
    ["completion", (repository: ReportRepository, job: unknown) =>
      (repository as unknown as { completeLifecycleJob(value: unknown): Promise<boolean> }).completeLifecycleJob(job)],
    ["retry", (repository: ReportRepository, job: unknown) =>
      (repository as unknown as { retryLifecycleJob(value: unknown, code: string, delay: number): Promise<boolean> }).retryLifecycleJob(job, "safe_error", 5)],
    ["pre-boundary failure", (repository: ReportRepository, job: unknown) =>
      (repository as unknown as { failBeforeSubmission(value: unknown, code: string, message: string): Promise<boolean> }).failBeforeSubmission(job, "safe_error", "Safe failure.")],
    ["post-boundary failure", (repository: ReportRepository, job: unknown) =>
      (repository as unknown as { failAfterSubmission(value: unknown, code: string, message: string): Promise<boolean> }).failAfterSubmission(job, "safe_error", "Safe failure.")],
    ["awaiting-verification completion", (repository: ReportRepository, job: unknown) =>
      (repository as unknown as { saveAwaitingVerification(value: unknown, session: string): Promise<boolean> }).saveAwaitingVerification(job, "encrypted-session")],
    ["submission boundary", (repository: ReportRepository, job: unknown) =>
      (repository as unknown as { beginSubmission(value: unknown): Promise<boolean> }).beginSubmission(job)],
    ["submission result", (repository: ReportRepository, job: unknown) =>
      (repository as unknown as { markSubmitted(value: unknown, discordId: string): Promise<boolean> }).markSubmitted(job, "discord-report")],
    ["review boundary", (repository: ReportRepository, job: unknown) =>
      (repository as unknown as { beginReviewSubmission(value: unknown): Promise<boolean> }).beginReviewSubmission(job)],
    ["review success", (repository: ReportRepository, job: unknown) =>
      (repository as unknown as { markReviewRequested(value: unknown, discordId: string): Promise<boolean> }).markReviewRequested(job, "discord-report")],
    ["review failure", (repository: ReportRepository, job: unknown) =>
      (repository as unknown as { failReview(value: unknown, status: string, code: string, message: string): Promise<boolean> }).failReview(job, "request_failed", "safe_error", "Safe failure.")]
  ])("rejects stale-token %s without mutating the replacement claim or report", async (_label, invoke) => {
    const reportMutations: string[] = [];
    const client = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("SELECT 1 FROM account_report_jobs")) return { rows: [], rowCount: 0 };
        if (sql.includes("UPDATE account_reports") || sql.includes("credit_ledger") || sql.includes("account_report_events")) {
          reportMutations.push(sql);
          return { rows: [{ account_id: "account-1", lifecycle_attempt: 1 }], rowCount: 1 };
        }
        if (sql.includes("JOIN report_credit_chains")) {
          return { rows: [{ account_id: "account-1", credit_chain_id: "chain-1", credit_state: "reserved", account_status: "active", status: "verifying", lifecycle_attempt: 1 }], rowCount: 1 };
        }
        return { rows: [{ id: "job-1" }], rowCount: 1 };
      }),
      release: vi.fn()
    };
    const poolQuery = vi.fn(async (sql: string) => ({
      rows: sql.includes("attempts = $2") ? [] : [{ id: "job-1" }],
      rowCount: sql.includes("attempts = $2") ? 0 : 1
    }));
    const repository = new ReportRepository({ connect: async () => client, query: poolQuery } as never);
    const staleJob = {
      id: "job-1",
      report_id: "report-1",
      kind: "verify_submit",
      payload: {},
      attempts: 1,
      max_attempts: 3,
      execution_token: 1
    };

    await expect(invoke(repository, staleJob)).resolves.toBe(false);

    expect(reportMutations).toEqual([]);
    const allSql = [...client.query.mock.calls, ...poolQuery.mock.calls].map(([sql]) => String(sql));
    expect(allSql.some((sql) => sql.includes("attempts = $2"))).toBe(true);
  });
});

describe("retry eligibility", () => {
  it("uses one rule for terminal denial, preparation availability, and AI mode", () => {
    expect(reportRetryableModes({
      status: "submitted", use_ai: true,
      prepared_input: { finalText: "Prepared" }, discord_status: "closed_no_action",
      review_status: "not_approved", error_code: null, submission_started_at: new Date()
    })).toEqual(["rewrite_ai", "edit_manual"]);
    expect(reportRetryableModes({
      status: "submitted", use_ai: true,
      prepared_input: { finalText: "Prepared" }, discord_status: "closed_no_action",
      review_status: "ineligible", error_code: null, submission_started_at: new Date()
    })).toEqual([]);
    expect(reportRetryableModes({
      status: "failed", use_ai: true, prepared_input: null, discord_status: null,
      review_status: null, error_code: "ambiguous_submission_state", submission_started_at: new Date()
    })).toEqual([]);
  });
});

describe("credit boundary transitions", () => {
  it("releases a reserved credit when preparation fails", async () => {
    const { repository, client } = repositoryWithQueries((sql) => {
      if (sql.includes("JOIN report_credit_chains") && sql.includes("FOR UPDATE")) {
        return {
          rows: [{ account_id: "account-1", credit_chain_id: "chain-1", credit_state: "reserved", status: "writing" }],
          rowCount: 1
        };
      }
      return { rows: [], rowCount: 1 };
    });

    await repository.failPreparation("job-1", "report-1", "preparation_failed", "Preparation failed safely.", 1);

    expect(client.query.mock.calls.some(([sql]) => String(sql).includes("available_credits = available_credits + 1"))).toBe(true);
    expect(client.query.mock.calls.some(([sql]) => String(sql).includes("SET state = 'released'"))).toBe(true);
    expect(client.query.mock.calls.some(([sql, values]) => String(sql).includes("account_report_events") && values?.includes("report_failed"))).toBe(true);
    expect(client.query).toHaveBeenCalledWith("COMMIT");
  });

  it("does not replace a terminal suspension failure or emit a duplicate event", async () => {
    const { repository, client } = repositoryWithQueries((sql) => {
      if (sql.includes("JOIN report_credit_chains") && sql.includes("FOR UPDATE")) {
        return {
          rows: [{ account_id: "account-1", credit_chain_id: "chain-1", credit_state: "released", status: "failed", lifecycle_attempt: 1 }],
          rowCount: 1
        };
      }
      if (sql.includes("UPDATE account_reports") && sql.includes("status <> 'failed'")) {
        return { rows: [], rowCount: 0 };
      }
      return { rows: [], rowCount: 1 };
    });

    await repository.failPreparation("job-1", "report-1", "preparation_failed", "Preparation failed safely.", 1);

    expect(client.query.mock.calls.some(([sql]) => String(sql).includes("available_credits = available_credits + 1"))).toBe(false);
    expect(client.query.mock.calls.some(([sql, values]) => String(sql).includes("account_report_events") && values?.includes("report_failed"))).toBe(false);
    expect(client.query).toHaveBeenCalledWith("COMMIT");
  });

  it("atomically consumes the reservation immediately before Discord submission", async () => {
    const { repository, client } = repositoryWithQueries((sql) => {
      if (sql.includes("JOIN report_credit_chains") && sql.includes("FOR UPDATE")) {
        return {
          rows: [{ account_id: "account-1", credit_chain_id: "chain-1", credit_state: "reserved", account_status: "active", status: "verifying" }],
          rowCount: 1
        };
      }
      return { rows: [], rowCount: 1 };
    });

    expect(await repository.beginSubmission({ id: "job-1", report_id: "report-1", execution_token: 1 } as never)).toBe(true);

    expect(client.query.mock.calls.some(([sql]) => String(sql).includes("reserved_credits = reserved_credits - 1"))).toBe(true);
    expect(client.query.mock.calls.some(([sql]) => String(sql).includes("SET state = 'consumed'"))).toBe(true);
    expect(client.query.mock.calls.some(([sql, values]) => String(sql).includes("account_report_events") && values?.includes("submission_started"))).toBe(true);
    expect(client.query.mock.calls.some(([sql]) => String(sql).includes("available_credits = available_credits + 1"))).toBe(false);
  });

  it("crosses the boundary for a consumed retry chain without consuming twice", async () => {
    const { repository, client } = repositoryWithQueries((sql) => {
      if (sql.includes("JOIN report_credit_chains") && sql.includes("FOR UPDATE")) {
        return { rows: [{ account_id: "account-1", credit_chain_id: "chain-1", credit_state: "consumed", account_status: "active", status: "verifying" }], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    });

    expect(await repository.beginSubmission({ id: "job-2", report_id: "report-2", execution_token: 1 } as never)).toBe(true);

    expect(client.query.mock.calls.some(([sql]) => String(sql).includes("reserved_credits = reserved_credits - 1"))).toBe(false);
    expect(client.query.mock.calls.some(([sql]) => String(sql).includes("kind, available_delta") && String(sql).includes("consumption"))).toBe(false);
    expect(client.query.mock.calls.some(([sql, values]) => String(sql).includes("account_report_events") && values?.includes("submission_started"))).toBe(true);
  });
});

describe("atomic lifecycle persistence", () => {
  it("does not revive a report when suspension wins the verification race", async () => {
    const { repository, client } = repositoryWithQueries((sql) => {
      if (sql.includes("SET session_state") && sql.includes("account.status = 'active'")) {
        return { rows: [], rowCount: 0 };
      }
      return { rows: [], rowCount: 1 };
    });

    await expect(repository.saveAwaitingVerification({ id: "job-1", report_id: "report-1", execution_token: 1 } as never, "encrypted-session"))
      .resolves.toBe(false);

    expect(client.query.mock.calls.some(([sql]) => String(sql).includes("SET state = 'completed'"))).toBe(false);
    expect(client.query.mock.calls.some(([sql, values]) => String(sql).includes("account_report_events") && values?.includes("awaiting_verification"))).toBe(false);
    expect(client.query).toHaveBeenCalledWith("COMMIT");
  });

  it("persists submission success and completes its job in one transaction", async () => {
    const { repository, client } = repositoryWithQueries((sql) => {
      if (sql.includes("SET status = 'submitted'")) {
        return { rows: [{ account_id: "account-1", lifecycle_attempt: 2 }], rowCount: 1 };
      }
      if (sql.includes("FROM account_inbound_messages")) return { rows: [], rowCount: 0 };
      if (sql.includes("INSERT INTO account_report_events")) return { rows: [{ id: "10" }], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    });

    await repository.markSubmitted({ id: "job-1", report_id: "report-1", execution_token: 1 } as never, "discord-report-1");

    expect(client.query.mock.calls.some(([sql, values]) =>
      String(sql).includes("SET state = 'completed'") && values?.[0] === "job-1" && values?.[1] === "report-1"
    )).toBe(true);
    expect(client.query.mock.calls.some(([sql, values]) =>
      String(sql).includes("account_report_events") && values?.includes("report_submitted")
    )).toBe(true);
    expect(client.query).toHaveBeenCalledWith("COMMIT");
  });

  it("applies pending Discord emails against the latest report state after submission", async () => {
    const report = {
      id: "report-1", account_id: "account-1", trace_id: "33333333-3333-4333-8333-333333333333",
      lifecycle_attempt: 1, status: "submitted", reporter_email: "alias@example.test",
      discord_report_id: "discord-report-1", discord_status: null, review_status: null, error_code: null
    };
    const currentReport: Omit<typeof report, "discord_status"> & { discord_status: string | null } = { ...report };
    const client = {
      query: vi.fn(async (sql: string, values?: unknown[]) => {
        if (sql.includes("SET status = 'submitted'")) return { rows: [report], rowCount: 1 };
        if (sql.includes("FROM account_inbound_messages") && sql.includes("status = 'pending_report'")) {
          return {
            rows: [
              { message_id: "actioned-email", recipient: "alias@example.test", status: "pending_report", external_report_id: "discord-report-1", external_status: "actioned", encrypted_payload: null, received_at: new Date("2026-10-14T00:00:00Z") },
              { message_id: "late-received-email", recipient: "alias@example.test", status: "pending_report", external_report_id: "discord-report-1", external_status: "received", encrypted_payload: null, received_at: new Date("2026-10-14T00:00:01Z") }
            ],
            rowCount: 2
          };
        }
        if (sql.includes("SELECT * FROM account_reports WHERE id = $1 FOR UPDATE")) {
          return { rows: [{ ...currentReport }], rowCount: 1 };
        }
        if (sql.includes("SET discord_status = $2")) {
          currentReport.discord_status = String(values?.[1]);
          return { rows: [], rowCount: 1 };
        }
        if (sql.includes("INSERT INTO account_report_events")) return { rows: [{ id: "10" }], rowCount: 1 };
        return { rows: [], rowCount: 1 };
      }),
      release: vi.fn()
    };
    const repository = new ReportRepository({ connect: async () => client } as never);

    await repository.markSubmitted({ id: "job-1", report_id: "report-1", execution_token: 1 } as never, "discord-report-1");

    expect(currentReport.discord_status).toBe("actioned");
    const statusUpdates = client.query.mock.calls.filter(([sql]) => String(sql).includes("SET discord_status = $2"));
    expect(statusUpdates).toHaveLength(1);
    expect(statusUpdates[0]?.[1]).toEqual(["report-1", "actioned"]);
  });
});

describe("account-owned reads and recovery feeds", () => {
  it("always scopes report lookup to the authenticated account", async () => {
    const query = vi.fn(async (_sql: string, _values?: unknown[]) => ({
      rows: [{ id: "report-1", account_id: "account-1", credit_state: "reserved" }],
      rowCount: 1
    }));
    const repository = new ReportRepository({ query } as never);

    await repository.findOwned("account-1", "report-1");

    expect(query).toHaveBeenCalledWith(expect.stringContaining("report.account_id = $1"), ["account-1", "report-1"]);
  });

  it("returns an account-scoped event page with a stable next cursor", async () => {
    const query = vi.fn(async (_sql: string, _values?: unknown[]) => ({
      rows: [
        { id: "11", account_id: "account-1", report_id: "report-1", trace_id: "11111111-1111-4111-8111-111111111111", event_type: "report_queued", lifecycle_attempt: 1, created_at: new Date("2026-09-04T00:00:00Z") },
        { id: "12", account_id: "account-1", report_id: "report-1", trace_id: "11111111-1111-4111-8111-111111111111", event_type: "report_planning", lifecycle_attempt: 1, created_at: new Date("2026-09-04T00:00:01Z") },
        { id: "13", account_id: "account-1", report_id: "report-1", trace_id: "11111111-1111-4111-8111-111111111111", event_type: "report_writing", lifecycle_attempt: 1, created_at: new Date("2026-09-04T00:00:02Z") }
      ],
      rowCount: 3
    }));
    const repository = new ReportRepository({ query } as never);

    const page = await repository.listEvents("account-1", null, 2);

    expect(page.items).toHaveLength(2);
    expect(page.next).toBe("12");
    expect(page.items[0]?.traceId).toBe("11111111-1111-4111-8111-111111111111");
    expect(query.mock.calls[0]?.[1]).toEqual(["account-1", "0", 3]);
  });
});

describe("administrator report diagnostics", () => {
  const reportId = "30a3d6c4-f82b-4b37-8095-b9f9c80a8ce2";

  it("adds a bounded, payload-free projection only when a report ID is requested", async () => {
    const query = vi.fn(async (sql: string, values?: unknown[]) => {
      if (sql.includes("WHERE report.id = $1") && sql.includes("credit_state")) {
        expect(values).toEqual([reportId]);
        return { rows: [{
          id: reportId, trace_id: "33333333-3333-4333-8333-333333333333", flow: "server", status: "failed",
          error_code: "discord_receipt_timeout", error_message: "Discord did not send a report receipt before the deadline.", failure_stage: "submitted",
          discord_report_id: "1548921252872462416", discord_status: null, review_status: null,
          created_at: new Date("2026-10-14T00:00:00Z"), updated_at: new Date("2026-10-14T00:02:00Z"),
          verification_deadline: null, receipt_deadline: null, submission_started_at: new Date("2026-10-14T00:01:00Z"),
          credit_state: "consumed"
        }], rowCount: 1 };
      }
      if (sql.includes("FROM account_report_events AS event") && sql.includes("count(*) OVER")) {
        return { rows: [{ id: "108", event_type: "report_failed", lifecycle_attempt: 2, created_at: new Date("2026-10-14T00:02:00Z"), total_count: "108" }], rowCount: 1 };
      }
      if (sql.includes("FROM account_report_jobs") && sql.includes("count(*) OVER")) {
        return { rows: [{ kind: "verify_submit", state: "failed", attempts: 3, max_attempts: 3,
          run_at: new Date("2026-10-14T00:00:00Z"), locked_at: null, last_error_category: "discord_http_failure",
          total_count: "51" }], rowCount: 1 };
      }
      if (sql.includes("GROUP BY message.external_report_id")) {
        return { rows: [
          { external_report_id: "1548921252872462416", registration_status: "accepted", external_status: "received",
            message_count: "1", group_count: "2", matches_report: true, first_received_at: new Date("2026-10-14T00:01:30Z"),
            latest_received_at: new Date("2026-10-14T00:01:30Z") },
          { external_report_id: "1548921252872462499", registration_status: "pending_report", external_status: "received",
            message_count: "1", group_count: "2", matches_report: false, first_received_at: new Date("2026-10-14T00:02:00Z"),
            latest_received_at: new Date("2026-10-14T00:02:00Z") }
        ], rowCount: 2 };
      }
      if (sql.includes("FROM account_inbound_messages AS message") && sql.includes("report.id = $1")) {
        return { rows: [{ total: "2", pending: "1", accepted: "1", unknown_recipient: "0", received: "1", actioned: "1",
          pending_report: "1", other_status: "0", closed_no_action: "0", review_not_approved: "0", review_received: "0",
          no_external_status: "0", other_external_status: "0", latest_received_at: new Date("2026-10-14T00:02:00Z") }], rowCount: 1 };
      }
      if (sql.includes("FROM event_destination_deliveries AS delivery") && sql.includes("event.report_id = $1")) {
        return { rows: [{ state: "sent", count: "4" }, { state: "pending", count: "1" }], rowCount: 2 };
      }
      if (sql.includes("AS reports")) return { rows: [{ reports: "12", pending_jobs: "1", running_jobs: "0", pending_deliveries: "1", expired_deliveries: "0", pending_inbound_messages: "0", pending_inbound_older_than_two_minutes: "0", oldest_pending_inbound_age_ms: null }], rowCount: 1 };
      if (sql.includes("preparation_ready")) return { rows: [{}], rowCount: 1 };
      if (sql.includes("FROM operational_worker_health")) return { rows: [], rowCount: 0 };
      if (sql.includes("FROM operational_alert_state")) return { rows: [], rowCount: 0 };
      return { rows: [], rowCount: 0 };
    });
    const repository = new ReportRepository({ connect: vi.fn(), query } as never);

    const diagnostics = await repository.operationalDiagnostics(reportId);
    const projection = diagnostics.report as Record<string, unknown>;

    expect(projection).toMatchObject({
      id: reportId, flow: "server", status: "failed", errorCode: "discord_receipt_timeout",
      errorMessage: "Discord did not send a report receipt before the deadline.", failureStage: "submitted", creditState: "consumed",
      events: { total: 108 }, jobs: { total: 51 },
      inbound: {
        total: 2, byRegistrationStatus: { pendingReport: 1, accepted: 1 },
        byExternalStatus: { received: 1, actioned: 1 }, groupCount: 2
      },
      deliveries: { total: 5, sent: 4, pending: 1 }
    });
    expect((projection.events as { items: unknown[] }).items).toHaveLength(1);
    expect((projection.jobs as { items: unknown[] }).items).toHaveLength(1);
    expect((projection.inbound as { groups: Array<{ externalReportId: string; matchesSubmittedReportId: boolean }> }).groups[0])
      .toMatchObject({ externalReportId: "1548921252872462416", matchesSubmittedReportId: true });
    expect((projection.inbound as { groups: Array<{ externalReportId: string; matchesSubmittedReportId: boolean }> }).groups[1])
      .toMatchObject({ externalReportId: "1548921252872462499", matchesSubmittedReportId: false });
    const diagnosticSql = query.mock.calls.map(([sql]) => String(sql)).filter((sql) => sql.includes("WHERE report.id = $1"));
    expect(diagnosticSql.some((sql) => /SELECT\s+(?:report\.\*|\*)/i.test(sql))).toBe(false);
    expect(JSON.stringify(projection)).not.toMatch(/encrypted|payload|alias@example\.test/i);

    const globalOnly = await repository.operationalDiagnostics();
    expect(globalOnly).not.toHaveProperty("report");
  });

  it("returns a null report projection when the requested ID is absent", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("WHERE report.id = $1") && sql.includes("credit_state")) return { rows: [], rowCount: 0 };
      if (sql.includes("AS reports")) return { rows: [{ reports: "0" }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });
    const repository = new ReportRepository({ connect: vi.fn(), query } as never);

    await expect(repository.operationalDiagnostics(reportId)).resolves.toHaveProperty("report", null);
  });
});

describe("trace migration and queue observability", () => {
  it("backfills trace IDs before enforcing the additive non-null UUID column", () => {
    expect(REPORT_SCHEMA_SQL).toContain("ADD COLUMN IF NOT EXISTS trace_id uuid");
    expect(REPORT_SCHEMA_SQL).toContain("SET trace_id = gen_random_uuid()");
    expect(REPORT_SCHEMA_SQL).toContain("ALTER COLUMN trace_id SET NOT NULL");
  });

  it("maps an empty aggregate queue row to zero counts and null ages", async () => {
    const query = vi.fn(async (_sql: string) => ({ rows: [{
      preparation_ready: "0", preparation_delayed: "0", preparation_running: "0", preparation_oldest_ms: null,
      lifecycle_ready: "0", lifecycle_delayed: "0", lifecycle_running: "0", lifecycle_oldest_ms: null,
      request_code: "0", verify_submit: "0", submit_review: "0"
    }], rowCount: 1 }));
    const repository = new ReportRepository({ query } as never);

    await expect(repository.queueSnapshot()).resolves.toEqual({
      preparation: { readyPending: 0, delayedPending: 0, running: 0, oldestReadyAgeMs: null },
      lifecycle: { readyPending: 0, delayedPending: 0, running: 0, oldestReadyAgeMs: null,
        byJobKind: { requestCode: 0, verifySubmit: 0, submitReview: 0 } }
    });
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("maps mixed queues and clamps database clock skew to a nonnegative age", async () => {
    const query = vi.fn(async (_sql: string) => ({ rows: [{
      preparation_ready: "2", preparation_delayed: "3", preparation_running: "1", preparation_oldest_ms: "-4",
      lifecycle_ready: "5", lifecycle_delayed: "6", lifecycle_running: "2", lifecycle_oldest_ms: "1500.9",
      request_code: "4", verify_submit: "7", submit_review: "2"
    }], rowCount: 1 }));
    const repository = new ReportRepository({ query } as never);

    const snapshot = await repository.queueSnapshot();

    expect(snapshot.preparation).toEqual({ readyPending: 2, delayedPending: 3, running: 1, oldestReadyAgeMs: 0 });
    expect(snapshot.lifecycle).toEqual({ readyPending: 5, delayedPending: 6, running: 2, oldestReadyAgeMs: 1500,
      byJobKind: { requestCode: 4, verifySubmit: 7, submitReview: 2 } });
    expect(String(query.mock.calls[0]?.[0])).not.toContain("report_id");
  });
});

describe("serial report retries", () => {
  it("allows an eligible retry immediately after the report becomes terminal", async () => {
    const terminalAt = new Date();
    const { repository } = repositoryWithQueries((sql) => {
      if (sql.includes("FROM api_accounts") && sql.includes("FOR UPDATE")) {
        return { rows: [{ status: "active", available_credits: 0 }], rowCount: 1 };
      }
      if (sql.includes("idempotency_key") && !sql.includes("INSERT")) return { rows: [], rowCount: 0 };
      if (sql.includes("JOIN report_credit_chains") && sql.includes("predecessor")) {
        return { rows: [{
          id: "report-1", account_id: "account-1", flow: "message", use_ai: true,
          request_input: input, request_hash: ReportRepository.requestHash(input),
          prepared_input: { country: "DE", category: "x", description: "d", finalText: "f" },
          legal_reference: null, research_summary: null, research_sources: [],
          credit_chain_id: "chain-1", credit_state: "consumed", status: "failed",
          discord_status: null, review_status: null, error_code: "discord_network_error",
          submission_started_at: null, successor_report_id: null, updated_at: terminalAt,
          lifecycle_attempt: 1, retry_sequence: 0
        }], rowCount: 1 };
      }
      if (sql.includes("INSERT INTO account_reports")) {
        return { rows: [{ id: "report-2", account_id: "account-1", status: "queued" }], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    });

    await expect(repository.retry(
      "account-1", "report-1", "retry:immediate", { mode: "reuse" }
    )).resolves.toMatchObject({ created: true, report: { status: "queued" } });
  });

  it("reuses a consumed credit entitlement without requiring available balance", async () => {
    const { repository, client } = repositoryWithQueries((sql) => {
      if (sql.includes("FROM api_accounts") && sql.includes("FOR UPDATE")) {
        return { rows: [{ status: "active", available_credits: 0 }], rowCount: 1 };
      }
      if (sql.includes("idempotency_key") && !sql.includes("INSERT")) return { rows: [], rowCount: 0 };
      if (sql.includes("JOIN report_credit_chains") && sql.includes("predecessor")) {
        return { rows: [{
          id: "report-1", account_id: "account-1", flow: "message", use_ai: true,
          request_input: input, request_hash: ReportRepository.requestHash(input), prepared_input: { country: "DE", category: "x", description: "d", finalText: "f" },
          legal_reference: null, research_summary: null, research_sources: [], credit_chain_id: "chain-1",
          credit_state: "consumed", status: "submitted", discord_status: "closed_no_action", review_status: "not_approved",
          successor_report_id: null, updated_at: new Date("2026-09-04T00:00:00Z"), lifecycle_attempt: 1
        }], rowCount: 1 };
      }
      if (sql.includes("INSERT INTO account_reports")) {
        return { rows: [{ id: "report-2", account_id: "account-1", status: "queued" }], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    });

    const result = await repository.retry("account-1", "report-1", "retry:key-1", { mode: "rewrite_ai" });

    expect(result.created).toBe(true);
    expect(client.query.mock.calls.some(([sql]) => String(sql).includes("available_credits = available_credits - 1"))).toBe(false);
    expect(client.query.mock.calls.some(([sql, values]) => String(sql).includes("retry_chain_reuse") && values?.includes("chain-1"))).toBe(true);
  });

  it("rejects a released-chain retry when the account has no new credit", async () => {
    const { repository } = repositoryWithQueries((sql) => {
      if (sql.includes("FROM api_accounts") && sql.includes("FOR UPDATE")) {
        return { rows: [{ status: "active", available_credits: 0 }], rowCount: 1 };
      }
      if (sql.includes("idempotency_key") && !sql.includes("INSERT")) return { rows: [], rowCount: 0 };
      if (sql.includes("JOIN report_credit_chains") && sql.includes("predecessor")) {
        return { rows: [{
          id: "report-1", account_id: "account-1", use_ai: true, prepared_input: null,
          credit_chain_id: "chain-1", credit_state: "released", status: "failed",
          error_code: "preparation_failed", successor_report_id: null,
          updated_at: new Date("2026-09-04T00:00:00Z")
        }], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    });

    await expect(repository.retry("account-1", "report-1", "retry:key-1", { mode: "regenerate" }))
      .rejects.toMatchObject({ code: "credits_exhausted" });
  });

  it("does not expose report retries while an automatic appeal is still in progress", async () => {
    const { repository } = repositoryWithQueries((sql) => {
      if (sql.includes("FROM api_accounts") && sql.includes("FOR UPDATE")) {
        return { rows: [{ status: "active", available_credits: 0 }], rowCount: 1 };
      }
      if (sql.includes("idempotency_key") && !sql.includes("INSERT")) return { rows: [], rowCount: 0 };
      if (sql.includes("JOIN report_credit_chains") && sql.includes("predecessor")) {
        return { rows: [{
          id: "report-1", account_id: "account-1", use_ai: true,
          prepared_input: { country: "DE", category: "x", description: "d", finalText: "f" },
          credit_chain_id: "chain-1", credit_state: "consumed", status: "submitted",
          discord_status: "closed_no_action", review_status: "requested", error_code: null,
          successor_report_id: null, updated_at: new Date("2026-09-04T00:00:00Z")
        }], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    });

    await expect(repository.retry("account-1", "report-1", "retry:key-2", { mode: "reuse" }))
      .rejects.toMatchObject({ code: "invalid_retry" });
  });

  it("copies immutable evidence but applies only manual replacement fields", async () => {
    const { repository, client } = repositoryWithQueries((sql) => {
      if (sql.includes("FROM api_accounts") && sql.includes("FOR UPDATE")) return { rows: [{ status: "active", available_credits: 0 }], rowCount: 1 };
      if (sql.includes("idempotency_key") && !sql.includes("INSERT")) return { rows: [], rowCount: 0 };
      if (sql.includes("JOIN report_credit_chains") && sql.includes("predecessor")) return { rows: [{
        id: "report-1", account_id: "account-1", flow: "profile", use_ai: true,
        request_input: { flow: "profile", useAi: true, country: "FR", category: "old", description: "old", target: {
          reportedUsername: "example", reportedUserId: "123456789012345678", reportedUserSnapshot: { userId: "123456789012345678", username: "example", globalDisplayName: null, avatarUrl: null, bot: false, resolvedAt: "2026-09-04T00:00:00Z" }, profileElements: ["name"]
        } },
        prepared_input: { country: "FR", category: "old", description: "old", finalText: "old" },
        credit_chain_id: "chain-1", credit_state: "consumed", status: "submitted",
        discord_status: "review_not_approved", review_status: "not_approved", error_code: null,
        successor_report_id: null, updated_at: new Date("2026-09-04T00:00:00Z"), lifecycle_attempt: 1,
        research_sources: []
      }], rowCount: 1 };
      if (sql.includes("INSERT INTO account_reports")) return { rows: [{ id: "report-2", account_id: "account-1", status: "queued" }], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    });

    await repository.retry("account-1", "report-1", "retry:manual", {
      mode: "edit_manual", country: "DE", category: "new", finalText: "A complete replacement.", profileElements: ["photos"]
    });

    const insert = client.query.mock.calls.find(([sql]) => String(sql).includes("INSERT INTO account_reports"));
    expect(insert?.[1]?.[7]).toMatchObject({
      flow: "profile", useAi: false, country: "DE", category: "new", finalText: "A complete replacement.",
      target: { reportedUserId: "123456789012345678", profileElements: ["photos"] }
    });
  });
});

describe("durable event delivery claims", () => {
  it("excludes a delivery when an earlier same-report event is still pending or sending for the destination", async () => {
    const query = vi.fn(async (_sql: string) => ({ rows: [], rowCount: 0 }));
    const repository = new ReportRepository({ query } as never);

    await repository.claimEventDelivery();

    const claim = query.mock.calls.find(([sql]) => String(sql).includes("claimed AS ("));
    expect(claim).toBeDefined();
    const sql = String(claim?.[0]);
    expect(sql).toContain("NOT EXISTS");
    expect(sql).toContain("blocker.destination_id = delivery.destination_id");
    expect(sql).toContain("blocker.event_id < delivery.event_id");
    expect(sql).toContain("blocker_event.report_id = event.report_id");
    expect(sql).toContain("blocker.state IN ('pending', 'sending')");
  });

  it("throttles the 7-day expiry sweep to at most once a minute across concurrent claim loops", async () => {
    const query = vi.fn(async (_sql: string) => ({ rows: [], rowCount: 0 }));
    const repository = new ReportRepository({ query } as never);

    await Promise.all([repository.claimEventDelivery(), repository.claimEventDelivery(), repository.claimEventDelivery()]);

    const expiryCalls = query.mock.calls.filter(([sql]) => String(sql).includes("SET state = 'expired'"));
    expect(expiryCalls.length).toBe(1);
  });
});

describe("ambiguous submission recovery", () => {
  it("adopts a report stuck as ambiguous_submission_state once a matching pending report-update email proves the submission, oldest message first", async () => {
    const client = {
      query: vi.fn(async (sql: string, values?: unknown[]) => {
        if (sql.includes("FROM account_reports AS report") && sql.includes("EXISTS")) {
          return { rows: [{ id: "report-1", account_id: "account-1", lifecycle_attempt: 1 }], rowCount: 1 };
        }
        if (sql.includes("SELECT external_report_id FROM account_inbound_messages")) {
          return { rows: [{ external_report_id: "1548921252872462416" }], rowCount: 1 };
        }
        if (sql.startsWith("UPDATE account_reports SET discord_report_id")) {
          return { rows: [{ id: "report-1", account_id: "account-1", lifecycle_attempt: 1 }], rowCount: 1 };
        }
        if (sql.includes("INSERT INTO account_report_events")) return { rows: [{ id: "1" }], rowCount: 1 };
        return { rows: [], rowCount: 0 };
      }),
      release: vi.fn()
    };
    const repository = new ReportRepository({ connect: async () => client } as never);

    await repository.reconcilePendingInboundMessages();

    const adopt = client.query.mock.calls.find(([sql]) => String(sql).startsWith("UPDATE account_reports SET discord_report_id"));
    expect(adopt?.[1]).toEqual(["report-1", "1548921252872462416"]);
    expect(adopt?.[0]).toContain("error_code = NULL");
    expect(adopt?.[0]).toContain("status = 'submitted'");
    const event = client.query.mock.calls.find(([sql, values]) => String(sql).includes("INSERT INTO account_report_events") && values?.includes("report_receipt_recovered"));
    expect(event).toBeDefined();
    const oldest = client.query.mock.calls.find(([sql]) => String(sql).includes("SELECT external_report_id FROM account_inbound_messages"));
    expect(String(oldest?.[0])).toContain("ORDER BY received_at, message_id LIMIT 1");
    expect(String(oldest?.[0])).toContain("external_status IS DISTINCT FROM 'review_received'");
  });
});
