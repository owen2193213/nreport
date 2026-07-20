import { Buffer } from "node:buffer";

import rateLimit from "@fastify/rate-limit";
import Fastify from "fastify";
import type { FastifyReply, FastifyRequest } from "fastify";

import type { AppConfig } from "./config.js";
import { IdempotencyConflictError, ReportRetryError } from "./database.js";
import type { Database, ReportRow } from "./database.js";
import { parseDiscordEmail } from "./email.js";
import {
  createProxySessionId,
  generateEmailAlias,
  generateIdentity,
  supportedCountries
} from "./pseudonyms.js";
import {
  encryptJson,
  safeEqual,
  sha256Hex,
  verifyInboundSignature
} from "./security.js";
import { parseCreateReportInput, parseRetryReportInput } from "./validation.js";

function publicReport(report: ReportRow): Record<string, unknown> {
  return {
    internalReportId: report.id,
    country: report.country,
    flow: report.flow,
    reportType: report.report_type,
    submitterDiscordUserId: report.submitter_discord_user_id,
    pseudonym: report.reporter_legal_name,
    email: report.reporter_email,
    locale: report.locale,
    timezone: report.timezone,
    lifecycleAttempt: report.lifecycle_attempt,
    retryable: report.retryable,
    failureStage: report.failure_stage,
    status: report.status,
    discordReportId: report.discord_report_id,
    discordStatus: report.discord_status,
    discordStatusUpdatedAt: report.discord_status_updated_at,
    error:
      report.error_code === null
        ? null
        : { code: report.error_code, message: report.error_message },
    createdAt: report.created_at,
    updatedAt: report.updated_at
  };
}

function header(request: FastifyRequest, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function apiAuthorization(config: AppConfig) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const authorization = header(request, "authorization") ?? "";
    if (!authorization.startsWith("Bearer ") || !safeEqual(authorization.slice(7), config.apiKey)) {
      await reply.code(401).send({ error: { code: "unauthorized", message: "Unauthorized." } });
    }
  };
}

export async function buildServer(config: AppConfig, database: Database) {
  const app = Fastify({
    bodyLimit: 1_048_576,
    logger: {
      level: config.environment === "production" ? "info" : "debug",
      redact: {
        paths: [
          "req.headers.authorization",
          "req.headers.x-dsa-signature",
          "request.headers.authorization",
          "request.headers.x-dsa-signature"
        ],
        censor: "[REDACTED]"
      }
    }
  });

  await app.register(rateLimit, {
    global: true,
    max: 120,
    timeWindow: "1 minute"
  });

  app.addContentTypeParser(
    "message/rfc822",
    { parseAs: "buffer" },
    (_request, body, done) => {
      done(null, body);
    }
  );

  app.get("/healthz", async (_request, reply) => {
    await database.healthcheck();
    return reply.send({ status: "ok" });
  });

  const authorize = apiAuthorization(config);

  app.get("/v1/countries", { preHandler: authorize }, async (_request, reply) => {
    return reply.send({ countries: supportedCountries() });
  });

  app.post(
    "/v1/reports",
    { preHandler: authorize, config: { rateLimit: { max: 20, timeWindow: "1 minute" } } },
    async (request, reply) => {
      try {
        const idempotencyKey = header(request, "idempotency-key")?.trim();
        if (!idempotencyKey || idempotencyKey.length < 8 || idempotencyKey.length > 200) {
          return reply.code(400).send({
            error: {
              code: "invalid_idempotency_key",
              message: "Idempotency-Key must contain between 8 and 200 characters."
            }
          });
        }
        const input = parseCreateReportInput(request.body);
        const identity = generateIdentity(input.country, config.emailDomain);
        const result = await database.createReport({
          id: identity.internalReportId,
          idempotencyKey,
          requestHash: sha256Hex(JSON.stringify(input)),
          input,
          legalName: identity.displayName,
          email: identity.email,
          timezone: identity.timezone,
          locale: identity.locale,
          language: identity.language,
          proxySessionId: createProxySessionId()
        });
        return reply.code(result.created ? 202 : 200).send(publicReport(result.report));
      } catch (error) {
        if (error instanceof IdempotencyConflictError) {
          return reply.code(409).send({
            error: { code: "idempotency_conflict", message: error.message }
          });
        }
        const message = error instanceof Error ? error.message : "Invalid report request.";
        return reply.code(400).send({ error: { code: "invalid_request", message } });
      }
    }
  );

  app.get<{ Params: { id: string } }>(
    "/v1/reports/:id",
    { preHandler: authorize },
    async (request, reply) => {
      const report = await database.getReport(request.params.id);
      if (!report) {
        return reply.code(404).send({
          error: { code: "report_not_found", message: "Report was not found." }
        });
      }
      return reply.send(publicReport(report));
    }
  );

  app.post<{ Params: { id: string } }>(
    "/v1/reports/:id/retry",
    { preHandler: authorize, config: { rateLimit: { max: 5, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const idempotencyKey = header(request, "idempotency-key")?.trim();
      if (!idempotencyKey || idempotencyKey.length < 8 || idempotencyKey.length > 200) {
        return reply.code(400).send({
          error: {
            code: "invalid_idempotency_key",
            message: "Idempotency-Key must contain between 8 and 200 characters."
          }
        });
      }
      let input: ReturnType<typeof parseRetryReportInput>;
      try {
        input = parseRetryReportInput(request.body);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Invalid retry request.";
        return reply.code(400).send({ error: { code: "invalid_request", message } });
      }
      try {
        const report = await database.getReport(request.params.id);
        if (!report) throw new ReportRetryError("report_not_found");
        const result = await database.retryReport({
          reportId: report.id,
          idempotencyKey,
          submitterDiscordUserId: input.submitterDiscordUserId,
          email: generateEmailAlias(
            report.reporter_legal_name,
            report.language,
            config.emailDomain
          ),
          proxySessionId: createProxySessionId()
        });
        return reply.code(result.replayed ? 200 : 202).send(publicReport(result.report));
      } catch (error) {
        if (error instanceof ReportRetryError) {
          return reply.code(error.statusCode).send({
            error: { code: error.code, message: error.message }
          });
        }
        throw error;
      }
    }
  );

  app.get<{ Params: { discordUserId: string } }>(
    "/v1/users/:discordUserId/reports",
    { preHandler: authorize },
    async (request, reply) => {
      if (!/^\d{15,22}$/.test(request.params.discordUserId)) {
        return reply.code(400).send({
          error: {
            code: "invalid_discord_user_id",
            message: "discordUserId must be a Discord snowflake."
          }
        });
      }
      const reports = await database.listReportsBySubmitter(request.params.discordUserId);
      return reply.send({ reports: reports.map(publicReport) });
    }
  );

  app.post(
    "/webhooks/cloudflare-email",
    { config: { rateLimit: { max: 300, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const rawEmail = request.body;
      const recipient = header(request, "x-dsa-recipient")?.trim().toLowerCase();
      const messageId = header(request, "x-dsa-message-id")?.trim();
      const timestamp = header(request, "x-dsa-timestamp")?.trim();
      const signature = header(request, "x-dsa-signature")?.trim();
      if (
        !Buffer.isBuffer(rawEmail) ||
        !recipient ||
        !messageId ||
        !timestamp ||
        !signature ||
        recipient.length > 320 ||
        messageId.length > 500
      ) {
        return reply.code(400).send({ error: { code: "invalid_email_event" } });
      }
      if (
        !verifyInboundSignature({
          secret: config.webhookSecret,
          timestamp,
          recipient,
          messageId,
          rawEmail,
          signature
        })
      ) {
        return reply.code(401).send({ error: { code: "invalid_signature" } });
      }
      const parsed = await parseDiscordEmail(rawEmail);
      if (!parsed) return reply.code(202).send({ status: "ignored" });
      const result =
        parsed.kind === "verification"
          ? await database.registerVerificationEmail({
              messageId,
              recipient,
              encryptedCode: encryptJson(
                { code: parsed.code },
                config.sessionEncryptionKey
              )
            })
          : await database.registerReportUpdateEmail({
              messageId,
              recipient,
              discordReportId: parsed.reportId,
              discordStatus: parsed.status
            });
      return reply.code(202).send({ status: result });
    }
  );

  app.setErrorHandler((error, request, reply) => {
    const statusCode =
      typeof error === "object" &&
      error !== null &&
      "statusCode" in error &&
      typeof error.statusCode === "number"
        ? error.statusCode
        : 500;
    const errorName = error instanceof Error ? error.name : "UnknownError";
    request.log.error(
      { errorName, statusCode },
      "Request failed"
    );
    void reply.code(statusCode).send({
      error: {
        code: statusCode === 429 ? "rate_limited" : "internal_error",
        message: statusCode === 429 ? "Too many requests." : "Internal server error."
      }
    });
  });

  return app;
}
