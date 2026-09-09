/* eslint-disable @typescript-eslint/require-await, @typescript-eslint/no-unused-vars */
import { describe, expect, it, vi } from "vitest";

import { reportRetryableModes, ReportMutationError, ReportRepository } from "../src/report-repository.js";

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
  it("serializes legal source arrays as JSON instead of PostgreSQL arrays", async () => {
    const sources = [{ title: "EUR-Lex", url: "https://eur-lex.europa.eu/" }];
    const client = {
      query: vi.fn(async (sql: string, _values?: unknown[]) => {
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
      { aiRequests: 0, inputTokens: 0, outputTokens: 0, searchRequests: 0 }
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

    expect(await repository.saveAwaitingVerification("job-1", "report-1", "encrypted-session")).toBe(true);

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
        if (sql.includes("report.verification_deadline")) {
          return { rows: [{ id: "retry-1", account_id: "account-1", credit_chain_id: "chain-1", credit_state: "consumed", lifecycle_attempt: 2 }], rowCount: 1 };
        }
        if (sql.includes("INSERT INTO account_report_events")) return { rows: [{ id: "1" }], rowCount: 1 };
        return { rows: [], rowCount: 1 };
      }),
      release: vi.fn()
    };
    const repository = new ReportRepository({ connect: async () => client } as never);

    await repository.expireDeadlines();

    expect(client.query.mock.calls.some(([sql]) => String(sql).includes("chain.state IN ('reserved', 'consumed')"))).toBe(true);
    expect(client.query.mock.calls.some(([sql]) => String(sql).includes("available_credits = available_credits + 1"))).toBe(false);
    expect(client.query.mock.calls.some(([sql, values]) => String(sql).includes("verification_timeout") && values?.includes("retry-1"))).toBe(true);
  });
});

describe("lifecycle job leases", () => {
  it("refreshes a lease only while the lifecycle job is running", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ id: "job-1" }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const repository = new ReportRepository({ query } as never);

    await expect(repository.heartbeatLifecycleJob("job-1")).resolves.toBe(true);
    await expect(repository.heartbeatLifecycleJob("job-completed")).resolves.toBe(false);

    expect(query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("SET locked_at = now(), updated_at = now()"),
      ["job-1"]
    );
    expect(String(query.mock.calls[0]?.[0])).toContain("WHERE id = $1 AND state = 'running'");
    expect(String(query.mock.calls[0]?.[0])).toContain("RETURNING id");
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

    await repository.failPreparation("job-1", "report-1", "preparation_failed", "Preparation failed safely.");

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

    await repository.failPreparation("job-1", "report-1", "preparation_failed", "Preparation failed safely.");

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

    expect(await repository.beginSubmission("report-1")).toBe(true);

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

    expect(await repository.beginSubmission("report-2")).toBe(true);

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

    await expect(repository.saveAwaitingVerification("job-1", "report-1", "encrypted-session"))
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

    await repository.markSubmitted("job-1", "report-1", "discord-report-1");

    expect(client.query.mock.calls.some(([sql, values]) =>
      String(sql).includes("SET state = 'completed'") && values?.[0] === "job-1" && values?.[1] === "report-1"
    )).toBe(true);
    expect(client.query.mock.calls.some(([sql, values]) =>
      String(sql).includes("account_report_events") && values?.includes("report_submitted")
    )).toBe(true);
    expect(client.query).toHaveBeenCalledWith("COMMIT");
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
        { id: "11", account_id: "account-1", report_id: "report-1", event_type: "report_queued", lifecycle_attempt: 1, created_at: new Date("2026-09-04T00:00:00Z") },
        { id: "12", account_id: "account-1", report_id: "report-1", event_type: "report_planning", lifecycle_attempt: 1, created_at: new Date("2026-09-04T00:00:01Z") },
        { id: "13", account_id: "account-1", report_id: "report-1", event_type: "report_writing", lifecycle_attempt: 1, created_at: new Date("2026-09-04T00:00:02Z") }
      ],
      rowCount: 3
    }));
    const repository = new ReportRepository({ query } as never);

    const page = await repository.listEvents("account-1", null, 2);

    expect(page.items).toHaveLength(2);
    expect(page.next).toBe("12");
    expect(query.mock.calls[0]?.[1]).toEqual(["account-1", "0", 3]);
  });
});

describe("serial report retries", () => {
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

    const result = await repository.retry("account-1", "report-1", "retry:key-1", { mode: "rewrite_ai" }, new Date("2026-09-04T00:01:00Z"));

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

    await expect(repository.retry("account-1", "report-1", "retry:key-1", { mode: "regenerate" }, new Date("2026-09-04T00:01:00Z")))
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

    await expect(repository.retry("account-1", "report-1", "retry:key-2", { mode: "reuse" }, new Date("2026-09-04T00:01:00Z")))
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
    }, new Date("2026-09-04T00:01:00Z"));

    const insert = client.query.mock.calls.find(([sql]) => String(sql).includes("INSERT INTO account_reports"));
    expect(insert?.[1]?.[6]).toMatchObject({
      flow: "profile", useAi: false, country: "DE", category: "new", finalText: "A complete replacement.",
      target: { reportedUserId: "123456789012345678", profileElements: ["photos"] }
    });
  });
});
