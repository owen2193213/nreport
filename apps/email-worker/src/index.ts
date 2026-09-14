interface Env {
  INGEST_URL: string;
  DIAGNOSTIC_URL?: string;
  INGEST_SHARED_SECRET: string;
}

function workerLog(level: "info" | "warn" | "error", event: string, fields: Record<string, unknown> = {}): void {
  const payload = JSON.stringify({
    timestamp: new Date().toISOString(), service: "email-worker", severity: level,
    event, ...fields
  });
  if (level === "error") console.error(payload);
  else if (level === "warn") console.warn(payload);
  else console.log(payload);
}

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

async function sha256(value: ArrayBuffer | string): Promise<string> {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  return hex(await crypto.subtle.digest("SHA-256", bytes));
}

async function hmac(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  return hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value)));
}

function safeHeader(value: string | null, pattern: RegExp): string | undefined {
  return value !== null && value.length <= 128 && pattern.test(value) ? value : undefined;
}

function contentLength(response: Response): number | undefined {
  const value = response.headers.get("content-length");
  return value !== null && /^\d{1,12}$/.test(value) ? Number(value) : undefined;
}

async function readAtMost(response: Response, maxBytes: number): Promise<string | undefined> {
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      if (!(next.value instanceof Uint8Array)) return undefined;
      const chunk = next.value;
      length += chunk.byteLength;
      if (length > maxBytes) {
        await reader.cancel();
        return undefined;
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function diagnosticResponse(response: Response) {
  const requestId = safeHeader(response.headers.get("x-request-id") ?? response.headers.get("request-id"), /^[A-Za-z0-9._:-]+$/);
  const mediaType = safeHeader(response.headers.get("content-type")?.split(";", 1)[0]?.trim() ?? null, /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/);
  return {
    ...(requestId ? { requestId } : {}),
    ...(mediaType ? { contentType: mediaType } : {}),
    ...(contentLength(response) === undefined ? {} : { bodyBytes: contentLength(response) })
  };
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type IngestStatus = "accepted" | "duplicate" | "ignored" | "unknown_recipient" | "pending_report";

interface IngestEnvelope {
  status: IngestStatus;
  correlation?: { reportId: string; traceId: string };
}

async function ingestEnvelope(response: Response): Promise<IngestEnvelope | undefined> {
  const body = await readAtMost(response, 1_024);
  if (body === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const candidate = parsed as { status?: unknown; reportId?: unknown; traceId?: unknown };
    if (!["accepted", "duplicate", "ignored", "unknown_recipient", "pending_report"].includes(String(candidate.status))) return undefined;
    const status = candidate.status as IngestStatus;
    const correlation = typeof candidate.reportId === "string" && typeof candidate.traceId === "string" &&
      UUID_PATTERN.test(candidate.reportId) && UUID_PATTERN.test(candidate.traceId)
      ? { reportId: candidate.reportId, traceId: candidate.traceId }
      : undefined;
    return { status, ...(correlation === undefined ? {} : { correlation }) };
  } catch {
    return undefined;
  }
}

async function postDiagnostic(env: Env, input: { recipient: string; messageId: string; timestamp: string; signature: string; messageIdDigest: string; rawHash: string; details: Record<string, unknown> }): Promise<void> {
  if (!env.DIAGNOSTIC_URL) return;
  try {
    await fetch(env.DIAGNOSTIC_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json", "x-dsa-recipient": input.recipient,
        "x-dsa-message-id": input.messageId, "x-dsa-timestamp": input.timestamp,
        "x-dsa-signature": input.signature, "x-dsa-raw-hash": input.rawHash
      },
      body: JSON.stringify({ event: "email_forward_failed", messageIdDigest: input.messageIdDigest, ...input.details })
    });
  } catch { /* Cloudflare runtime logs remain the fallback. */ }
}

function isDiscordEnvelopeSender(address: string): boolean {
  const normalized = address.trim().toLowerCase();
  const at = normalized.lastIndexOf("@");
  if (at <= 0 || at === normalized.length - 1) return false;
  const domain = normalized.slice(at + 1);
  return domain === "discord.com" || domain.endsWith(".discord.com");
}

export default {
  fetch(): Response {
    return new Response("Not found", { status: 404 });
  },

  async email(message: ForwardableEmailMessage, env: Env): Promise<void> {
    if (!isDiscordEnvelopeSender(message.from)) {
      workerLog("info", "email_ignored", { stage: "email_filter", outcome: "ignored", reason: "untrusted_sender" });
      return;
    }

    const recipient = message.to.trim().toLowerCase();
    const localPart = recipient.split("@", 1)[0] ?? "";
    if (!/^[a-z0-9]+(?:[.-][a-z0-9]+)*\.[0-9a-hjkmnp-tv-z]{16}$/.test(localPart)) {
      workerLog("info", "email_ignored", { stage: "email_filter", outcome: "ignored", reason: "invalid_recipient_pattern" });
      return;
    }

    const rawEmail = await new Response(message.raw).arrayBuffer();
    const rawHash = await sha256(rawEmail);
    const messageId = message.headers.get("message-id")?.trim() || `sha256:${rawHash}`;
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const signature = await hmac(
      env.INGEST_SHARED_SECRET,
      `${timestamp}\n${recipient}\n${messageId}\n${rawHash}`
    );
    const messageIdDigest = (await sha256(messageId)).slice(0, 16);
    try {
      workerLog("info", "email_forward_started", {
        stage: "email_forward", outcome: "started",
        messageIdDigest,
        recipient,
        ingestUrlConfigured:
          typeof env.INGEST_URL === "string" && env.INGEST_URL.length > 0
      });
      const response = await fetch(env.INGEST_URL, {
        method: "POST",
        headers: {
          "content-type": "message/rfc822",
          "x-dsa-recipient": recipient,
          "x-dsa-message-id": messageId,
          "x-dsa-timestamp": timestamp,
          "x-dsa-signature": signature
        },
        body: rawEmail,
        signal: AbortSignal.timeout(15_000)
      });
      if (!response.ok) {
        const diagnostic = diagnosticResponse(response);
        workerLog("error", "email_forward_failed", {
          stage: "email_forward", outcome: "failed",
          messageIdDigest,
          recipient,
          httpStatus: response.status,
          response: diagnostic,
          ...(diagnostic.requestId ? { requestId: diagnostic.requestId } : {})
        });
        await postDiagnostic(env, { recipient, messageId, timestamp, signature, messageIdDigest, rawHash, details: { httpStatus: response.status, response: diagnostic } });
        throw new Error(`Railway email ingestion returned HTTP ${response.status}.`);
      }
      const envelope = await ingestEnvelope(response);
      workerLog("info", "email_forward_completed", {
        stage: "email_forward", outcome: "accepted",
        messageIdDigest,
        recipient,
        httpStatus: response.status,
        ...(envelope?.status === undefined ? {} : { registrationStatus: envelope.status }),
        ...(envelope?.correlation ?? {})
      });
      if ((envelope?.status === "accepted" || envelope?.status === "duplicate") && envelope.correlation === undefined) {
        workerLog("warn", "email_forward_correlation_missing", {
          stage: "email_forward", outcome: "uncorrelated", messageIdDigest, recipient, httpStatus: response.status
        });
      }
    } catch (error) {
      if (!(error instanceof Error && error.message.startsWith("Railway email ingestion returned"))) {
        workerLog("error", "email_forward_failed", {
          stage: "email_forward", outcome: "failed",
          messageIdDigest,
          recipient,
          errorName: error instanceof Error ? error.name : "UnknownError"
        });
        await postDiagnostic(env, { recipient, messageId, timestamp, signature, messageIdDigest, rawHash, details: { errorName: error instanceof Error ? error.name : "UnknownError" } });
      }
      throw error;
    }
  }
} satisfies ExportedHandler<Env>;
