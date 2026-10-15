import { describe, expect, it, vi } from "vitest";
import { ReportRepository } from "../src/report-repository.js";
import { buildV2Server } from "../src/server-v2.js";
import type { AppConfig } from "../src/config.js";

const accountId = "11111111-1111-4111-8111-111111111111";
const reportId = "22222222-2222-4222-8222-222222222222";
const config = {
  adminApiKey: "synthetic-admin", apiKeyPepper: "p".repeat(32), aiApiKey: "synthetic-ai",
  aiModel: "model", braveSearchApiKey: "synthetic-brave", lifecycleConcurrency: 2,
  preparationConcurrency: 2, databaseUrl: "postgres://unused", emailDomain: "reports.example.test",
  environment: "test", port: 3000, sessionEncryptionKey: Buffer.alloc(32),
  webhookSecret: "w".repeat(32), workerEnabled: false
} satisfies AppConfig;

describe("pagination boundary validation", () => {
  it.each([
    { createdAt: "2026-10-15T01:00:00.123Z", id: "not-a-uuid" },
    { createdAt: "2026-02-30T01:00:00.123Z", id: reportId },
    { createdAt: "0000-01-01T01:00:00.123Z", id: reportId }
  ])("rejects invalid report cursor fields before SQL: %j", async (cursor) => {
    const query = vi.fn();
    const repository = new ReportRepository({ query } as never);
    const after = Buffer.from(JSON.stringify(cursor)).toString("base64url");
    await expect(repository.listOwned(accountId, after, 5)).rejects.toMatchObject({ code: "invalid_cursor" });
    expect(query).not.toHaveBeenCalled();
  });

  it("encodes the database timestamp without losing sub-millisecond precision", async () => {
    const exactTimestamp = "2026-10-15T01:00:00.123456Z";
    const query = vi.fn().mockResolvedValue({ rows: [
      { id: reportId, created_at: new Date(exactTimestamp), cursor_created_at: exactTimestamp },
      { id: accountId, created_at: new Date(exactTimestamp), cursor_created_at: exactTimestamp }
    ] });
    const page = await new ReportRepository({ query } as never).listOwned(accountId, null, 1);
    expect(JSON.parse(Buffer.from(page.next!, "base64url").toString("utf8"))).toEqual({ createdAt: exactTimestamp, id: reportId });
  });

  it.each(["events", "action-history"])("rejects overflowing bigint cursors on %s before querying", async (route) => {
    const read = vi.fn();
    const server = await buildV2Server(config, {
      healthcheck: vi.fn(),
      accounts: { authenticate: vi.fn().mockResolvedValue({ accountId, status: "active" }) },
      reports: { listEvents: read }, analytics: { actionHistory: read }
    } as never);
    try {
      const response = await server.inject({ method: "GET", url: `/v1/discord/dsa/${route}?after=9223372036854775808`, headers: { authorization: "Bearer synthetic-personal" } });
      expect(response.statusCode).toBe(400);
      expect(read).not.toHaveBeenCalled();
    } finally { await server.close(); }
  });

  it("preserves the largest PostgreSQL event cursor without rounding", async () => {
    const after = "9223372036854775807";
    const read = vi.fn().mockResolvedValue({ items: [], next: null });
    const server = await buildV2Server(config, {
      healthcheck: vi.fn(), accounts: { authenticate: vi.fn().mockResolvedValue({ accountId, status: "active" }) },
      reports: { listEvents: read }
    } as never);
    try {
      const response = await server.inject({ method: "GET", url: `/v1/discord/dsa/events?after=${after}`, headers: { authorization: "Bearer synthetic-personal" } });
      expect(response.statusCode).toBe(200);
      expect(read).toHaveBeenCalledWith(accountId, after, 50);
    } finally { await server.close(); }
  });
});
