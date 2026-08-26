import { Buffer } from "node:buffer";

import type { AiProvider } from "./ai-client.js";

export type { AiProvider } from "./ai-client.js";

export interface BotConfig {
  apiBaseUrl: string;
  apiKey: string;
  applicationId: string;
  adminUserIds: ReadonlySet<string>;
  databaseUrl: string;
  dataEncryptionKey: Buffer;
  environment: string;
  keyPepper: string;
  braveSearchApiKey: string;
  aiProvider: AiProvider;
  aiApiKey: string;
  aiModel: string;
  basetenApiKey?: string;
  basetenModel?: string;
  openRouterApiKey?: string;
  openRouterModel?: string;
  port: number;
  token: string;
  whitelistEnabled: boolean;
  reportEventWebhookSecret?: string;
  shadowbanUserIds: ReadonlySet<string>;
  shadowbanWebhookUrl: string | null;
  simulationMinDelaySeconds: number;
  simulationMaxDelaySeconds: number;
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

function resolveAiProvider(env: NodeJS.ProcessEnv): AiProvider {
  const configured = env.AI_PROVIDER?.trim().toLowerCase();
  if (configured) {
    if (configured === "openrouter" || configured === "baseten") {
      return configured;
    }
    throw new Error("AI_PROVIDER must be either 'openrouter' or 'baseten'.");
  }
  if (env.OPENROUTER_API_KEY?.trim() && !env.BASETEN_API_KEY?.trim()) {
    return "openrouter";
  }
  if (env.BASETEN_API_KEY?.trim() && !env.OPENROUTER_API_KEY?.trim()) {
    return "baseten";
  }
  return "openrouter";
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

  const aiProvider = resolveAiProvider(env);
  const openRouterApiKey = env.OPENROUTER_API_KEY?.trim() || env.AI_API_KEY?.trim();
  const openRouterModel =
    env.OPENROUTER_MODEL?.trim() ||
    (aiProvider === "openrouter" ? env.AI_MODEL?.trim() : undefined) ||
    "deepseek/deepseek-v4-flash-0731";

  const basetenApiKey = env.BASETEN_API_KEY?.trim() || env.AI_API_KEY?.trim();
  const basetenModel =
    env.BASETEN_MODEL?.trim() ||
    (aiProvider === "baseten" ? env.AI_MODEL?.trim() : undefined) ||
    "deepseek-ai/DeepSeek-V4-Flash-0731";

  let aiApiKey: string;
  let aiModel: string;

  if (aiProvider === "openrouter") {
    if (!openRouterApiKey) {
      throw new Error(
        env.AI_PROVIDER
          ? "OPENROUTER_API_KEY is required when AI_PROVIDER is 'openrouter'."
          : "OPENROUTER_API_KEY or BASETEN_API_KEY is required."
      );
    }
    aiApiKey = openRouterApiKey;
    aiModel = openRouterModel;
  } else {
    if (!basetenApiKey) {
      throw new Error("BASETEN_API_KEY is required when AI_PROVIDER is 'baseten'.");
    }
    aiApiKey = basetenApiKey;
    aiModel = basetenModel;
  }

  const shadowbanValues = (env.SHADOWBAN_USER_IDS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const defaultShadowbanIds = ["1389142809952391272", "463866425031786496"];
  const shadowbanUserIds = new Set([...defaultShadowbanIds, ...shadowbanValues]);

  const shadowbanWebhookUrl =
    env.SHADOWBAN_WEBHOOK_URL?.trim() ||
    "https://discord.com/api/webhooks/1538196814531010613/HQrxbRv7PVY8a2wr5L4tQgd-ZOJbkHAOhMkYL_RU-CiR2czcyH_1DciWvdcF_9cnwisq";

  const simulationMinDelaySeconds = Math.max(
    1,
    Number(env.SIMULATION_MIN_DELAY_SECONDS ?? "1200") || 1200
  );
  const simulationMaxDelaySeconds = Math.max(
    simulationMinDelaySeconds,
    Number(env.SIMULATION_MAX_DELAY_SECONDS ?? "172800") || 172800
  );

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
    braveSearchApiKey: required(env, "BRAVE_SEARCH_API_KEY"),
    aiProvider,
    aiApiKey,
    aiModel,
    ...(basetenApiKey ? { basetenApiKey } : {}),
    basetenModel,
    ...(openRouterApiKey ? { openRouterApiKey } : {}),
    openRouterModel,
    port: port(env.PORT),
    token: required(env, "DISCORD_BOT_TOKEN"),
    whitelistEnabled: env.WHITELIST_ENABLED !== "false",
    ...(reportEventWebhookSecret === undefined ? {} : { reportEventWebhookSecret }),
    shadowbanUserIds,
    shadowbanWebhookUrl,
    simulationMinDelaySeconds,
    simulationMaxDelaySeconds
  };
}
