import { Buffer } from "node:buffer";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual
} from "node:crypto";

const ALGORITHM = "aes-256-gcm";

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

function safeEqual(left: string, right: string): boolean {
  const leftHash = createHash("sha256").update(left).digest();
  const rightHash = createHash("sha256").update(right).digest();
  return timingSafeEqual(leftHash, rightHash);
}

export function verifyReportEventSignature(input: {
  secret: string;
  timestamp: string;
  eventId: string;
  body: string;
  signature: string;
  now?: number;
}): boolean {
  const timestampMs = Number(input.timestamp) * 1_000;
  if (
    !Number.isFinite(timestampMs) ||
    Math.abs((input.now ?? Date.now()) - timestampMs) > 5 * 60_000
  ) {
    return false;
  }
  const bodyHash = createHash("sha256").update(input.body).digest("hex");
  const expected = createHmac("sha256", input.secret)
    .update(`${input.timestamp}\n${input.eventId}\n${bodyHash}`)
    .digest("hex");
  return safeEqual(expected, input.signature);
}
