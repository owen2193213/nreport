import { Buffer } from "node:buffer";

export interface BotConfig {
  apiBaseUrl: string;
  adminApiKey: string;
  applicationId: string;
  adminUserIds: ReadonlySet<string>;
  databaseUrl: string;
  dataEncryptionKey: Buffer;
  environment: string;
  port: number;
  token: string;
  reportEventWebhookSecret?: string;
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
  const key = Buffer.from(required(env, "BOT_DATA_ENCRYPTION_KEY"), "base64");
  if (key.length !== 32) throw new Error("BOT_DATA_ENCRYPTION_KEY must be a Base64-encoded 32-byte key.");
  return key;
}

export function loadBotConfig(env: NodeJS.ProcessEnv = process.env): BotConfig {
  const adminUserIds = required(env, "DISCORD_ADMIN_USER_IDS")
    .split(",")
    .map((value) => snowflake(value.trim(), "DISCORD_ADMIN_USER_IDS"));
  const port = Number(env.PORT ?? "3000");
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new Error("PORT must be a valid port number.");
  const reportEventWebhookSecret = env.REPORT_EVENT_WEBHOOK_SECRET?.trim();
  if (reportEventWebhookSecret !== undefined && reportEventWebhookSecret.length < 32) {
    throw new Error("REPORT_EVENT_WEBHOOK_SECRET must contain at least 32 characters.");
  }
  return {
    apiBaseUrl: new URL(required(env, "DSA_API_BASE_URL")).toString(),
    adminApiKey: secret(env, "DSA_ADMIN_API_KEY"),
    applicationId: snowflake(required(env, "DISCORD_APPLICATION_ID"), "DISCORD_APPLICATION_ID"),
    adminUserIds: new Set(adminUserIds),
    databaseUrl: required(env, "BOT_DATABASE_URL"),
    dataEncryptionKey: encryptionKey(env),
    environment: env.NODE_ENV?.trim() || "development",
    port,
    token: required(env, "DISCORD_BOT_TOKEN"),
    ...(reportEventWebhookSecret === undefined ? {} : { reportEventWebhookSecret })
  };
}
