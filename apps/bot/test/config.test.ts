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
    GROQ_API_KEY: "groq-secret",
    BRAVE_SEARCH_API_KEY: "brave-secret"
  };
}

describe("bot configuration", () => {
  it("requires Groq and Brave keys and defaults to GPT-OSS 120B", () => {
    const config = loadBotConfig(environment());
    expect(config.groqModel).toBe("openai/gpt-oss-120b");

    const withoutGroq = environment();
    delete withoutGroq.GROQ_API_KEY;
    expect(() => loadBotConfig(withoutGroq)).toThrow(/GROQ_API_KEY is required/);

    const withoutBrave = environment();
    delete withoutBrave.BRAVE_SEARCH_API_KEY;
    expect(() => loadBotConfig(withoutBrave)).toThrow(/BRAVE_SEARCH_API_KEY is required/);
  });

  it("allows the Groq model to be configured", () => {
    expect(
      loadBotConfig({ ...environment(), GROQ_MODEL: "openai/gpt-oss-20b" }).groqModel
    ).toBe("openai/gpt-oss-20b");
  });
});
