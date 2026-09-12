import { isIP } from "node:net";
import { randomUUID } from "node:crypto";

import type { Pool } from "pg";

import { encryptJson } from "./security.js";

const MANAGED_DEFAULT_DESTINATION_NAME = "NReport bot";

export interface WebhookDestinationView {
  destinationId: string;
  name: string;
  url: string;
  status: "active" | "disabled";
  createdAt: string;
}

export class WebhookDestinationError extends Error {
  public readonly statusCode = 400;
  public readonly code = "invalid_webhook_destination";

  public constructor(message: string) {
    super(message);
    this.name = "WebhookDestinationError";
  }
}

export function validateWebhookUrl(value: string, allowRailwayPrivateHttp: boolean): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new WebhookDestinationError("Webhook URL is invalid.");
  }
  if (url.username || url.password || url.hash) throw new WebhookDestinationError("Webhook URL cannot contain credentials or a fragment.");
  const hostname = url.hostname.toLowerCase();
  const railwayPrivate = allowRailwayPrivateHttp && url.protocol === "http:" && hostname.endsWith(".railway.internal");
  if (url.protocol !== "https:" && !railwayPrivate) throw new WebhookDestinationError("Webhook URL must use public HTTPS.");
  if (!railwayPrivate && isPrivateHost(hostname)) throw new WebhookDestinationError("Webhook URL must not target a private host.");
  return url;
}

export class WebhookDestinationRepository {
  public constructor(
    private readonly pool: Pick<Pool, "query">,
    private readonly encryptionKey: Buffer,
    private readonly allowRailwayPrivateHttp: boolean
  ) {}

  public async create(name: string, urlValue: string, signingSecret: string): Promise<WebhookDestinationView> {
    const normalizedName = name.trim();
    if (normalizedName.length < 2 || normalizedName.length > 100) throw new WebhookDestinationError("Destination name must be 2-100 characters.");
    if (signingSecret.length < 32) throw new WebhookDestinationError("Webhook signing secret must contain at least 32 characters.");
    const url = validateWebhookUrl(urlValue, this.allowRailwayPrivateHttp);
    const id = randomUUID();
    const result = await this.pool.query<{
      id: string; name: string; url: string; status: "active" | "disabled"; created_at: Date;
    }>(
      `INSERT INTO webhook_destinations (id, name, url, encrypted_signing_secret)
       VALUES ($1, $2, $3, $4) RETURNING id, name, url, status, created_at`,
      [id, normalizedName, url.toString(), encryptJson(signingSecret, this.encryptionKey)]
    );
    const row = result.rows[0];
    if (row === undefined) throw new Error("Destination insert did not return a row.");
    await this.pool.query(
      `INSERT INTO admin_audit_log (action, reason, details)
       VALUES ('webhook_destination_created', 'Administrator created webhook destination', $1)`,
      [{ destinationId: id, name: normalizedName }]
    );
    return destinationView(row);
  }

  public async configureManagedDefault(
    urlValue: string,
    signingSecret: string
  ): Promise<{ destinationId: string; assignedAccountCount: number }> {
    if (signingSecret.length < 32) throw new WebhookDestinationError("Webhook signing secret must contain at least 32 characters.");
    const url = validateWebhookUrl(urlValue, this.allowRailwayPrivateHttp);
    const destination = await this.pool.query<{ id: string }>(
      `INSERT INTO webhook_destinations (id, name, url, encrypted_signing_secret)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (name) DO UPDATE
       SET url = EXCLUDED.url, encrypted_signing_secret = EXCLUDED.encrypted_signing_secret,
           status = 'active', updated_at = now()
       RETURNING id`,
      [randomUUID(), MANAGED_DEFAULT_DESTINATION_NAME, url.toString(), encryptJson(signingSecret, this.encryptionKey)]
    );
    const destinationId = destination.rows[0]?.id;
    if (destinationId === undefined) throw new Error("Managed webhook destination was not returned.");
    const assigned = await this.pool.query(
      `UPDATE api_accounts
       SET webhook_destination_id = $1, updated_at = now()
       WHERE webhook_destination_id IS NULL AND status = 'active'`,
      [destinationId]
    );
    return { destinationId, assignedAccountCount: assigned.rowCount ?? 0 };
  }

  public async list(): Promise<WebhookDestinationView[]> {
    const result = await this.pool.query<{
      id: string; name: string; url: string; status: "active" | "disabled"; created_at: Date;
    }>("SELECT id, name, url, status, created_at FROM webhook_destinations ORDER BY name, id");
    return result.rows.map(destinationView);
  }

  public async update(
    destinationId: string,
    input: { name?: string; url?: string; signingSecret?: string; status?: "active" | "disabled" }
  ): Promise<WebhookDestinationView | null> {
    if (input.name !== undefined && (input.name.trim().length < 2 || input.name.length > 100)) throw new WebhookDestinationError("Destination name must be 2-100 characters.");
    const url = input.url === undefined ? undefined : validateWebhookUrl(input.url, this.allowRailwayPrivateHttp).toString();
    if (input.signingSecret !== undefined && input.signingSecret.length < 32) throw new WebhookDestinationError("Webhook signing secret must contain at least 32 characters.");
    const result = await this.pool.query<{
      id: string; name: string; url: string; status: "active" | "disabled"; created_at: Date;
    }>(
      `UPDATE webhook_destinations
       SET name = COALESCE($2, name), url = COALESCE($3, url),
           encrypted_signing_secret = COALESCE($4, encrypted_signing_secret),
           status = COALESCE($5, status), updated_at = now()
       WHERE id = $1 RETURNING id, name, url, status, created_at`,
      [
        destinationId, input.name?.trim() ?? null, url ?? null,
        input.signingSecret === undefined ? null : encryptJson(input.signingSecret, this.encryptionKey),
        input.status ?? null
      ]
    );
    const row = result.rows[0];
    if (row !== undefined) {
      await this.pool.query(
        `INSERT INTO admin_audit_log (action, reason, details)
         VALUES ('webhook_destination_updated', 'Administrator updated webhook destination', $1)`,
        [{ destinationId }]
      );
    }
    return row === undefined ? null : destinationView(row);
  }

  public async assign(accountId: string, destinationId: string | null): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE api_accounts SET webhook_destination_id = $2, updated_at = now()
       WHERE id = $1 AND ($2::uuid IS NULL OR EXISTS (
         SELECT 1 FROM webhook_destinations WHERE id = $2 AND status = 'active'
       )) RETURNING id`,
      [accountId, destinationId]
    );
    if (result.rowCount === 1) {
      await this.pool.query(
        `INSERT INTO admin_audit_log (action, account_id, reason, details)
         VALUES ('webhook_destination_assigned', $1, 'Administrator changed account webhook destination', $2)`,
        [accountId, { destinationId }]
      );
    }
    return result.rowCount === 1;
  }
}

function isPrivateHost(hostname: string): boolean {
  if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local") || hostname.endsWith(".internal")) return true;
  if (isIP(hostname) === 4) {
    const [a = 0, b = 0] = hostname.split(".").map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  if (isIP(hostname) === 6) return hostname === "::1" || hostname.startsWith("fc") || hostname.startsWith("fd") || hostname.startsWith("fe8") || hostname.startsWith("fe9") || hostname.startsWith("fea") || hostname.startsWith("feb");
  return false;
}

function destinationView(row: {
  id: string; name: string; url: string; status: "active" | "disabled"; created_at: Date;
}): WebhookDestinationView {
  return {
    destinationId: row.id,
    name: row.name,
    url: row.url,
    status: row.status,
    createdAt: row.created_at.toISOString()
  };
}
