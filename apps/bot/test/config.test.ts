import { randomBytes } from "node:crypto";

import { describe, expect, it } from "vitest";

import { loadBotConfig } from "../src/config.js";

function environment(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    DISCORD_BOT_TOKEN: "discord-token",
    DISCORD_APPLICATION_ID: "123456789012345678",
    DISCORD_ADMIN_USER_IDS: "223456789012345678",
    ACCESS_KEY_PEPPER: "p".repeat(32),
    BOT_DATA_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
    BOT_DATABASE_URL: "postgresql://localhost/bot",
    DSA_API_BASE_URL: "https://api.example.test",
    DSA_API_KEY: "a".repeat(32),
    OPENROUTER_API_KEY: "openrouter-secret",
    BRAVE_SEARCH_API_KEY: "brave-secret",
    ...overrides
  };
}

describe("bot configuration", () => {
  it("defaults to OpenRouter with DeepSeek V4 Flash when OPENROUTER_API_KEY is supplied", () => {
    const config = loadBotConfig(environment());
    expect(config.aiProvider).toBe("openrouter");
    expect(config.aiApiKey).toBe("openrouter-secret");
    expect(config.aiModel).toBe("deepseek/deepseek-v4-flash-0731");
  });

  it("defaults to Baseten when only BASETEN_API_KEY is supplied", () => {
    const env = environment();
    delete env.OPENROUTER_API_KEY;
    env.BASETEN_API_KEY = "baseten-secret";

    const config = loadBotConfig(env);
    expect(config.aiProvider).toBe("baseten");
    expect(config.aiApiKey).toBe("baseten-secret");
    expect(config.aiModel).toBe("deepseek-ai/DeepSeek-V4-Flash-0731");
  });

  it("supports explicit AI_PROVIDER=openrouter", () => {
    const config = loadBotConfig(
      environment({
        AI_PROVIDER: "openrouter",
        OPENROUTER_API_KEY: "openrouter-key",
        OPENROUTER_MODEL: "deepseek/deepseek-v4-flash-0731"
      })
    );
    expect(config.aiProvider).toBe("openrouter");
    expect(config.aiApiKey).toBe("openrouter-key");
    expect(config.aiModel).toBe("deepseek/deepseek-v4-flash-0731");
  });

  it("supports explicit AI_PROVIDER=baseten", () => {
    const config = loadBotConfig(
      environment({
        AI_PROVIDER: "baseten",
        BASETEN_API_KEY: "baseten-key",
        BASETEN_MODEL: "deepseek-ai/DeepSeek-V4-Flash-0731"
      })
    );
    expect(config.aiProvider).toBe("baseten");
    expect(config.aiApiKey).toBe("baseten-key");
    expect(config.aiModel).toBe("deepseek-ai/DeepSeek-V4-Flash-0731");
  });

  it("rejects invalid AI_PROVIDER values", () => {
    expect(() =>
      loadBotConfig(
        environment({
          AI_PROVIDER: "anthropic"
        })
      )
    ).toThrow(/AI_PROVIDER must be either 'openrouter' or 'baseten'/);
  });

  it("requires API key for the selected provider", () => {
    const envOpenRouter = environment({ AI_PROVIDER: "openrouter" });
    delete envOpenRouter.OPENROUTER_API_KEY;
    expect(() => loadBotConfig(envOpenRouter)).toThrow(/OPENROUTER_API_KEY is required/);

    const envBaseten = environment({ AI_PROVIDER: "baseten" });
    delete envBaseten.BASETEN_API_KEY;
    expect(() => loadBotConfig(envBaseten)).toThrow(/BASETEN_API_KEY is required/);
  });

  it("requires Brave search key", () => {
    const withoutBrave = environment();
    delete withoutBrave.BRAVE_SEARCH_API_KEY;
    expect(() => loadBotConfig(withoutBrave)).toThrow(/BRAVE_SEARCH_API_KEY is required/);
  });

  it("allows the AI model to be overridden via provider-specific or generic env variables", () => {
    expect(
      loadBotConfig(
        environment({
          AI_PROVIDER: "openrouter",
          OPENROUTER_MODEL: "deepseek/deepseek-v4-flash-custom"
        })
      ).aiModel
    ).toBe("deepseek/deepseek-v4-flash-custom");

    expect(
      loadBotConfig(
        environment({
          AI_PROVIDER: "baseten",
          BASETEN_API_KEY: "baseten-key",
          BASETEN_MODEL: "deepseek-ai/DeepSeek-V4-Custom"
        })
      ).aiModel
    ).toBe("deepseek-ai/DeepSeek-V4-Custom");
  });
});


