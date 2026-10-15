import { afterEach, describe, expect, it, vi } from "vitest";

import { AccountInteractionHandler } from "../src/account-interactions.js";
import { COMMANDS } from "../src/commands.js";

const accountId = "11111111-1111-4111-8111-111111111111";
const connectedPrefix = "dsa_live_22222222-2222-4222-8222-222222222222";

function inventoryItem(input: {
  keyId: string;
  prefix: string;
  username?: string;
  accountStatus?: "active" | "suspended";
  revokedAt?: string | null;
}) {
  return {
    keyId: input.keyId,
    accountId,
    username: input.username ?? "Alice",
    accountStatus: input.accountStatus ?? "active",
    prefix: input.prefix,
    createdAt: "2026-10-01T00:00:00.000Z",
    lastUsedAt: "2026-10-02T00:00:00.000Z",
    overlapExpiresAt: null,
    revokedAt: input.revokedAt ?? null
  };
}

function adminInteraction(userId: string, page = 1) {
  let deferred = false;
  const editReply = vi.fn().mockResolvedValue(undefined);
  const reply = vi.fn().mockResolvedValue(undefined);
  const interaction = {
    isModalSubmit: () => false,
    isButton: () => false,
    isMessageContextMenuCommand: () => false,
    isChatInputCommand: () => true,
    commandName: "admin",
    options: {
      getSubcommand: () => "keys",
      getInteger: () => page
    },
    user: { id: userId },
    deferReply: vi.fn(() => { deferred = true; return Promise.resolve(); }),
    editReply,
    reply,
    isRepliable: () => true,
    get deferred() { return deferred; },
    replied: false
  };
  return { interaction, editReply, reply };
}

afterEach(() => vi.unstubAllGlobals());

describe("administrator API-key inventory", () => {
  it("registers a paginated inventory command and shows only current matching bot connections", async () => {
    const adminCommand = COMMANDS.find((command) => "name" in command && command.name === "admin");
    const keysCommand = adminCommand?.options?.find((option) => "name" in option && option.name === "keys");
    expect(keysCommand && "options" in keysCommand ? keysCommand.options : []).toContainEqual(
      expect.objectContaining({ name: "page", min_value: 1, max_value: 1_000_000 })
    );

    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      items: [
        inventoryItem({ keyId: "22222222-2222-4222-8222-222222222222", prefix: connectedPrefix }),
        inventoryItem({
          keyId: "33333333-3333-4333-8333-333333333333",
          prefix: "dsa_live_33333333-3333-4333-8333-333333333333",
          username: "Bob",
          accountStatus: "suspended",
          revokedAt: "2026-10-03T00:00:00.000Z"
        })
      ],
      page: 2,
      pageSize: 5,
      total: 7
    }), { headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    const connection = {
      discord_user_id: "123456789012345678",
      account_id: accountId,
      key_prefix: connectedPrefix,
      encrypted_api_key: "encrypted-existing-key"
    };
    const database = { connections: vi.fn().mockResolvedValue([connection]) };
    const handler = new AccountInteractionHandler({
      client: {} as never,
      config: {
        apiBaseUrl: "https://api.example.test",
        adminApiKey: "admin-secret",
        adminUserIds: new Set(["admin-user"]),
        dataEncryptionKey: Buffer.alloc(32)
      } as never,
      database: database as never,
      messageResolver: {} as never,
      profileResolver: {} as never,
      serverResolver: {} as never
    });
    const { interaction, editReply } = adminInteraction("admin-user", 2);

    await handler.handle(interaction as never);

    expect(interaction.deferReply).toHaveBeenCalledWith({ flags: 64 });
    const response = editReply.mock.calls[0]?.[0] as { content?: string; allowedMentions?: unknown };
    const content = response.content ?? "";
    expect(response.allowedMentions).toEqual({ parse: [] });
    expect(content).toContain("Page 2 of 2 · 7 API keys");
    expect(content).toContain("7. **Bob**");
    expect(content).toContain(accountId);
    expect(content).toContain(connectedPrefix);
    expect(content).toContain("Current bot connection: <@123456789012345678>");
    expect(content).toContain("last used: 2026-10-02T00:00:00.000Z");
    expect(content).toContain("Historical Discord users are not recorded");
    expect(content).toContain("account status: suspended");
    expect(content).toContain("revoked");
    const secondRecord = content.split("7. **Bob**")[1] ?? "";
    expect(secondRecord).toContain("Current bot connection: none");
    expect(secondRecord).not.toContain("<@123456789012345678>");
    expect(content).not.toContain("encrypted-existing-key");
    expect(database.connections).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url instanceof URL ? url.href : undefined).toBe("https://api.example.test/v1/admin/discord/dsa/keys?page=2");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer admin-secret");
  });

  it("keeps a maximum-length inventory page below Discord's message limit", async () => {
    const ids = [
      "44444444-4444-4444-8444-444444444444",
      "55555555-5555-4555-8555-555555555555",
      "66666666-6666-4666-8666-666666666666",
      "77777777-7777-4777-8777-777777777777",
      "88888888-8888-4888-8888-888888888888"
    ];
    const items = ids.map((keyId, index) => inventoryItem({
      keyId,
      prefix: `dsa_live_${keyId}`,
      username: "x".repeat(32),
      accountStatus: index === 0 ? "suspended" : "active"
    }));
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      items, page: 1, pageSize: 5, total: 5
    }), { headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const connections = items.map((item) => ({
      discord_user_id: "12345678901234567890",
      account_id: item.accountId,
      key_prefix: item.prefix,
      encrypted_api_key: "encrypted-existing-key"
    }));
    const handler = new AccountInteractionHandler({
      client: {} as never,
      config: {
        apiBaseUrl: "https://api.example.test",
        adminApiKey: "admin-secret",
        adminUserIds: new Set(["admin-user"]),
        dataEncryptionKey: Buffer.alloc(32)
      } as never,
      database: { connections: vi.fn().mockResolvedValue(connections) } as never,
      messageResolver: {} as never,
      profileResolver: {} as never,
      serverResolver: {} as never
    });
    const { interaction, editReply } = adminInteraction("admin-user");

    await handler.handle(interaction as never);

    const response = editReply.mock.calls[0]?.[0] as { content?: string };
    expect(response.content?.length).toBeLessThanOrEqual(2000);
    expect(response.content).toContain("account status: suspended");
    expect(response.content).toContain("Key status: active");
  });

  it("blocks non-admin users before reading the inventory", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);
    const handler = new AccountInteractionHandler({
      client: {} as never,
      config: {
        apiBaseUrl: "https://api.example.test",
        adminApiKey: "admin-secret",
        adminUserIds: new Set(["someone-else"]),
        dataEncryptionKey: Buffer.alloc(32)
      } as never,
      database: { connections: vi.fn() } as never,
      messageResolver: {} as never,
      profileResolver: {} as never,
      serverResolver: {} as never
    });
    const { interaction, reply } = adminInteraction("ordinary-user");

    await handler.handle(interaction as never);

    expect(reply).toHaveBeenCalledWith({ content: "Administrator access is required.", flags: 64 });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
