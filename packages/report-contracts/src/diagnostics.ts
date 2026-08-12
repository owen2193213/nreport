const SENSITIVE_KEY = /authorization|cookie|password|secret|token|proxy|verification|code/i;
const MAX_TEXT = 16_384;

export function createTraceId(): string {
  return crypto.randomUUID();
}

function redactText(value: string, secrets: string[]): string {
  let result = value;
  for (const secret of secrets) if (secret) result = result.replaceAll(secret, "[redacted]");
  return result.length > MAX_TEXT ? `${result.slice(0, MAX_TEXT)}…` : result;
}

export function sanitizeDiagnostic(value: unknown, secrets: string[] = []): unknown {
  if (typeof value === "string") return redactText(value, secrets);
  if (Array.isArray(value)) return value.map((item) => sanitizeDiagnostic(item, secrets));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [
      key, SENSITIVE_KEY.test(key) ? "[redacted]" : sanitizeDiagnostic(item, secrets)
    ]));
  }
  return value;
}

export interface DiagnosticResponse { contentType: string | null; requestId?: string; body?: unknown; bodyTruncated: boolean; }

export async function readDiagnosticResponse(response: Response, secrets: string[] = []): Promise<DiagnosticResponse> {
  const text = await response.text();
  const bodyTruncated = text.length > MAX_TEXT;
  const bounded = text.slice(0, MAX_TEXT);
  let body: unknown = bounded;
  try { body = JSON.parse(bounded); } catch { /* plain text is valid diagnostics */ }
  const requestId = response.headers.get("x-request-id") ?? response.headers.get("request-id") ?? undefined;
  return { contentType: response.headers.get("content-type"), ...(requestId ? { requestId } : {}), body: sanitizeDiagnostic(body, secrets), bodyTruncated };
}
