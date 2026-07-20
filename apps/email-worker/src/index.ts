interface Env {
  INGEST_URL: string;
  INGEST_SHARED_SECRET: string;
}

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

async function sha256(value: ArrayBuffer): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", value));
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
  async email(message: ForwardableEmailMessage, env: Env): Promise<void> {
    const recipient = message.to.trim().toLowerCase();
    const localPart = recipient.split("@", 1)[0] ?? "";
    if (!/^[a-z0-9]+(?:[.-][a-z0-9]+)*\.[0-9a-hjkmnp-tv-z]{16}$/.test(localPart)) {
      message.setReject("Unknown recipient");
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
      throw new Error(`Railway email ingestion returned HTTP ${response.status}.`);
    }
  }
} satisfies ExportedHandler<Env>;
