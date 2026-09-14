import { describe, expect, it, vi } from "vitest";
import { ReportRepository } from "../src/report-repository.js";

describe("report diagnostics", () => {
  it("persists bounded report-scoped diagnostics and purges expired rows", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 1 });
    const repository = new ReportRepository({ query } as never);
    await repository.recordDiagnostic({ reportId: "11111111-1111-4111-8111-111111111111", traceId: "22222222-2222-4222-8222-222222222222", service: "api", severity: "error", event: "submit_review_failed", stage: "appeal", outcome: "failed", lifecycleAttempt: 3, reporterEmail: "test.alias@example.test", errorCode: "discord_network_error", details: { errorCode: "discord_network_error", body: "x".repeat(70_000) } });
    await repository.purgeDiagnostics();
    expect(query.mock.calls[0]?.[0]).toContain("account_report_diagnostics");
    const params = query.mock.calls[0]?.[1] as unknown[];
    expect(JSON.stringify(params[10]).length).toBeLessThanOrEqual(65_536);
    expect(params[10]).toMatchObject({ truncated: true });
    expect(query.mock.calls[1]?.[0]).toContain("created_at < now() - interval '30 days'");
  });
});
