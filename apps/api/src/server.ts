import { Buffer } from "node:buffer";

import rateLimit from "@fastify/rate-limit";
import {
  ANALYTICS_PERIODS,
  DISCORD_REPORT_STATUSES,
  type AnalyticsInterval,
  type AnalyticsPeriod,
  type ReportDetail,
  type ReportedDetails,
  type ReportSummary,
  type ReportTimelineEvent
} from "@discord-dsa/contracts";
import Fastify from "fastify";
import type { FastifyReply, FastifyRequest } from "fastify";

import type { AppConfig } from "./config.js";
import {
  decodeActionHistoryCursor,
  IdempotencyConflictError,
  ReportRetryError,
  ReviewRetryError
} from "./database.js";
import type { Database, ReportEventRow, ReportRow } from "./database.js";
import { inspectDiscordEmail } from "./email.js";
import { resolveAnalyticsInterval } from "./analytics.js";
import {
  createProxySessionId,
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

function publicReportSummary(report: ReportRow): ReportSummary {
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
    retryOfReportId: report.retry_of_report_id,
    retriedAsReportId: report.retried_as_report_id,
    retrySequence: report.retry_sequence,
    failureStage: report.failure_stage,
    status: report.status,
    discordReportId: report.discord_report_id,
    discordStatus: report.discord_status,
    discordStatusUpdatedAt: report.discord_status_updated_at?.toISOString() ?? null,
    reviewStatus: report.review_status,
    reviewStatusUpdatedAt: report.review_status_updated_at?.toISOString() ?? null,
    reviewError:
      report.review_error_code === null
        ? null
        : { code: report.review_error_code, message: report.review_error_message },
    appealRetryable: report.review_status === "ineligible",
    resubmittable:
      report.discord_status === "review_not_approved" &&
      report.retried_as_report_id === null,
    error:
      report.error_code === null
        ? null
        : { code: report.error_code, message: report.error_message },
    createdAt: report.created_at.toISOString(),
    updatedAt: report.updated_at.toISOString()
  };
}

function reportedDetails(report: ReportRow): ReportedDetails {
  const input = report.input;
  const context = input.context === undefined ? {} : { context: input.context };
  const reportReason =
    input.reportReason === undefined ? {} : { reportReason: input.reportReason };
  switch (input.flow) {
    case "message_urf":
      return { kind: "message", messageUrl: input.messageUrl, ...reportReason, ...context };
    case "user_urf":
      return {
        kind: "profile",
        reportedUsername: input.reportedUsername,
        ...(input.reportedUserId === undefined ? {} : { reportedUserId: input.reportedUserId }),
        ...(input.reportedUserSnapshot === undefined
          ? {}
          : { reportedUserSnapshot: input.reportedUserSnapshot }),
        profileElements: input.profileElements,
        ...reportReason,
        ...(input.reportedUserServerId === undefined
          ? {}
          : { reportedUserServerId: input.reportedUserServerId }),
        ...context
      };
    case "guild_urf":
      return {
        kind: "server",
        guildIdOrInviteCode: input.guildIdOrInviteCode,
        guildElements: input.guildElements,
        ...reportReason,
        ...context
      };
  }
}

function timeline(events: readonly ReportEventRow[]): ReportTimelineEvent[] {
  let lifecycleAttempt = 1;
  return events.map((event) => {
    const metadataAttempt = event.metadata.lifecycleAttempt;
    if (typeof metadataAttempt === "number" && Number.isInteger(metadataAttempt)) {
      lifecycleAttempt = metadataAttempt;
    }
    const rawDiscordStatus = event.metadata.discordStatus;
    const discordStatus =
      typeof rawDiscordStatus === "string" &&
      (DISCORD_REPORT_STATUSES as readonly string[]).includes(rawDiscordStatus)
        ? (rawDiscordStatus as ReportTimelineEvent["discordStatus"])
        : null;
    return {
      eventId: event.id,
      type: event.event_type,
      occurredAt: event.created_at.toISOString(),
      lifecycleAttempt,
      discordStatus,
      errorCode:
        typeof event.metadata.errorCode === "string" ? event.metadata.errorCode : null
    };
  });
}

async function publicReportDetail(database: Database, report: ReportRow): Promise<ReportDetail> {
  return {
    ...publicReportSummary(report),
    reportedDetails: reportedDetails(report),
    timeline: timeline(await database.getReportEvents(report.id))
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

interface AnalyticsQuery {
  period?: string;
  startAt?: string;
  endAt?: string;
  after?: string;
  limit?: string;
}

function analyticsPeriod(value: string | undefined): AnalyticsPeriod | null {
  const period = value ?? "7d";
  return (ANALYTICS_PERIODS as readonly string[]).includes(period)
    ? period as AnalyticsPeriod
    : null;
}

function exactUtcTimestamp(value: string): boolean {
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

function actionHistoryInterval(query: AnalyticsQuery): AnalyticsInterval | null {
  if (query.startAt !== undefined || query.endAt !== undefined) {
    if (
      query.startAt === undefined || query.endAt === undefined ||
      !exactUtcTimestamp(query.startAt) || !exactUtcTimestamp(query.endAt) ||
      Date.parse(query.startAt) >= Date.parse(query.endAt)
    ) return null;
    const asOf = new Date().toISOString();
    return {
      period: "custom",
      startAt: query.startAt,
      endAt: query.endAt,
      asOf,
      timezone: "UTC"
    };
  }
  const period = analyticsPeriod(query.period);
  return period === null ? null : resolveAnalyticsInterval(period);
}

function exactAnalyticsInterval(query: AnalyticsQuery, maximumDays = 3_660): AnalyticsInterval | null {
  if (
    query.period !== undefined || query.startAt === undefined || query.endAt === undefined ||
    !exactUtcTimestamp(query.startAt) || !exactUtcTimestamp(query.endAt) ||
    Date.parse(query.startAt) >= Date.parse(query.endAt) ||
    Date.parse(query.endAt) - Date.parse(query.startAt) > maximumDays * 24 * 60 * 60 * 1_000
  ) return null;
  return {
    period: "custom",
    startAt: query.startAt,
    endAt: query.endAt,
    asOf: new Date().toISOString(),
    timezone: "UTC"
  };
}

function invalidAnalyticsQuery(reply: FastifyReply) {
  return reply.code(400).send({
    error: { code: "invalid_analytics_query", message: "Invalid analytics query." }
  });
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
          "req.headers.x-dsa-recipient",
          "req.headers.x-dsa-message-id",
          "request.headers.authorization",
          "request.headers.x-dsa-signature",
          "request.headers.x-dsa-recipient",
          "request.headers.x-dsa-message-id"
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
        request.log.info(
          {
            event: "report_create_accepted",
            reportId: result.report.id,
            created: result.created,
            flow: result.report.flow,
            country: result.report.country
          },
          "Report creation accepted"
        );
        return reply
          .code(result.created ? 202 : 200)
          .send(await publicReportDetail(database, result.report));
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
      return reply.send(await publicReportDetail(database, report));
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
        const retryInput = parseCreateReportInput({
          ...report.input,
          ...(input.reportReason === undefined
            ? {}
            : { reportReason: input.reportReason }),
          ...(input.context === undefined ? {} : { context: input.context })
        });
        const identity = generateIdentity(report.country, config.emailDomain);
        const result = await database.retryReport({
          reportId: report.id,
          idempotencyKey,
          submitterDiscordUserId: input.submitterDiscordUserId,
          id: identity.internalReportId,
          legalName: identity.displayName,
          email: identity.email,
          timezone: identity.timezone,
          locale: identity.locale,
          language: identity.language,
          proxySessionId: createProxySessionId(),
          input: retryInput,
          requestHash: sha256Hex(JSON.stringify(retryInput)),
          hasOverrides:
            input.reportReason !== undefined || input.context !== undefined
        });
        request.log.info(
          {
            event: "report_retry_accepted",
            reportId: result.report.id,
            previousReportId: report.id,
            replayed: result.replayed,
            retrySequence: result.report.retry_sequence
          },
          "Report retry accepted"
        );
        return reply
          .code(result.replayed ? 200 : 202)
          .send(await publicReportDetail(database, result.report));
      } catch (error) {
        if (error instanceof ReportRetryError) {
          return reply.code(error.statusCode).send({
            error: { code: error.code, message: error.message }
          });
        }
        if (error instanceof IdempotencyConflictError) {
          return reply.code(409).send({
            error: { code: "idempotency_conflict", message: error.message }
          });
        }
        throw error;
      }
    }
  );

  app.post<{ Params: { id: string } }>(
    "/v1/reports/:id/retry-appeal",
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
        const message = error instanceof Error ? error.message : "Invalid appeal retry request.";
        return reply.code(400).send({ error: { code: "invalid_request", message } });
      }
      try {
        const result = await database.retryIneligibleReview({
          reportId: request.params.id,
          submitterDiscordUserId: input.submitterDiscordUserId,
          idempotencyKey
        });
        request.log.info(
          {
            event: "appeal_retry_accepted",
            reportId: result.report.id,
            replayed: result.replayed
          },
          "Appeal retry accepted"
        );
        return reply
          .code(result.replayed ? 200 : 202)
          .send(await publicReportDetail(database, result.report));
      } catch (error) {
        if (error instanceof ReviewRetryError) {
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
      return reply.send({ reports: reports.map(publicReportSummary) });
    }
  );

  app.get<{ Params: { discordUserId: string }; Querystring: AnalyticsQuery }>(
    "/v1/users/:discordUserId/analytics",
    { preHandler: authorize },
    async (request, reply) => {
      if (!/^\d{15,22}$/.test(request.params.discordUserId)) {
        return invalidAnalyticsQuery(reply);
      }
      if (request.query.startAt !== undefined || request.query.endAt !== undefined) {
        const interval = exactAnalyticsInterval(request.query);
        return interval === null
          ? invalidAnalyticsQuery(reply)
          : reply.send(await database.reportAnalyticsForInterval(request.params.discordUserId, interval));
      }
      const period = analyticsPeriod(request.query.period);
      if (period === null) {
        return invalidAnalyticsQuery(reply);
      }
      return reply.send(await database.reportAnalytics(request.params.discordUserId, period));
    }
  );

  app.get<{ Querystring: AnalyticsQuery }>(
    "/v1/analytics/community",
    { preHandler: authorize },
    async (request, reply) => {
      if (request.query.startAt !== undefined || request.query.endAt !== undefined) {
        const interval = exactAnalyticsInterval(request.query);
        return interval === null
          ? invalidAnalyticsQuery(reply)
          : reply.send(await database.communityAnalyticsForInterval(interval));
      }
      const period = analyticsPeriod(request.query.period);
      if (period === null) {
        return invalidAnalyticsQuery(reply);
      }
      return reply.send(await database.communityAnalytics(period));
    }
  );

  app.get<{ Params: { discordUserId: string }; Querystring: AnalyticsQuery }>(
    "/v1/users/:discordUserId/digest-activity",
    { preHandler: authorize },
    async (request, reply) => {
      const interval = exactAnalyticsInterval(request.query, 366);
      if (!/^\d{15,22}$/.test(request.params.discordUserId) || interval === null ||
        interval.startAt === null) {
        return invalidAnalyticsQuery(reply);
      }
      return reply.send(await database.digestActivity(
        request.params.discordUserId,
        new Date(interval.startAt),
        new Date(interval.endAt)
      ));
    }
  );

  app.get<{ Params: { discordUserId: string }; Querystring: AnalyticsQuery }>(
    "/v1/users/:discordUserId/action-history",
    { preHandler: authorize },
    async (request, reply) => {
      const interval = actionHistoryInterval(request.query);
      const limit = Number(request.query.limit ?? "10");
      if (
        !/^\d{15,22}$/.test(request.params.discordUserId) || interval === null ||
        !Number.isInteger(limit) || limit < 1 || limit > 25 ||
        (request.query.after !== undefined && (() => {
          try {
            decodeActionHistoryCursor(request.query.after);
            return false;
          } catch {
            return true;
          }
        })())
      ) {
        return invalidAnalyticsQuery(reply);
      }
      return reply.send(await database.actionHistory({
        discordUserId: request.params.discordUserId,
        interval,
        after: request.query.after ?? null,
        limit
      }));
    }
  );

  app.get<{ Querystring: { after?: string; limit?: string } }>(
    "/v1/report-events",
    { preHandler: authorize },
    async (request, reply) => {
      const after = request.query.after ?? "0";
      const limit = Number(request.query.limit ?? "100");
      if (!/^\d+$/.test(after) || !Number.isInteger(limit) || limit < 1 || limit > 100) {
        return reply.code(400).send({
          error: { code: "invalid_event_cursor", message: "Invalid event cursor or limit." }
        });
      }
      const events = await database.listLifecycleEvents(after, limit);
      return reply.send({
        events: events.map((event) => {
          const discordStatus = event.metadata.discordStatus;
          return {
            eventId: event.id,
            internalReportId: event.report_id,
            submitterDiscordUserId: event.submitter_discord_user_id,
            type:
              event.event_type === "discord_status_updated" &&
              typeof discordStatus === "string"
                ? `discord:${discordStatus}`
                : event.event_type,
            occurredAt: event.created_at.toISOString(),
            lifecycleAttempt:
              typeof event.metadata.lifecycleAttempt === "number"
                ? event.metadata.lifecycleAttempt
                : 1
          };
        })
      });
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
        request.log.warn(
          { event: "inbound_email_rejected", reason: "invalid_event" },
          "Inbound email rejected"
        );
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
        request.log.warn(
          {
            event: "inbound_email_rejected",
            reason: "invalid_signature",
            messageIdDigest: sha256Hex(messageId).slice(0, 16)
          },
          "Inbound email rejected"
        );
        return reply.code(401).send({ error: { code: "invalid_signature" } });
      }
      const inspection = await inspectDiscordEmail(rawEmail);
      const messageIdDigest = sha256Hex(messageId).slice(0, 16);
      if (inspection.kind === "ignored") {
        request.log.info(
          {
            event: "inbound_email_ignored",
            messageIdDigest,
            ...inspection.diagnostic
          },
          "Inbound email ignored"
        );
        return reply.code(202).send({ status: "ignored" });
      }
      const parsed = inspection.email;
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
          : parsed.kind === "review_update"
            ? await database.registerReviewUpdateEmail({
                messageId,
                recipient,
                discordReportId: parsed.reportId,
                reviewStatus: parsed.status
              })
            : await database.registerReportUpdateEmail({
                messageId,
                recipient,
                discordReportId: parsed.reportId,
                discordStatus: parsed.status,
                ...(parsed.reviewUrl === undefined
                  ? {}
                  : {
                      encryptedReviewUrl: encryptJson(
                        { reviewUrl: parsed.reviewUrl },
                        config.sessionEncryptionKey
                      )
                    })
              });
      request.log.info(
        {
          event: "inbound_email_correlated",
          messageIdDigest,
          emailKind: parsed.kind,
          correlationStatus: result.status,
          reportId: result.reportId,
          ...(parsed.kind === "report_update"
            ? { discordStatus: parsed.status, reviewEligible: parsed.reviewUrl !== undefined }
            : parsed.kind === "review_update"
              ? { reviewStatus: parsed.status }
              : {})
        },
        "Inbound email processed"
      );
      return reply.code(202).send({ status: result.status });
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
