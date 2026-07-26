interface Env {
  INGEST_URL: string;
  INGEST_SHARED_SECRET: string;
}

const DISCORD_VERIFICATION_ENVELOPE_SENDER =
  /^[^@\s]+@(?:[a-z0-9-]+\.)*discord\.com$/i;

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

export default {
  fetch(): Response {
    return new Response("Not found", { status: 404 });
  },

  async email(message: ForwardableEmailMessage, env: Env): Promise<void> {
    const sender = message.from.trim().toLowerCase();
    if (!DISCORD_VERIFICATION_ENVELOPE_SENDER.test(sender)) {
      console.log(JSON.stringify({
        event: "email_ignored",
        reason: "untrusted_sender"
      }));
      return;
    }

    const recipient = message.to.trim().toLowerCase();
    const localPart = recipient.split("@", 1)[0] ?? "";
    if (!/^[a-z0-9]+(?:[.-][a-z0-9]+)*\.[0-9a-hjkmnp-tv-z]{16}$/.test(localPart)) {
      console.log(JSON.stringify({
        event: "email_ignored",
        reason: "invalid_recipient_pattern"
      }));
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
      console.log(JSON.stringify({
        event: "email_forward_started",
        messageIdDigest,
        ingestUrlConfigured:
          typeof env.INGEST_URL === "string" && env.INGEST_URL.length > 0
      }));
      const response = await fetch(env.INGEST_URL, {
        method: "POST",
        headers: {
          "content-type": "message/rfc822",
          "x-dsa-recipient": recipient,
          "x-dsa-message-id": messageId,
          "x-dsa-timestamp": timestamp,
          "x-dsa-signature": signature
        },
        body: rawEmail
      });
      if (!response.ok) {
        console.error(JSON.stringify({
          event: "email_forward_failed",
          messageIdDigest,
          httpStatus: response.status
        }));
        throw new Error(`Railway email ingestion returned HTTP ${response.status}.`);
      }
      console.log(JSON.stringify({
        event: "email_forward_completed",
        messageIdDigest,
        httpStatus: response.status
      }));
    } catch (error) {
      if (!(error instanceof Error && error.message.startsWith("Railway email ingestion returned"))) {
        console.error(JSON.stringify({
          event: "email_forward_failed",
          messageIdDigest,
          errorName: error instanceof Error ? error.name : "UnknownError"
        }));
      }
      throw error;
    }
  }
} satisfies ExportedHandler<Env>;
