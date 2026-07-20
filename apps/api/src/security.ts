import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual
} from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;

export function encryptJson(value: unknown, key: Buffer): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const plaintext = Buffer.from(JSON.stringify(value), "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ciphertext]).toString("base64url");
}

export function decryptJson<T>(value: string, key: Buffer): T {
  const packed = Buffer.from(value, "base64url");
  if (packed.length <= IV_BYTES + 16) throw new Error("Encrypted value is invalid.");
  const iv = packed.subarray(0, IV_BYTES);
  const tag = packed.subarray(IV_BYTES, IV_BYTES + 16);
  const ciphertext = packed.subarray(IV_BYTES + 16);
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  return JSON.parse(
    Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8")
  ) as T;
}

export function sha256Hex(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export function signInboundEmail(
  secret: string,
  timestamp: string,
  recipient: string,
  messageId: string,
  rawEmail: Buffer
): string {
  const rawHash = sha256Hex(rawEmail);
  return createHmac("sha256", secret)
    .update(`${timestamp}\n${recipient}\n${messageId}\n${rawHash}`)
    .digest("hex");
}

export function safeEqual(left: string, right: string): boolean {
  const leftHash = createHash("sha256").update(left).digest();
  const rightHash = createHash("sha256").update(right).digest();
  return timingSafeEqual(leftHash, rightHash);
}

export function verifyInboundSignature(input: {
  secret: string;
  timestamp: string;
  recipient: string;
  messageId: string;
  rawEmail: Buffer;
  signature: string;
  now?: number;
}): boolean {
  const timestampMs = Number(input.timestamp) * 1000;
  const now = input.now ?? Date.now();
  if (!Number.isFinite(timestampMs) || Math.abs(now - timestampMs) > 5 * 60_000) {
    return false;
  }
  return safeEqual(
    signInboundEmail(
      input.secret,
      input.timestamp,
      input.recipient,
      input.messageId,
      input.rawEmail
    ),
    input.signature
  );
}
