import { Buffer } from "node:buffer";

export interface AppConfig {
  adminApiKey: string;
  apiKeyPepper: string;
  aiApiKey: string;
  aiModel: string;
  braveSearchApiKey: string;
  lifecycleConcurrency: number;
  preparationConcurrency: number;
  databaseUrl: string;
  emailDomain: string;
  environment: string;
  operationsAlertWebhookUrl?: string;
  port: number;
  proxyUrlTemplate?: string;
  sessionEncryptionKey: Buffer;
  webhookSecret: string;
  workerEnabled: boolean;
  allowRailwayPrivateHttpWebhooks?: boolean;
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

function encryptionKey(env: NodeJS.ProcessEnv): Buffer {
  const value = required(env, "SESSION_ENCRYPTION_KEY");
  const key = Buffer.from(value, "base64");
  if (key.length !== 32) {
    throw new Error("SESSION_ENCRYPTION_KEY must be a Base64-encoded 32-byte key.");
  }
  return key;
}

function parsePort(value: string | undefined): number {
  const port = Number(value ?? "3000");
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("PORT must be a valid TCP port.");
  }
  return port;
}

function positiveInteger(value: string | undefined, fallback: number, name: string): number {
  const parsed = Number(value ?? String(fallback));
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 16) {
    throw new Error(`${name} must be an integer between 1 and 16.`);
  }
  return parsed;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const adminApiKey = secret(env, "NREPORT_ADMIN_KEY");
  const apiKeyPepper = secret(env, "API_KEY_PEPPER");
  const aiApiKey = required(env, "AI_API_KEY");
  const aiModel = env.AI_MODEL?.trim() || "deepseek/deepseek-v4-flash-0731";
  const emailDomain = required(env, "REPORT_EMAIL_DOMAIN").toLowerCase();
  const environment = env.NODE_ENV?.trim() || "development";
  const operationsAlertWebhookUrl = env.OPERATIONS_ALERT_WEBHOOK_URL?.trim();
  if (environment === "production" && !operationsAlertWebhookUrl) {
    throw new Error("OPERATIONS_ALERT_WEBHOOK_URL is required in production.");
  }
  if (operationsAlertWebhookUrl !== undefined && !/^https:\/\/discord(?:app)?\.com\/api\/webhooks\//.test(operationsAlertWebhookUrl)) {
    throw new Error("OPERATIONS_ALERT_WEBHOOK_URL must be an HTTPS Discord webhook URL.");
  }
  if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(emailDomain)) {
    throw new Error("REPORT_EMAIL_DOMAIN must be a valid domain name.");
  }

  const proxyUrlTemplate = env.DSA_PROXY_URL_TEMPLATE?.trim();
  if (
    proxyUrlTemplate !== undefined &&
    (!proxyUrlTemplate.includes("{country}") || !proxyUrlTemplate.includes("{session}"))
  ) {
    throw new Error(
      "DSA_PROXY_URL_TEMPLATE must contain {country} and {session} placeholders."
    );
  }

  return {
    adminApiKey,
    apiKeyPepper,
    aiApiKey,
    aiModel,
    braveSearchApiKey: required(env, "BRAVE_SEARCH_API_KEY"),
    lifecycleConcurrency: positiveInteger(env.LIFECYCLE_CONCURRENCY, 2, "LIFECYCLE_CONCURRENCY"),
    preparationConcurrency: positiveInteger(env.PREPARATION_CONCURRENCY, 2, "PREPARATION_CONCURRENCY"),
    databaseUrl: required(env, "DATABASE_URL"),
    emailDomain,
    environment,
    ...(operationsAlertWebhookUrl === undefined ? {} : { operationsAlertWebhookUrl }),
    port: parsePort(env.PORT),
    ...(proxyUrlTemplate === undefined ? {} : { proxyUrlTemplate }),
    sessionEncryptionKey: encryptionKey(env),
    webhookSecret: secret(env, "CLOUDFLARE_EMAIL_WEBHOOK_SECRET"),
    workerEnabled: env.WORKER_ENABLED !== "false",
    allowRailwayPrivateHttpWebhooks: env.ALLOW_RAILWAY_PRIVATE_HTTP_WEBHOOKS === "true"
  };
}
