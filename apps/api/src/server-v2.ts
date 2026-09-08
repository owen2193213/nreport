import {
  adminCreateAccountBodySchema,
  apiAccountSchema,
  assignWebhookDestinationBodySchema,
  auditReasonBodySchema,
  createReportBodySchema,
  createWebhookDestinationBodySchema,
  creditAdjustmentBodySchema,
  DSA_ADMIN_BASE_PATH,
  DSA_API_BASE_PATH,
  errorEnvelopeSchema,
  GUILD_ELEMENTS,
  GUILD_REPORT_REASONS,
  PROFILE_ELEMENTS,
  keyRotationBodySchema,
  NREPORT_DISCORD_DSA_SERVICE,
  reportLifecycleEventSchema,
  retryReportBodySchema,
  updateWebhookDestinationBodySchema,
  USER_MESSAGE_REPORT_REASONS
} from "@nreport/contracts";
import { createHash } from "node:crypto";
import type { AdminCreateAccountInput, ApiAccountView, CreateReportInput, PublicReportTarget, ReportDetail, ReportTarget, RetryReportInput } from "@nreport/contracts";
import rateLimit from "@fastify/rate-limit";
import Fastify from "fastify";
import type { FastifyReply, FastifyRequest } from "fastify";

import type { AccountPrincipal } from "./accounts.js";
import type { AppConfig } from "./config.js";
import { reportRetryableModes, type AccountReportRow, type ReportRepository } from "./report-repository.js";
import { inspectDiscordEmail } from "./email.js";
import { encryptJson, safeEqual, sha256Hex, verifyInboundSignature } from "./security.js";
import { parseCreateReportInput, parseRetryReportInput } from "./validation.js";
import { supportedCountries } from "./pseudonyms.js";
import type { WebhookDestinationRepository } from "./webhook-destinations.js";
import type { AnalyticsRepository } from "./analytics-repository.js";
import { resolveAnalyticsInterval } from "./analytics.js";
import type { AnalyticsInterval, AnalyticsPeriod } from "@nreport/contracts";

interface AccountStore {
  authenticate(key: string): Promise<AccountPrincipal | null>;
  consumeReadRateLimit?(accountId: string): Promise<void>;
  accountView(principal: AccountPrincipal): Promise<ApiAccountView>;
  createAccount(input: AdminCreateAccountInput): Promise<unknown>;
  adminAccount(accountId: string): Promise<unknown>;
  listAccounts(): Promise<unknown[]>;
  issueKey(accountId: string): Promise<{ keyId: string; prefix: string; plaintext: string }>;
  rotateKey(accountId: string, overlapSeconds?: number): Promise<{ keyId: string; prefix: string; plaintext: string }>;
  listKeys(accountId: string): Promise<unknown[]>;
  revokeKey(accountId: string, keyId: string, reason: string): Promise<boolean>;
  adjustCredits(accountId: string, delta: number, reason: string): Promise<number>;
  setAccountStatus(accountId: string, status: "active" | "suspended", reason: string): Promise<unknown>;
  globalUsage(): Promise<unknown>;
}

interface V2Dependencies {
  healthcheck(): Promise<void>;
  accounts: AccountStore;
  reports: Pick<ReportRepository,
    "create" | "findOwned" | "listOwned" | "timeline" | "listEvents" | "retry" |
    "registerVerificationEmail" | "registerReportUpdateEmail" | "registerReviewUpdateEmail" | "operationalDiagnostics"
  > & { queueLength?: () => Promise<number> };
  destinations?: Pick<WebhookDestinationRepository, "create" | "list" | "update" | "assign">;
  analytics?: Pick<AnalyticsRepository, "analytics" | "actionHistory" | "digest">;
}

type AuthenticatedRequest = FastifyRequest & { accountPrincipal?: AccountPrincipal };
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const accountIdParameter = { in: "path", name: "accountId", required: true, schema: { type: "string", format: "uuid" } } as const;
const reportIdParameter = { in: "path", name: "reportId", required: true, schema: { type: "string", format: "uuid" } } as const;
const keyIdParameter = { in: "path", name: "keyId", required: true, schema: { type: "string", format: "uuid" } } as const;
const destinationIdParameter = { in: "path", name: "destinationId", required: true, schema: { type: "string", format: "uuid" } } as const;
const idempotencyKeyParameter = { in: "header", name: "Idempotency-Key", required: true, schema: { type: "string", minLength: 8, maxLength: 200 } } as const;

function bearer(request: FastifyRequest): string | null {
  const value = request.headers.authorization;
  return typeof value === "string" && value.startsWith("Bearer ") ? value.slice(7) : null;
}

function apiError(reply: FastifyReply, request: FastifyRequest, status: number, code: string, message: string) {
  return reply.code(status).send({ error: { code, message, requestId: request.id } });
}

function publicReport(row: AccountReportRow, queueLength = 0): ReportDetail {
  const prepared = row.prepared_input as {
    country?: string;
    category?: string;
    description?: string;
    finalText?: string;
  } | null;
  return {
    reportId: row.id,
    accountId: row.account_id,
    flow: row.flow,
    useAi: row.use_ai,
    status: row.status,
    creditState: row.credit_state ?? "reserved",
    lifecycleAttempt: row.lifecycle_attempt ?? 1,
    country: prepared?.country ?? null,
    category: prepared?.category ?? null,
    description: prepared?.description ?? null,
    target: sanitizeTarget(row.request_input.target),
    finalText: prepared?.finalText ?? null,
    legalReference: row.legal_reference ?? null,
    researchSummary: row.research_summary ?? null,
    sources: (row.research_sources ?? []) as ReportDetail["sources"],
    discordReportId: row.discord_report_id ?? null,
    discordStatus: row.discord_status ?? null,
    reviewStatus: row.review_status ?? null,
    failure:
      typeof row.error_code === "string"
        ? {
            stage: row.failure_stage ?? "unknown",
            code: row.error_code,
            message: row.error_message ?? "Report failed."
          }
        : null,
    predecessorReportId: row.predecessor_report_id ?? null,
    successorReportId: row.successor_report_id ?? null,
    retryableModes: reportRetryableModes(row),
    queueLength,
    timeline: [],
    createdAt: row.created_at?.toISOString?.() ?? new Date().toISOString(),
    updatedAt: row.updated_at?.toISOString?.() ?? new Date().toISOString()
  };
}

const openApiDocument = {
  openapi: "3.1.0",
  info: { title: "NReport API", version: "1.0.0" },
  tags: [
    { name: "Discord / DSA / Account" },
    { name: "Discord / DSA / Reports" },
    { name: "Discord / DSA / Analytics" },
    { name: "Administration / Discord / DSA" }
  ],
  components: {
    securitySchemes: {
      personalApiKey: { type: "http", scheme: "bearer" },
      administratorKey: { type: "http", scheme: "bearer" }
    },
    schemas: {
      CreateReportInput: createReportBodySchema,
      RetryReportInput: retryReportBodySchema,
      ApiAccount: apiAccountSchema,
      ApiError: errorEnvelopeSchema,
      ReportLifecycleEvent: reportLifecycleEventSchema,
      AdminCreateAccountInput: adminCreateAccountBodySchema,
      KeyRotationInput: keyRotationBodySchema,
      AuditReasonInput: auditReasonBodySchema,
      CreditAdjustmentInput: creditAdjustmentBodySchema,
      CreateWebhookDestinationInput: createWebhookDestinationBodySchema,
      UpdateWebhookDestinationInput: updateWebhookDestinationBodySchema,
      AssignWebhookDestinationInput: assignWebhookDestinationBodySchema
    }
  },
  paths: {
    [`${DSA_API_BASE_PATH}/account`]: { get: { tags: ["Discord / DSA / Account"], security: [{ personalApiKey: [] }], responses: { "200": { description: "Account" } } } },
    [`${DSA_API_BASE_PATH}/catalog`]: { get: { tags: ["Discord / DSA / Account"], security: [{ personalApiKey: [] }], responses: { "200": { description: "Catalog" } } } },
    [`${DSA_API_BASE_PATH}/reports`]: {
      get: { security: [{ personalApiKey: [] }], responses: { "200": { description: "Account report history" } } },
      post: {
        security: [{ personalApiKey: [] }],
        parameters: [idempotencyKeyParameter],
        requestBody: { required: true, content: { "application/json": { schema: createReportBodySchema } } },
        responses: { "202": { description: "Queued report" } }
      }
    },
    [`${DSA_API_BASE_PATH}/reports/{reportId}`]: { get: { tags: ["Discord / DSA / Reports"], security: [{ personalApiKey: [] }], parameters: [reportIdParameter], responses: { "200": { description: "Owned report" }, "404": { description: "Not found" } } } },
    [`${DSA_API_BASE_PATH}/reports/{reportId}/retries`]: { post: { tags: ["Discord / DSA / Reports"], security: [{ personalApiKey: [] }], parameters: [reportIdParameter, idempotencyKeyParameter], requestBody: { required: true, content: { "application/json": { schema: retryReportBodySchema } } }, responses: { "202": { description: "Queued retry" } } } },
    [`${DSA_API_BASE_PATH}/events`]: { get: { tags: ["Discord / DSA / Reports"], security: [{ personalApiKey: [] }], responses: { "200": { description: "Replayable account event feed" } } } },
    [`${DSA_API_BASE_PATH}/analytics`]: { get: { tags: ["Discord / DSA / Analytics"], security: [{ personalApiKey: [] }], responses: { "200": { description: "Personal analytics" } } } },
    [`${DSA_API_BASE_PATH}/analytics/community`]: { get: { tags: ["Discord / DSA / Analytics"], security: [{ personalApiKey: [] }], responses: { "200": { description: "Anonymized community analytics" } } } },
    [`${DSA_API_BASE_PATH}/action-history`]: { get: { tags: ["Discord / DSA / Analytics"], security: [{ personalApiKey: [] }], responses: { "200": { description: "Personal action history" } } } },
    [`${DSA_API_BASE_PATH}/digest-activity`]: { get: { tags: ["Discord / DSA / Analytics"], security: [{ personalApiKey: [] }], responses: { "200": { description: "Personal digest activity" } } } },
    [`${DSA_ADMIN_BASE_PATH}/accounts`]: {
      get: { security: [{ administratorKey: [] }], responses: { "200": { description: "Accounts" } } },
      post: { security: [{ administratorKey: [] }], requestBody: jsonRequest(adminCreateAccountBodySchema), responses: { "201": { description: "Created account" } } }
    },
    [`${DSA_ADMIN_BASE_PATH}/accounts/{accountId}`]: { get: { security: [{ administratorKey: [] }], parameters: [accountIdParameter], responses: { "200": { description: "Account" }, "404": { description: "Not found" } } } },
    [`${DSA_ADMIN_BASE_PATH}/accounts/{accountId}/keys`]: {
      get: { security: [{ administratorKey: [] }], parameters: [accountIdParameter], responses: { "200": { description: "Keys without plaintext secrets" } } },
      post: { security: [{ administratorKey: [] }], parameters: [accountIdParameter], responses: { "201": { description: "One-time plaintext key" } } }
    },
    [`${DSA_ADMIN_BASE_PATH}/accounts/{accountId}/keys/rotate`]: { post: { security: [{ administratorKey: [] }], parameters: [accountIdParameter], requestBody: jsonRequest(keyRotationBodySchema), responses: { "201": { description: "Rotated one-time plaintext key" } } } },
    [`${DSA_ADMIN_BASE_PATH}/accounts/{accountId}/keys/{keyId}`]: { delete: { security: [{ administratorKey: [] }], parameters: [accountIdParameter, keyIdParameter], requestBody: jsonRequest(auditReasonBodySchema), responses: { "204": { description: "Revoked" } } } },
    [`${DSA_ADMIN_BASE_PATH}/accounts/{accountId}/credits`]: { post: { security: [{ administratorKey: [] }], parameters: [accountIdParameter], requestBody: jsonRequest(creditAdjustmentBodySchema), responses: { "200": { description: "Adjusted account" } } } },
    [`${DSA_ADMIN_BASE_PATH}/accounts/{accountId}/suspend`]: { post: { security: [{ administratorKey: [] }], parameters: [accountIdParameter], requestBody: jsonRequest(auditReasonBodySchema), responses: { "200": { description: "Suspended account" } } } },
    [`${DSA_ADMIN_BASE_PATH}/accounts/{accountId}/reinstate`]: { post: { security: [{ administratorKey: [] }], parameters: [accountIdParameter], requestBody: jsonRequest(auditReasonBodySchema), responses: { "200": { description: "Reinstated account" } } } },
    [`${DSA_ADMIN_BASE_PATH}/accounts/{accountId}/webhook-destination`]: { put: { security: [{ administratorKey: [] }], parameters: [accountIdParameter], requestBody: jsonRequest(assignWebhookDestinationBodySchema), responses: { "204": { description: "Assignment updated" } } } },
    [`${DSA_ADMIN_BASE_PATH}/usage`]: { get: { security: [{ administratorKey: [] }], responses: { "200": { description: "Global account usage" } } } },
    [`${DSA_ADMIN_BASE_PATH}/diagnostics`]: { get: { security: [{ administratorKey: [] }], responses: { "200": { description: "Operational diagnostics" } } } },
    [`${DSA_ADMIN_BASE_PATH}/webhook-destinations`]: {
      get: { security: [{ administratorKey: [] }], responses: { "200": { description: "Webhook destinations" } } },
      post: { security: [{ administratorKey: [] }], requestBody: jsonRequest(createWebhookDestinationBodySchema), responses: { "201": { description: "Created destination" } } }
    },
    [`${DSA_ADMIN_BASE_PATH}/webhook-destinations/{destinationId}`]: { patch: { security: [{ administratorKey: [] }], parameters: [destinationIdParameter], requestBody: jsonRequest(updateWebhookDestinationBodySchema), responses: { "200": { description: "Updated destination" } } } }
  }
} as const;

function jsonRequest(schema: object) {
  return { required: true, content: { "application/json": { schema } } };
}

export async function buildV2Server(config: AppConfig, dependencies: V2Dependencies) {
  const app = Fastify({
    bodyLimit: 1_048_576,
    logger: {
      level: config.environment === "production" ? "info" : "warn",
      redact: { paths: ["req.headers.authorization", "request.headers.authorization"], censor: "[REDACTED]" }
    }
  });
  await app.register(rateLimit, {
    global: true,
    max: 120,
    timeWindow: "1 minute",
    errorResponseBuilder: (request) => ({
      error: {
        code: "rate_limited",
        message: "Request rate limit exceeded.",
        requestId: request.id
      }
    }),
    keyGenerator: (request) => {
      const authorization = request.headers.authorization;
      return typeof authorization === "string"
        ? createHash("sha256").update(authorization).digest("hex")
        : request.ip;
    }
  });
  app.addContentTypeParser("message/rfc822", { parseAs: "buffer" }, (_request, body, done) => done(null, body));

  const accountAuth = async (request: FastifyRequest, reply: FastifyReply) => {
    const key = bearer(request);
    const principal = key === null ? null : await dependencies.accounts.authenticate(key);
    if (principal === null) {
      await apiError(reply, request, 401, "unauthorized", "Unauthorized.");
      return;
    }
    if (request.method === "GET" && dependencies.accounts.consumeReadRateLimit !== undefined) {
      try {
        await dependencies.accounts.consumeReadRateLimit(principal.accountId);
      } catch (error) {
        if (typeof error === "object" && error !== null && (error as { code?: unknown }).code === "rate_limited") {
          reply.header("Retry-After", "60");
          await apiError(reply, request, 429, "rate_limited", "Account read rate limit exceeded.");
          return;
        }
        throw error;
      }
    }
    (request as AuthenticatedRequest).accountPrincipal = principal;
  };
  const adminAuth = async (request: FastifyRequest, reply: FastifyReply) => {
    const key = bearer(request);
    if (key === null || !safeEqual(key, config.adminApiKey)) {
      await apiError(reply, request, 401, "unauthorized", "Unauthorized.");
      return;
    }
  };

  app.get("/healthz", async (_request, reply) => {
    await dependencies.healthcheck();
    return reply.send({ status: "ok" });
  });
  app.get("/openapi.json", async (_request, reply) => reply.send(openApiDocument));
  app.get(`${DSA_API_BASE_PATH}/account`, { preHandler: accountAuth }, async (request, reply) => {
    const principal = (request as AuthenticatedRequest).accountPrincipal;
    if (principal === undefined) return;
    return reply.send(await dependencies.accounts.accountView(principal));
  });
  app.get(`${DSA_API_BASE_PATH}/catalog`, { preHandler: accountAuth }, async (_request, reply) =>
    reply.send({
      service: NREPORT_DISCORD_DSA_SERVICE,
      countries: supportedCountries(),
      categories: { message: USER_MESSAGE_REPORT_REASONS, profile: USER_MESSAGE_REPORT_REASONS, server: GUILD_REPORT_REASONS },
      elements: { profile: PROFILE_ELEMENTS, server: GUILD_ELEMENTS }
    })
  );
  app.post(
    `${DSA_API_BASE_PATH}/reports`,
    {
      preHandler: accountAuth,
      config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
      schema: { body: createReportBodySchema }
    },
    async (request, reply) => {
      const principal = (request as AuthenticatedRequest).accountPrincipal;
      if (principal === undefined) return;
      const idempotencyKey = request.headers["idempotency-key"];
      if (typeof idempotencyKey !== "string" || idempotencyKey.trim().length < 8 || idempotencyKey.length > 200) {
        return apiError(reply, request, 400, "invalid_idempotency_key", "Idempotency-Key must contain between 8 and 200 characters.");
      }
      let input: CreateReportInput;
      try {
        input = parseCreateReportInput(request.body);
      } catch (error) {
        return apiError(reply, request, 400, "invalid_request", error instanceof Error ? error.message : "Invalid report request.");
      }
      try {
        const result = await dependencies.reports.create(principal.accountId, idempotencyKey.trim(), input);
        return reply.code(202).send(publicReport(result.report, await dependencies.reports.queueLength?.() ?? 0));
      } catch (error) {
        const code = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
        const message = error instanceof Error ? error.message : "Report creation failed.";
        if (code === "credits_exhausted") return apiError(reply, request, 402, code, message);
        if (code === "account_suspended") return apiError(reply, request, 403, code, message);
        if (code === "idempotency_conflict") return apiError(reply, request, 409, code, message);
        if (code === "rate_limited") {
          reply.header("Retry-After", "60");
          return apiError(reply, request, 429, code, message);
        }
        throw error;
      }
    }
  );
  app.get<{ Params: { reportId: string } }>(
    `${DSA_API_BASE_PATH}/reports/:reportId`,
    { preHandler: accountAuth },
    async (request, reply) => {
      const principal = (request as AuthenticatedRequest).accountPrincipal;
      if (principal === undefined) return;
      if (!UUID_PATTERN.test(request.params.reportId)) {
        return apiError(reply, request, 404, "report_not_found", "Report was not found.");
      }
      const row = await dependencies.reports.findOwned(principal.accountId, request.params.reportId);
      if (row === null) {
        return apiError(reply, request, 404, "report_not_found", "Report was not found.");
      }
      const detail = publicReport(row, await dependencies.reports.queueLength?.() ?? 0);
      detail.timeline = await dependencies.reports.timeline(principal.accountId, row.id);
      return reply.send(detail);
    }
  );
  app.get<{ Querystring: { after?: string; limit?: string } }>(
    `${DSA_API_BASE_PATH}/reports`,
    { preHandler: accountAuth },
    async (request, reply) => {
      const principal = (request as AuthenticatedRequest).accountPrincipal;
      if (principal === undefined) return;
      const limit = request.query.limit === undefined ? 50 : Number(request.query.limit);
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
        return apiError(reply, request, 400, "invalid_cursor", "Report cursor or limit is invalid.");
      }
      try {
        const page = await dependencies.reports.listOwned(principal.accountId, request.query.after ?? null, limit);
        return reply.send({ items: page.rows.map(publicReportSummary), next: page.next });
      } catch (error) {
        if (typeof error === "object" && error !== null && (error as { code?: unknown }).code === "invalid_cursor") {
          return apiError(reply, request, 400, "invalid_cursor", "Report cursor is invalid.");
        }
        throw error;
      }
    }
  );
  app.get<{ Querystring: { after?: string; limit?: string } }>(
    `${DSA_API_BASE_PATH}/events`,
    { preHandler: accountAuth },
    async (request, reply) => {
      const principal = (request as AuthenticatedRequest).accountPrincipal;
      if (principal === undefined) return;
      const after = request.query.after ?? null;
      const limit = request.query.limit === undefined ? 50 : Number(request.query.limit);
      if ((after !== null && !/^\d+$/.test(after)) || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
        return apiError(reply, request, 400, "invalid_cursor", "Event cursor or limit is invalid.");
      }
      return reply.send(await dependencies.reports.listEvents(principal.accountId, after, limit));
    }
  );
  app.post<{ Params: { reportId: string }; Body: RetryReportInput }>(
    `${DSA_API_BASE_PATH}/reports/:reportId/retries`,
    {
      preHandler: accountAuth,
      config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
      schema: { body: retryReportBodySchema }
    },
    async (request, reply) => {
      const principal = (request as AuthenticatedRequest).accountPrincipal;
      if (principal === undefined) return;
      if (!UUID_PATTERN.test(request.params.reportId)) {
        return apiError(reply, request, 404, "report_not_found", "Report was not found.");
      }
      const idempotencyKey = request.headers["idempotency-key"];
      if (typeof idempotencyKey !== "string" || idempotencyKey.trim().length < 8 || idempotencyKey.length > 200) {
        return apiError(reply, request, 400, "invalid_idempotency_key", "Idempotency-Key must contain between 8 and 200 characters.");
      }
      let retryInput: RetryReportInput;
      try { retryInput = parseRetryReportInput(request.body); }
      catch (error) { return apiError(reply, request, 400, "invalid_request", error instanceof Error ? error.message : "Retry input is invalid."); }
      try {
        const result = await dependencies.reports.retry(
          principal.accountId,
          request.params.reportId,
          idempotencyKey.trim(),
          retryInput
        );
        return reply.code(202).send(publicReport(result.report, await dependencies.reports.queueLength?.() ?? 0));
      } catch (error) {
        const code = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
        const message = error instanceof Error ? error.message : "Report retry failed.";
        if (code === "report_not_found" || code === "account_not_found") return apiError(reply, request, 404, "report_not_found", "Report was not found.");
        if (code === "credits_exhausted") return apiError(reply, request, 402, code, message);
        if (code === "account_suspended") return apiError(reply, request, 403, code, message);
        if (code === "rate_limited") {
          reply.header("Retry-After", retryInput.mode === "regenerate" || retryInput.mode === "rewrite_ai" ? "3600" : "60");
          return apiError(reply, request, 429, code, message);
        }
        if (code === "idempotency_conflict" || code === "invalid_retry" || code === "retry_cooldown") {
          return apiError(reply, request, 409, String(code), message);
        }
        throw error;
      }
    }
  );
  app.post(`${DSA_ADMIN_BASE_PATH}/accounts`, { preHandler: adminAuth, schema: { body: adminCreateAccountBodySchema } }, async (request, reply) => {
    const body = request.body as Partial<AdminCreateAccountInput>;
    if (typeof body?.username !== "string") {
      return apiError(reply, request, 400, "invalid_request", "Username is required.");
    }
    const created = await dependencies.accounts.createAccount({
      username: body.username,
      ...(typeof body.initialCredits === "number" ? { initialCredits: body.initialCredits } : {}),
      ...(typeof body.webhookDestinationId === "string" ? { webhookDestinationId: body.webhookDestinationId } : {})
    });
    return reply.code(201).send(created);
  });
  app.get(`${DSA_ADMIN_BASE_PATH}/accounts`, { preHandler: adminAuth }, async (_request, reply) =>
    reply.send({ items: await dependencies.accounts.listAccounts() })
  );
  app.get(`${DSA_ADMIN_BASE_PATH}/usage`, { preHandler: adminAuth }, async (_request, reply) =>
    reply.send(await dependencies.accounts.globalUsage())
  );
  app.get(`${DSA_ADMIN_BASE_PATH}/diagnostics`, { preHandler: adminAuth }, async (_request, reply) =>
    reply.send(await dependencies.reports.operationalDiagnostics())
  );
  app.get<{ Params: { accountId: string } }>(`${DSA_ADMIN_BASE_PATH}/accounts/:accountId`, { preHandler: adminAuth }, async (request, reply) => {
    if (!UUID_PATTERN.test(request.params.accountId)) return apiError(reply, request, 404, "account_not_found", "Account was not found.");
    const account = await dependencies.accounts.adminAccount(request.params.accountId);
    return account === null ? apiError(reply, request, 404, "account_not_found", "Account was not found.") : reply.send(account);
  });
  app.post<{ Params: { accountId: string } }>(`${DSA_ADMIN_BASE_PATH}/accounts/:accountId/keys`, { preHandler: adminAuth }, async (request, reply) => {
    if (!UUID_PATTERN.test(request.params.accountId)) return apiError(reply, request, 404, "account_not_found", "Account was not found.");
    const issued = await dependencies.accounts.issueKey(request.params.accountId);
    return reply.code(201).send({ keyId: issued.keyId, prefix: issued.prefix, apiKey: issued.plaintext });
  });
  app.get<{ Params: { accountId: string } }>(`${DSA_ADMIN_BASE_PATH}/accounts/:accountId/keys`, { preHandler: adminAuth }, async (request, reply) =>
    UUID_PATTERN.test(request.params.accountId)
      ? reply.send({ items: await dependencies.accounts.listKeys(request.params.accountId) })
      : apiError(reply, request, 404, "account_not_found", "Account was not found.")
  );
  app.post<{ Params: { accountId: string }; Body: { overlapSeconds?: unknown } }>(`${DSA_ADMIN_BASE_PATH}/accounts/:accountId/keys/rotate`, { preHandler: adminAuth, schema: { body: keyRotationBodySchema } }, async (request, reply) => {
    if (!UUID_PATTERN.test(request.params.accountId)) return apiError(reply, request, 404, "account_not_found", "Account was not found.");
    const overlapSeconds = request.body?.overlapSeconds;
    if (overlapSeconds !== undefined && (!Number.isSafeInteger(overlapSeconds) || Number(overlapSeconds) < 0)) {
      return apiError(reply, request, 400, "invalid_request", "overlapSeconds must be a non-negative integer.");
    }
    const issued = await dependencies.accounts.rotateKey(request.params.accountId, overlapSeconds as number | undefined);
    return reply.code(201).send({ keyId: issued.keyId, prefix: issued.prefix, apiKey: issued.plaintext });
  });
  app.delete<{ Params: { accountId: string; keyId: string }; Body: { reason?: unknown } }>(`${DSA_ADMIN_BASE_PATH}/accounts/:accountId/keys/:keyId`, { preHandler: adminAuth, schema: { body: auditReasonBodySchema } }, async (request, reply) => {
    if (!UUID_PATTERN.test(request.params.accountId) || !UUID_PATTERN.test(request.params.keyId)) return apiError(reply, request, 404, "key_not_found", "API key was not found.");
    const reason = request.body?.reason;
    if (typeof reason !== "string" || reason.trim().length < 3) return apiError(reply, request, 400, "invalid_request", "An audit reason is required.");
    const revoked = await dependencies.accounts.revokeKey(request.params.accountId, request.params.keyId, reason.trim());
    return revoked ? reply.code(204).send() : apiError(reply, request, 404, "key_not_found", "API key was not found.");
  });
  app.post<{ Params: { accountId: string }; Body: { delta?: unknown; reason?: unknown } }>(`${DSA_ADMIN_BASE_PATH}/accounts/:accountId/credits`, { preHandler: adminAuth, schema: { body: creditAdjustmentBodySchema } }, async (request, reply) => {
    if (!UUID_PATTERN.test(request.params.accountId)) return apiError(reply, request, 404, "account_not_found", "Account was not found.");
    const { delta, reason } = request.body ?? {};
    if (!Number.isSafeInteger(delta) || Number(delta) === 0 || typeof reason !== "string" || reason.trim().length < 3) {
      return apiError(reply, request, 400, "invalid_request", "A non-zero integer delta and audit reason are required.");
    }
    await dependencies.accounts.adjustCredits(request.params.accountId, Number(delta), reason.trim());
    const account = await dependencies.accounts.adminAccount(request.params.accountId);
    return account === null ? apiError(reply, request, 404, "account_not_found", "Account was not found.") : reply.send(account);
  });
  for (const [path, status] of [["suspend", "suspended"], ["reinstate", "active"]] as const) {
    app.post<{ Params: { accountId: string }; Body: { reason?: unknown } }>(`${DSA_ADMIN_BASE_PATH}/accounts/:accountId/${path}`, { preHandler: adminAuth, schema: { body: auditReasonBodySchema } }, async (request, reply) => {
      if (!UUID_PATTERN.test(request.params.accountId)) return apiError(reply, request, 404, "account_not_found", "Account was not found.");
      const reason = request.body?.reason;
      if (typeof reason !== "string" || reason.trim().length < 3) return apiError(reply, request, 400, "invalid_request", "An audit reason is required.");
      return reply.send(await dependencies.accounts.setAccountStatus(request.params.accountId, status, reason.trim()));
    });
  }
  app.post<{ Body: { name?: unknown; url?: unknown; signingSecret?: unknown } }>(`${DSA_ADMIN_BASE_PATH}/webhook-destinations`, { preHandler: adminAuth, schema: { body: createWebhookDestinationBodySchema } }, async (request, reply) => {
    const { name, url, signingSecret } = request.body ?? {};
    if (dependencies.destinations === undefined) throw new Error("Webhook destination administration is unavailable.");
    if (typeof name !== "string" || typeof url !== "string" || typeof signingSecret !== "string") {
      return apiError(reply, request, 400, "invalid_request", "Name, URL, and signingSecret are required.");
    }
    return reply.code(201).send(await dependencies.destinations.create(name, url, signingSecret));
  });
  app.get(`${DSA_ADMIN_BASE_PATH}/webhook-destinations`, { preHandler: adminAuth }, async (_request, reply) => {
    if (dependencies.destinations === undefined) throw new Error("Webhook destination administration is unavailable.");
    return reply.send({ items: await dependencies.destinations.list() });
  });
  app.patch<{ Params: { destinationId: string }; Body: { name?: unknown; url?: unknown; signingSecret?: unknown; status?: unknown } }>(`${DSA_ADMIN_BASE_PATH}/webhook-destinations/:destinationId`, { preHandler: adminAuth, schema: { body: updateWebhookDestinationBodySchema } }, async (request, reply) => {
    if (!UUID_PATTERN.test(request.params.destinationId)) return apiError(reply, request, 404, "destination_not_found", "Webhook destination was not found.");
    if (dependencies.destinations === undefined) throw new Error("Webhook destination administration is unavailable.");
    const body = request.body ?? {};
    if (body.status !== undefined && body.status !== "active" && body.status !== "disabled") {
      return apiError(reply, request, 400, "invalid_request", "Destination status is invalid.");
    }
    const updated = await dependencies.destinations.update(request.params.destinationId, {
      ...(typeof body.name === "string" ? { name: body.name } : {}),
      ...(typeof body.url === "string" ? { url: body.url } : {}),
      ...(typeof body.signingSecret === "string" ? { signingSecret: body.signingSecret } : {}),
      ...(body.status === "active" || body.status === "disabled" ? { status: body.status } : {})
    });
    return updated === null ? apiError(reply, request, 404, "destination_not_found", "Webhook destination was not found.") : reply.send(updated);
  });
  app.put<{ Params: { accountId: string }; Body: { destinationId?: unknown } }>(`${DSA_ADMIN_BASE_PATH}/accounts/:accountId/webhook-destination`, { preHandler: adminAuth, schema: { body: assignWebhookDestinationBodySchema } }, async (request, reply) => {
    if (!UUID_PATTERN.test(request.params.accountId)) return apiError(reply, request, 404, "account_not_found", "Account was not found.");
    if (dependencies.destinations === undefined) throw new Error("Webhook destination administration is unavailable.");
    const destinationId = request.body?.destinationId;
    if (destinationId !== null && typeof destinationId !== "string") {
      return apiError(reply, request, 400, "invalid_request", "destinationId must be a UUID or null.");
    }
    const assigned = await dependencies.destinations.assign(request.params.accountId, destinationId);
    return assigned ? reply.code(204).send() : apiError(reply, request, 404, "account_or_destination_not_found", "Account or destination was not found.");
  });
  app.get<{ Querystring: AnalyticsQuery }>(`${DSA_API_BASE_PATH}/analytics`, { preHandler: accountAuth }, async (request, reply) => {
    const principal = (request as AuthenticatedRequest).accountPrincipal;
    if (principal === undefined) return;
    if (dependencies.analytics === undefined) throw new Error("Analytics are unavailable.");
    const interval = analyticsInterval(request.query);
    if (interval === null) return apiError(reply, request, 400, "invalid_interval", "Analytics interval is invalid.");
    return reply.send(await dependencies.analytics.analytics(principal.accountId, interval, "personal"));
  });
  app.get<{ Querystring: AnalyticsQuery }>(`${DSA_API_BASE_PATH}/analytics/community`, { preHandler: accountAuth }, async (request, reply) => {
    if (dependencies.analytics === undefined) throw new Error("Analytics are unavailable.");
    const interval = analyticsInterval(request.query);
    if (interval === null) return apiError(reply, request, 400, "invalid_interval", "Analytics interval is invalid.");
    return reply.send(await dependencies.analytics.analytics(null, interval, "community"));
  });
  app.get<{ Querystring: AnalyticsQuery & { after?: string; limit?: string } }>(`${DSA_API_BASE_PATH}/action-history`, { preHandler: accountAuth }, async (request, reply) => {
    const principal = (request as AuthenticatedRequest).accountPrincipal;
    if (principal === undefined) return;
    if (dependencies.analytics === undefined) throw new Error("Analytics are unavailable.");
    const interval = analyticsInterval(request.query);
    const limit = request.query.limit === undefined ? 50 : Number(request.query.limit);
    const after = request.query.after ?? null;
    if (interval === null || !Number.isSafeInteger(limit) || limit < 1 || limit > 100 || (after !== null && !/^\d+$/.test(after))) {
      return apiError(reply, request, 400, "invalid_interval", "Action history query is invalid.");
    }
    return reply.send(await dependencies.analytics.actionHistory(principal.accountId, interval, after, limit));
  });
  app.get<{ Querystring: AnalyticsQuery }>(`${DSA_API_BASE_PATH}/digest-activity`, { preHandler: accountAuth }, async (request, reply) => {
    const principal = (request as AuthenticatedRequest).accountPrincipal;
    if (principal === undefined) return;
    if (dependencies.analytics === undefined) throw new Error("Analytics are unavailable.");
    const interval = analyticsInterval(request.query, true);
    if (interval === null) return apiError(reply, request, 400, "invalid_interval", "Digest interval is invalid.");
    return reply.send(await dependencies.analytics.digest(principal.accountId, interval));
  });
  app.post(
    "/webhooks/cloudflare-email",
    { config: { rateLimit: { max: 300, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const rawEmail = request.body;
      const recipient = singleHeader(request, "x-dsa-recipient")?.trim().toLowerCase();
      const messageId = singleHeader(request, "x-dsa-message-id")?.trim();
      const timestamp = singleHeader(request, "x-dsa-timestamp")?.trim();
      const signature = singleHeader(request, "x-dsa-signature")?.trim();
      if (
        !Buffer.isBuffer(rawEmail) || !recipient || !messageId || !timestamp || !signature ||
        recipient.length > 320 || messageId.length > 500
      ) {
        return apiError(reply, request, 400, "invalid_email_event", "Invalid email event.");
      }
      if (!verifyInboundSignature({ secret: config.webhookSecret, timestamp, recipient, messageId, rawEmail, signature })) {
        request.log.warn({ event: "inbound_email_rejected", messageIdDigest: sha256Hex(messageId).slice(0, 16) }, "Inbound email rejected");
        return apiError(reply, request, 401, "invalid_signature", "Invalid email signature.");
      }
      const inspection = await inspectDiscordEmail(rawEmail);
      if (inspection.kind === "ignored") return reply.code(202).send({ status: "ignored" });
      const parsed = inspection.email;
      const result = parsed.kind === "verification"
        ? await dependencies.reports.registerVerificationEmail({
            messageId, recipient,
            encryptedCode: encryptJson({ code: parsed.code }, config.sessionEncryptionKey)
          })
        : parsed.kind === "review_update"
          ? await dependencies.reports.registerReviewUpdateEmail({
              messageId, recipient, discordReportId: parsed.reportId
            })
          : await dependencies.reports.registerReportUpdateEmail({
              messageId, recipient, discordReportId: parsed.reportId, discordStatus: parsed.status,
              ...(parsed.reviewUrl === undefined ? {} : {
                encryptedReviewUrl: encryptJson({ reviewUrl: parsed.reviewUrl }, config.sessionEncryptionKey)
              })
            });
      return reply.code(202).send({ status: result.status });
    }
  );

  app.setNotFoundHandler((request, reply) =>
    apiError(reply, request, 404, "not_found", "Resource was not found.")
  );
  app.setErrorHandler((error, request, reply) => {
    const rawCode = typeof error === "object" && error !== null && "code" in error
      ? String(error.code)
      : "internal_error";
    const code = typeof error === "object" && error !== null &&
      "validation" in error && error.validation !== undefined ? "invalid_request" : rawCode;
    const statusCode = typeof error === "object" && error !== null && "statusCode" in error && typeof error.statusCode === "number"
      ? error.statusCode
      : code === "account_not_found" ? 404
        : code === "username_conflict" || code === "credits_would_be_negative" ? 409
          : 500;
    if (statusCode >= 500) request.log.error({ errorName: error instanceof Error ? error.name : "UnknownError" }, "Request failed");
    const safeCode = statusCode >= 500 ? "internal_error" : code;
    const message = statusCode >= 500 ? "An internal error occurred." : error instanceof Error ? error.message : "Request failed.";
    return apiError(reply, request, statusCode, safeCode, message);
  });

  return app;
}

function singleHeader(request: FastifyRequest, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function publicReportSummary(row: AccountReportRow) {
  const report = publicReport(row);
  return {
    reportId: report.reportId,
    accountId: report.accountId,
    flow: report.flow,
    useAi: report.useAi,
    status: report.status,
    creditState: report.creditState,
    lifecycleAttempt: report.lifecycleAttempt,
    country: report.country,
    category: report.category,
    description: report.description,
    discordReportId: report.discordReportId,
    discordStatus: report.discordStatus,
    reviewStatus: report.reviewStatus,
    predecessorReportId: report.predecessorReportId,
    successorReportId: report.successorReportId,
    retryableModes: report.retryableModes,
    createdAt: report.createdAt,
    updatedAt: report.updatedAt
  };
}

function sanitizeTarget(target: ReportTarget): PublicReportTarget {
  if ("messageUrl" in target) {
    if (target.messageEvidence?.status !== "captured") return { ...target };
    const snapshot = target.messageEvidence.snapshot;
    return {
      messageUrl: target.messageUrl,
      messageEvidence: {
        source: target.messageEvidence.source,
        status: "captured",
        capturedAt: target.messageEvidence.capturedAt,
        snapshot: {
          messageId: snapshot.messageId,
          channelId: snapshot.channelId,
          channelName: snapshot.channelName,
          serverId: snapshot.serverId,
          serverName: snapshot.serverName,
          authorId: snapshot.authorId,
          authorUsername: snapshot.authorUsername,
          authorDisplayName: snapshot.authorDisplayName,
          authorBot: snapshot.authorBot,
          content: snapshot.content,
          createdAt: snapshot.createdAt,
          attachments: snapshot.attachments.map((attachment) => ({
            name: attachment.name,
            contentType: attachment.contentType,
            size: attachment.size,
            spoiler: attachment.spoiler
          })),
          embeds: snapshot.embeds.map((embed) => ({
            title: embed.title,
            description: embed.description
          }))
        }
      }
    };
  }
  if ("reportedUserId" in target) {
    return {
      reportedUsername: target.reportedUsername,
      reportedUserId: target.reportedUserId,
      reportedUserSnapshot: {
        userId: target.reportedUserSnapshot.userId,
        username: target.reportedUserSnapshot.username,
        globalDisplayName: target.reportedUserSnapshot.globalDisplayName,
        bot: target.reportedUserSnapshot.bot,
        resolvedAt: target.reportedUserSnapshot.resolvedAt
      },
      profileElements: target.profileElements,
      ...(target.reportedUserServerId === undefined ? {} : { reportedUserServerId: target.reportedUserServerId })
    };
  }
  return target;
}

interface AnalyticsQuery { period?: string; startAt?: string; endAt?: string }

function analyticsInterval(query: AnalyticsQuery, requireCustom = false): AnalyticsInterval | null {
  if (query.startAt !== undefined || query.endAt !== undefined || requireCustom) {
    if (query.startAt === undefined || query.endAt === undefined) return null;
    const start = Date.parse(query.startAt);
    const end = Date.parse(query.endAt);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) return null;
    return { period: "custom", startAt: new Date(start).toISOString(), endAt: new Date(end).toISOString(), asOf: new Date().toISOString(), timezone: "UTC" };
  }
  const periods = new Set<AnalyticsPeriod>(["24h", "7d", "30d", "ytd", "365d", "all"]);
  const period = (query.period ?? "30d") as AnalyticsPeriod;
  return periods.has(period) ? resolveAnalyticsInterval(period) : null;
}
