import { Buffer } from "node:buffer";
import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  randomUUID
} from "node:crypto";

const ALGORITHM = "aes-256-gcm";

export interface GeneratedAccessKey {
  code: string;
  hash: string;
  id: string;
  prefix: string;
}

export function hashAccessKey(code: string, pepper: string): string {
  return createHmac("sha256", pepper).update(code.trim()).digest("hex");
}

export function generateAccessKey(pepper: string): GeneratedAccessKey {
  const code = `dsa_${randomBytes(32).toString("base64url")}`;
  return {
    code,
    hash: hashAccessKey(code, pepper),
    id: randomUUID(),
    prefix: `${code.slice(0, 12)}…`
  };
}

export function encryptJson(value: unknown, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(value), "utf8"),
    cipher.final()
  ]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ciphertext]).toString("base64url");
}

export function decryptJson<T>(value: string, key: Buffer): T {
  const packed = Buffer.from(value, "base64url");
  if (packed.length < 29) throw new Error("Encrypted value is invalid.");
  const iv = packed.subarray(0, 12);
  const tag = packed.subarray(12, 28);
  const ciphertext = packed.subarray(28);
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return JSON.parse(plaintext.toString("utf8")) as T;
}
