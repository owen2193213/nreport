const SENSITIVE_KEY = /authorization|cookie|password|secret|token|proxy|verification(?:_?code)?|^code$/i;
const MAX_RESPONSE_TEXT = 16_384;
const MAX_DIAGNOSTIC_TEXT = 65_536;

export function createTraceId(): string {
  return crypto.randomUUID();
}

function redactText(value: string, secrets: string[]): string {
  let result = value;
  for (const secret of secrets) if (secret) result = result.replaceAll(secret, "[redacted]");
  return result.length > MAX_DIAGNOSTIC_TEXT ? `${result.slice(0, MAX_DIAGNOSTIC_TEXT)}…` : result;
}

function sanitizeValue(value: unknown, secrets: string[], seen: WeakSet<object>): unknown {
  if (typeof value === "string") return redactText(value, secrets);
  if (Array.isArray(value)) {
    if (seen.has(value)) return "[circular]";
    seen.add(value);
    return value.map((item) => sanitizeValue(item, secrets, seen));
  }
  if (value && typeof value === "object") {
    if (seen.has(value)) return "[circular]";
    seen.add(value);
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [
      key, SENSITIVE_KEY.test(key) ? "[redacted]" : sanitizeValue(item, secrets, seen)
    ]));
  }
  return value;
}

export function sanitizeDiagnostic(value: unknown, secrets: string[] = []): unknown {
  return sanitizeValue(value, secrets, new WeakSet<object>());
}

export function boundedDiagnostic(value: unknown, secrets: string[] = []): unknown {
  const sanitized = sanitizeDiagnostic(value, secrets);
  const serialized = JSON.stringify(sanitized);
  if (serialized === undefined || serialized.length <= MAX_DIAGNOSTIC_TEXT) return sanitized;
  return { truncated: true, preview: serialized.slice(0, MAX_DIAGNOSTIC_TEXT - 64) };
}

export interface DiagnosticResponse { contentType: string | null; requestId?: string; body?: unknown; bodyTruncated: boolean; }

export async function readDiagnosticResponse(response: Response, secrets: string[] = []): Promise<DiagnosticResponse> {
  const reader = response.body?.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  let bodyTruncated = false;
  if (reader !== undefined) {
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        length += next.value.byteLength;
        if (length > MAX_RESPONSE_TEXT) { bodyTruncated = true; await reader.cancel(); break; }
        chunks.push(next.value);
      }
    } finally { reader.releaseLock(); }
  }
  const requestId = response.headers.get("x-request-id") ?? response.headers.get("request-id") ?? undefined;
  const metadata = {
    contentType: response.headers.get("content-type"),
    ...(requestId ? { requestId } : {}),
    bodyTruncated
  };
  if (bodyTruncated) return metadata;
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  const bounded = new TextDecoder().decode(bytes);
  let body: unknown = bounded;
  try { body = JSON.parse(bounded); } catch { /* plain text is valid diagnostics */ }
  return { ...metadata, body: sanitizeDiagnostic(body, secrets) };
}
