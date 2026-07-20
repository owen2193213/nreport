import { Buffer } from "node:buffer";

export interface AppConfig {
  apiKey: string;
  databaseUrl: string;
  emailDomain: string;
  environment: string;
  port: number;
  proxyUrlTemplate?: string;
  sessionEncryptionKey: Buffer;
  webhookSecret: string;
  workerEnabled: boolean;
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

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const emailDomain = required(env, "REPORT_EMAIL_DOMAIN").toLowerCase();
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
    apiKey: secret(env, "API_KEY"),
    databaseUrl: required(env, "DATABASE_URL"),
    emailDomain,
    environment: env.NODE_ENV?.trim() || "development",
    port: parsePort(env.PORT),
    ...(proxyUrlTemplate === undefined ? {} : { proxyUrlTemplate }),
    sessionEncryptionKey: encryptionKey(env),
    webhookSecret: secret(env, "CLOUDFLARE_EMAIL_WEBHOOK_SECRET"),
    workerEnabled: env.WORKER_ENABLED !== "false"
  };
}
