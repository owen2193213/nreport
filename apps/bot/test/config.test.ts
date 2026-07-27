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
    OPENROUTER_API_KEY: "openrouter-secret"
  };
}

describe("bot configuration", () => {
  it("requires an OpenRouter key and defaults to DeepSeek V4 Pro", () => {
    const config = loadBotConfig(environment());
    expect(config.openRouterModel).toBe("deepseek/deepseek-v4-pro");
    expect(config.openRouterWriterReasoningEffort).toBe("high");
    const missing = environment();
    delete missing.OPENROUTER_API_KEY;
    expect(() => loadBotConfig(missing)).toThrow(/OPENROUTER_API_KEY is required/);
  });

  it("allows the OpenRouter model to be configured", () => {
    expect(
      loadBotConfig({ ...environment(), OPENROUTER_MODEL: "deepseek/deepseek-custom" }).openRouterModel
    ).toBe("deepseek/deepseek-custom");
  });

  it("validates the configurable writer reasoning effort", () => {
    expect(
      loadBotConfig({
        ...environment(),
        OPENROUTER_WRITER_REASONING_EFFORT: "high"
      }).openRouterWriterReasoningEffort
    ).toBe("high");
    expect(() =>
      loadBotConfig({
        ...environment(),
        OPENROUTER_WRITER_REASONING_EFFORT: "extreme"
      })
    ).toThrow(/OPENROUTER_WRITER_REASONING_EFFORT/);
  });
});
