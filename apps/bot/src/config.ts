import { Buffer } from "node:buffer";

export interface BotConfig {
  apiBaseUrl: string;
  apiKey: string;
  applicationId: string;
  adminUserIds: ReadonlySet<string>;
  databaseUrl: string;
  dataEncryptionKey: Buffer;
  environment: string;
  keyPepper: string;
  openRouterApiKey: string;
  openRouterModel: string;
  openRouterWriterReasoningEffort: ReasoningEffort;
  port: number;
  token: string;
  whitelistEnabled: boolean;
  reportEventWebhookSecret?: string;
}

export type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

function reasoningEffort(value: string | undefined): ReasoningEffort {
  const normalized = value?.trim().toLowerCase() || "high";
  if (
    normalized !== "none" &&
    normalized !== "minimal" &&
    normalized !== "low" &&
    normalized !== "medium" &&
    normalized !== "high" &&
    normalized !== "xhigh" &&
    normalized !== "max"
  ) {
    throw new Error(
      "OPENROUTER_WRITER_REASONING_EFFORT must be none, minimal, low, medium, high, xhigh, or max."
    );
  }
  return normalized;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function secret(env: NodeJS.ProcessEnv, name: string): string {
  const value = required(env, name);
  if (value.length < 32) throw new Error(`${name} must contain at least 32 characters.`);
  return value;
}

function snowflake(value: string, name: string): string {
  if (!/^\d{15,22}$/.test(value)) throw new Error(`${name} must be a Discord snowflake.`);
  return value;
}

function encryptionKey(env: NodeJS.ProcessEnv): Buffer {
  const value = required(env, "BOT_DATA_ENCRYPTION_KEY");
  const key = Buffer.from(value, "base64");
  if (key.length !== 32) {
    throw new Error("BOT_DATA_ENCRYPTION_KEY must be a Base64-encoded 32-byte key.");
  }
  return key;
}

function port(value: string | undefined): number {
  const parsed = Number(value ?? "3000");
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new Error("PORT must be a valid port number.");
  }
  return parsed;
}

export function loadBotConfig(env: NodeJS.ProcessEnv = process.env): BotConfig {
  const adminValues = required(env, "DISCORD_ADMIN_USER_IDS")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (adminValues.length === 0) throw new Error("At least one Discord admin ID is required.");

  const apiBaseUrl = new URL(required(env, "DSA_API_BASE_URL")).toString();
  const reportEventWebhookSecret = env.REPORT_EVENT_WEBHOOK_SECRET?.trim();
  if (reportEventWebhookSecret !== undefined && reportEventWebhookSecret.length < 32) {
    throw new Error("REPORT_EVENT_WEBHOOK_SECRET must contain at least 32 characters.");
  }
  return {
    apiBaseUrl,
    apiKey: secret(env, "DSA_API_KEY"),
    applicationId: snowflake(required(env, "DISCORD_APPLICATION_ID"), "DISCORD_APPLICATION_ID"),
    adminUserIds: new Set(
      adminValues.map((value) => snowflake(value, "DISCORD_ADMIN_USER_IDS"))
    ),
    databaseUrl: required(env, "BOT_DATABASE_URL"),
    dataEncryptionKey: encryptionKey(env),
    environment: env.NODE_ENV?.trim() || "development",
    keyPepper: secret(env, "ACCESS_KEY_PEPPER"),
    openRouterApiKey: required(env, "OPENROUTER_API_KEY"),
    openRouterModel: env.OPENROUTER_MODEL?.trim() || "qwen/qwen3.5-35b-a3b",
    openRouterWriterReasoningEffort: reasoningEffort(
      env.OPENROUTER_WRITER_REASONING_EFFORT
    ),
    port: port(env.PORT),
    token: required(env, "DISCORD_BOT_TOKEN"),
    whitelistEnabled: env.WHITELIST_ENABLED !== "false",
    ...(reportEventWebhookSecret === undefined ? {} : { reportEventWebhookSecret })
  };
}
