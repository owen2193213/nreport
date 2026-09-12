/* eslint-disable @typescript-eslint/require-await, @typescript-eslint/no-unused-vars */
import { describe, expect, it, vi } from "vitest";

import { WebhookDestinationRepository, validateWebhookUrl } from "../src/webhook-destinations.js";

describe("administrator-managed webhook destinations", () => {
  it("allows public HTTPS and only explicitly enabled Railway private HTTP", () => {
    expect(validateWebhookUrl("https://bot.example.test/events", false).protocol).toBe("https:");
    expect(() => validateWebhookUrl("http://127.0.0.1/events", true)).toThrow();
    expect(() => validateWebhookUrl("http://bot.railway.internal/events", false)).toThrow();
    expect(validateWebhookUrl("http://bot.railway.internal/events", true).hostname).toBe("bot.railway.internal");
  });

  it("stores an encrypted signing secret rather than plaintext", async () => {
    const query = vi.fn(async (_sql: string, _values?: unknown[]) => ({
      rows: [{ id: "dest-1", name: "Bot", url: "https://bot.example.test/events", status: "active", created_at: new Date() }],
      rowCount: 1
    }));
    const repository = new WebhookDestinationRepository({ query } as never, Buffer.alloc(32, 7), false);

    await repository.create("Bot", "https://bot.example.test/events", "s".repeat(32));

    const values = query.mock.calls[0]?.[1] ?? [];
    expect(values).not.toContain("s".repeat(32));
    expect(String(values?.[3])).not.toContain("s".repeat(32));
  });

  it("configures the managed default and assigns only unassigned active accounts", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({
        rows: [{ id: "dest-1", name: "NReport bot", url: "http://bot.railway.internal/events", status: "active", created_at: new Date() }],
        rowCount: 1
      })
      .mockResolvedValueOnce({ rows: [], rowCount: 3 });
    const repository = new WebhookDestinationRepository({ query } as never, Buffer.alloc(32, 7), true);
    const configure = (repository as unknown as {
      configureManagedDefault?: (url: string, signingSecret: string) => Promise<{ destinationId: string; assignedAccountCount: number }>;
    }).configureManagedDefault;

    if (configure === undefined) {
      expect(configure).toBeTypeOf("function");
      return;
    }

    await expect(configure.call(repository, "http://bot.railway.internal/events", "s".repeat(32))).resolves.toEqual({
      destinationId: "dest-1",
      assignedAccountCount: 3
    });

    const assignment = query.mock.calls.find(([sql]) => String(sql).includes("UPDATE api_accounts"));
    expect(assignment?.[0]).toContain("webhook_destination_id IS NULL");
    expect(assignment?.[0]).toContain("status = 'active'");
    expect(assignment?.[1]).toEqual(["dest-1"]);
  });
});
