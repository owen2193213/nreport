import { describe, expect, it, vi } from "vitest";

import { ReportRepository } from "../src/report-repository.js";

describe("operational alert outbox", () => {
  it("assigns each recurring reminder a new notification sequence", async () => {
    const client = {
      query: vi.fn((sql: string, _values?: unknown[]) => {
        void _values;
        if (sql.includes("SELECT state, last_sent_at")) {
          return Promise.resolve({ rows: [{ state: "open", last_sent_at: new Date(Date.now() - 31 * 60_000), episode: "4", notification_sequence: "1" }], rowCount: 1 });
        }
        if (sql.includes("SELECT alert_key, episode")) return Promise.resolve({ rows: [], rowCount: 0 });
        return Promise.resolve({ rows: [], rowCount: 1 });
      }),
      release: vi.fn()
    };
    const repository = new ReportRepository({ connect: () => Promise.resolve(client) } as never);

    await repository.transitionOperationalAlerts([{ key: "queue.preparation.no_progress", severity: "critical" }]);

    const outboxInsert = client.query.mock.calls.find(([sql]) => String(sql).includes("INSERT INTO operations_alert_outbox"));
    expect(String(outboxInsert?.[0])).toContain("notification_sequence");
    expect(String(outboxInsert?.[0])).toContain("ON CONFLICT (alert_key, episode, notification_sequence)");
    expect(outboxInsert?.[1]).toContain(2);
  });
});
