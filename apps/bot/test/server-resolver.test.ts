import { describe, expect, it } from "vitest";

import { ServerResolver } from "../src/server-resolver.js";

describe("server display resolution", () => {
  it("returns the server icon, name, description, and counts when Discord exposes them", async () => {
    const client = {
      guilds: { fetch: () => Promise.resolve({
        id: "123456789012345678", name: "Example Community", description: "Example description",
        approximateMemberCount: 100, approximatePresenceCount: 20,
        iconURL: () => "https://cdn.discordapp.com/icons/123/icon.png"
      }) }
    };

    await expect(new ServerResolver(client as never).resolve("123456789012345678")).resolves.toEqual({
      idOrInvite: "123456789012345678",
      name: "Example Community",
      description: "Example description",
      imageUrl: "https://cdn.discordapp.com/icons/123/icon.png",
      memberCount: 100,
      presenceCount: 20
    });
  });
});
