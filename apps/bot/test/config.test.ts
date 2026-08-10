import { randomBytes } from "node:crypto";

import { describe, expect, it } from "vitest";

import { loadBotConfig } from "../src/config.js";

function environment(): NodeJS.ProcessEnv {
  return {
    DISCORD_BOT_TOKEN: "discord-token",
    DISCORD_APPLICATION_ID: "123456789012345678",
    DISCORD_ADMIN_USER_IDS: "223456789012345678",
    ACCESS_KEY_PEPPER: "p".repeat(32),
    BOT_DATA_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
    BOT_DATABASE_URL: "postgresql://localhost/bot",
    DSA_API_BASE_URL: "https://api.example.test",
    DSA_API_KEY: "a".repeat(32),
    FIREWORKS_API_KEY: "fireworks-secret",
    BRAVE_SEARCH_API_KEY: "brave-secret"
  };
}

describe("bot configuration", () => {
  it("requires Fireworks and Brave keys and defaults to DeepSeek V4 Flash", () => {
    const config = loadBotConfig(environment());
    expect(config.fireworksModel).toBe("accounts/fireworks/models/deepseek-v4-flash");

    const withoutFireworks = environment();
    delete withoutFireworks.FIREWORKS_API_KEY;
    expect(() => loadBotConfig(withoutFireworks)).toThrow(/FIREWORKS_API_KEY is required/);

    const withoutBrave = environment();
    delete withoutBrave.BRAVE_SEARCH_API_KEY;
    expect(() => loadBotConfig(withoutBrave)).toThrow(/BRAVE_SEARCH_API_KEY is required/);
  });

  it("allows the Fireworks model to be configured", () => {
    expect(
      loadBotConfig({
        ...environment(),
        FIREWORKS_MODEL: "accounts/fireworks/models/deepseek-v4-pro"
      }).fireworksModel
    ).toBe("accounts/fireworks/models/deepseek-v4-pro");
  });

  it("does not require obsolete Groq or OpenRouter configuration", () => {
    const config = loadBotConfig({
      ...environment(),
      GROQ_API_KEY: "obsolete",
      OPENROUTER_API_KEY: "obsolete"
    });

    expect(config).not.toHaveProperty("groqApiKey");
    expect(config).not.toHaveProperty("openRouterApiKey");
  });
});
