import "@nreport/observability/instrument-api";
import { captureLifecycleFailure, flushSentry, safeErrorSummary } from "@nreport/observability";
import type { LifecycleFailureContext } from "@nreport/observability";
import { loadConfig } from "./config.js";
import { AccountRepository } from "./accounts.js";
import { LifecycleRunner, type LifecycleFailureSignal } from "./lifecycle-runner-v2.js";
import { AccountEventDeliveryWorker } from "./event-delivery-v2.js";
import { PostgresDatabase } from "./postgres.js";
import { PreparationWorker, preparationFailureLogFields } from "./preparation-worker.js";
import { ApiReportPreparer } from "./preparation/api-report-preparer.js";
import { createProxySessionId, generateIdentity, supportedCountries } from "./pseudonyms.js";
import { ReportRepository } from "./report-repository.js";
import { buildV2Server } from "./server-v2.js";
import { decryptJson } from "./security.js";
import { WebhookDestinationRepository } from "./webhook-destinations.js";
import { AnalyticsRepository } from "./analytics-repository.js";
import { OperationalHealthSampler, QueueObservabilitySampler } from "./operational-observability.js";
import { randomUUID } from "node:crypto";

function captureReportFailure(failure: LifecycleFailureSignal): void {
  const messages: Record<LifecycleFailureSignal["errorCategory"], string> = {
    verification_timeout: "Discord verification did not complete before the deadline.",
    discord_receipt_timeout: "Discord report receipt was not recorded before the deadline.",
    review_confirmation_timeout: "Discord appeal confirmation was not recorded before the deadline.",
    ambiguous_submission_state: "Discord report submission ended with an ambiguous outcome.",
    review_request_ambiguous: "Discord appeal submission ended with an ambiguous outcome."
  };
  captureLifecycleFailure(new Error(messages[failure.errorCategory]), {
    service: "api",
    operation: "report_lifecycle_outcome",
    reportId: failure.reportId,
    traceId: failure.traceId,
    lifecycleAttempt: failure.lifecycleAttempt,
    stage: failure.stage,
    eventType: failure.eventType,
    outcome: failure.outcome,
    errorCategory: failure.errorCategory,
    severity: "error"
  });
}

async function main(): Promise<void> {
  const config = loadConfig();
  const database = new PostgresDatabase(config.databaseUrl);
  try {
    await startApi(config, database);
  } catch (error) {
    await database.close().catch(() => undefined);
    throw error;
  }
}

async function startApi(config: ReturnType<typeof loadConfig>, database: PostgresDatabase): Promise<void> {
  await database.migrate();
  const reports = new ReportRepository(database.pool);
  const workerInstanceId = randomUUID();
  const destinations = new WebhookDestinationRepository(
    database.pool,
    config.sessionEncryptionKey,
    config.allowRailwayPrivateHttpWebhooks ?? false
  );
  const managedBotWebhook = config.botEventWebhook === undefined
    ? undefined
    : await destinations.configureManagedDefault(
      config.botEventWebhook.url,
      config.botEventWebhook.signingSecret
    );
  const accounts = new AccountRepository(
    database.pool,
    config.apiKeyPepper,
    managedBotWebhook?.destinationId
  );
  const analytics = new AnalyticsRepository(database.pool);
  for (const failure of await reports.recoverInterruptedJobs()) captureReportFailure(failure);
  const app = await buildV2Server(config, {
    healthcheck: () => database.healthcheck(),
    accounts,
    reports,
    destinations,
    analytics
  });
  if (managedBotWebhook !== undefined) {
    app.log.info({
      event: "managed_bot_webhook_configured",
      stage: "webhook",
      outcome: "completed",
      assignedAccountCount: managedBotWebhook.assignedAccountCount
    }, "Managed bot webhook configured");
  }
  const lastOperationalCapture = new Map<string, number>();
  const captureOperationalFailure = (key: string, error: unknown, context: Parameters<typeof captureLifecycleFailure>[1]): void => {
    const now = Date.now();
    const previous = lastOperationalCapture.get(key) ?? 0;
    if (now - previous < 60_000) return;
    lastOperationalCapture.set(key, now);
    captureLifecycleFailure(error, context);
  };
  let lastPreparationInfrastructureCapture = 0;
  const preparer = new ApiReportPreparer({
    aiApiKey: config.aiApiKey,
    aiModel: config.aiModel,
    braveSearchApiKey: config.braveSearchApiKey,
    supportedCountries: supportedCountries()
  });
  const preparationWorker = new PreparationWorker(
    reports,
    preparer,
    (country) => {
      const identity = generateIdentity(country, config.emailDomain);
      return {
        legalName: identity.displayName,
        email: identity.email,
        locale: identity.locale,
        timezone: identity.timezone,
        language: identity.language,
        proxySessionId: createProxySessionId()
      };
    },
    config.preparationConcurrency,
    undefined,
    (error) => {
      const context = errorFields(error);
      app.log.error({
        event: "preparation_worker_iteration_failed",
        ...preparationFailureLogFields(error),
        ...safeErrorLogFields(error),
        ...context,
        reportId: diagnosticString(error, "reportId"),
        traceId: diagnosticString(error, "traceId"),
        stage: diagnosticString(error, "stage") ?? "preparation",
        attempt: diagnosticNumber(error, "attempt"),
        outcome: "failed",
        errorCategory: diagnosticString(error, "kind") ?? "unknown",
        stackFingerprint: diagnosticString(error, "stackFingerprint")
      }, "Preparation worker iteration failed");
      const reportId = diagnosticString(error, "reportId");
      const traceId = diagnosticString(error, "traceId");
      const attempt = diagnosticNumber(error, "attempt");
      const errorCategory = diagnosticString(error, "kind");
      if (reportId !== undefined && traceId !== undefined) {
        void reports.recordDiagnostic({
          reportId, traceId, service: "api", severity: "error", event: "preparation_worker_failure",
          stage: diagnosticString(error, "stage") ?? "preparation", outcome: "failed",
          ...(attempt === undefined ? {} : { lifecycleAttempt: attempt }),
          ...(errorCategory === undefined ? {} : { errorCode: errorCategory }),
          details: { error: safeErrorLogFields(error), ...context }
        }).catch(() => undefined);
        captureLifecycleFailure(error, {
          service: "api", operation: "report_preparation", reportId, traceId,
          stage: diagnosticString(error, "stage") ?? "preparation", outcome: "failed",
          ...context,
          ...(attempt === undefined ? {} : { attempt }),
          ...(errorCategory === undefined ? {} : { errorCategory })
        });
      } else {
        const now = Date.now();
        if (now - lastPreparationInfrastructureCapture >= 60_000) {
          lastPreparationInfrastructureCapture = now;
          captureLifecycleFailure(error, {
            service: "api", operation: "preparation_worker_loop", stage: "preparation_claim",
            outcome: "failed", severity: "warning", ...errorFields(error)
          });
        }
      }
    },
    (outcome) => {
      lastPreparationInfrastructureCapture = 0;
      void reports.recordDiagnostic({ reportId: outcome.reportId, traceId: outcome.traceId, service: "api", severity: outcome.outcome === "failed" ? "error" : "info", event: "preparation_worker_outcome", stage: outcome.stage, outcome: outcome.outcome, ...(outcome.reporterEmail === undefined ? {} : { reporterEmail: outcome.reporterEmail }), ...(outcome.errorCategory === undefined ? {} : { errorCode: outcome.errorCategory }), details: outcome }).catch(() => undefined);
      if (outcome.outcome === "failed") app.log.error({ event: "preparation_worker_outcome", ...outcome }, "Preparation worker outcome");
      else {
        app.log.info({ event: "preparation_worker_outcome", ...outcome }, "Preparation worker outcome");
        if (outcome.reporterEmail !== undefined) app.log.info({
          event: "reporter_email_assigned", reportId: outcome.reportId, traceId: outcome.traceId,
          reporterEmail: outcome.reporterEmail, stage: "identity", outcome: "assigned"
        }, "Reporter email assigned");
      }
      void reports.recordOperationalWorker({
        component: "preparation", instanceId: workerInstanceId, configuredCapacity: config.preparationConcurrency,
        progressed: outcome.outcome === "completed", failure: outcome.outcome === "failed",
        rateLimited: outcome.errorCategory === "rate_limited"
      }).catch(() => undefined);
    }
  );
  const lifecycleRunner = new LifecycleRunner(
    reports,
    config,
    undefined,
    undefined,
    undefined,
    (outcome) => {
      if (outcome.component === "report_failure") {
        captureReportFailure(outcome);
      } else if (outcome.component === "job" && "reportId" in outcome) {
        const { error, ...details } = outcome;
        const jobKind = "jobKind" in outcome ? outcome.jobKind : undefined;
        const lifecycleAttempt = "attempts" in outcome ? outcome.attempts : undefined;
        void reports.recordDiagnostic({
          reportId: outcome.reportId,
          traceId: outcome.traceId,
          service: "api",
          severity: outcome.outcome === "failed" || outcome.outcome === "ambiguous" ? "error" : "info",
          event: "lifecycle_worker_outcome",
          stage: outcome.stage,
          outcome: outcome.outcome,
          ...(lifecycleAttempt === undefined ? {} : { lifecycleAttempt }),
          ...(outcome.errorCategory === undefined ? {} : { errorCode: outcome.errorCategory }),
          details: {
            ...details,
            ...(error === undefined ? {} : {
              error: safeErrorLogFields(error), ...errorFields(error)
            })
          }
        }).catch(() => undefined);
        if ((outcome.outcome === "failed" || outcome.outcome === "ambiguous") && error !== undefined &&
            outcome.errorCategory !== "discord_review_ineligible") {
          const details = {
            service: "api" as const,
            operation: jobKind === undefined ? "lifecycle_heartbeat" : "report_lifecycle",
            reportId: outcome.reportId,
            traceId: outcome.traceId,
            stage: outcome.stage,
            outcome: outcome.outcome,
            ...errorFields(error),
            ...(jobKind === undefined ? {} : { phase: jobKind, jobKind }),
            ...(lifecycleAttempt === undefined ? {} : { lifecycleAttempt }),
            ...(outcome.errorCategory === undefined ? {} : { errorCategory: outcome.errorCategory })
          };
          if (jobKind === undefined) {
            captureOperationalFailure("lifecycle_heartbeat", error, { ...details, severity: "warning" });
          } else {
            captureLifecycleFailure(error, details);
          }
        }
      } else if (outcome.error !== undefined) {
        const key = `lifecycle_${outcome.stage}`;
        captureOperationalFailure(key, outcome.error, {
          service: "api", operation: key, stage: outcome.stage, outcome: "failed",
          ...(outcome.errorCategory === undefined ? {} : { errorCategory: outcome.errorCategory }),
          ...errorFields(outcome.error), severity: "warning"
        });
      }
      if (outcome.component === "maintenance" && outcome.outcome === "completed") {
        lastOperationalCapture.delete("lifecycle_lifecycle_maintenance");
      }
      const error = "error" in outcome ? outcome.error : undefined;
      const outcomeFields: Record<string, unknown> = { ...outcome };
      delete outcomeFields.error;
      const fields = {
        event: "lifecycle_runner_outcome", ...outcomeFields,
        ...(error === undefined ? {} : safeErrorLogFields(error)),
        ...(error === undefined ? {} : errorFields(error))
      };
      if (outcome.outcome === "failed" || outcome.outcome === "ambiguous") app.log.error(fields, "Lifecycle runner outcome");
      else app.log.info(fields, "Lifecycle runner outcome");
      void reports.recordOperationalWorker({
        component: "lifecycle", instanceId: workerInstanceId, configuredCapacity: config.lifecycleConcurrency ?? 2,
        progressed: outcome.outcome === "completed" || outcome.outcome === "waiting_for_email",
        failure: outcome.outcome === "failed", rateLimited: outcome.errorCategory === "rate_limited"
      }).catch(() => undefined);
    }
  );
  const eventDeliveryWorker = new AccountEventDeliveryWorker(reports, {
    decrypt: (value) => decryptJson<string>(value, config.sessionEncryptionKey),
    log: (event, fields, level = "info") => app.log[level]({ event, ...fields }, "Event delivery outcome"),
    onFailure: (error, delivery) => captureLifecycleFailure(error, {
      service: "api", operation: "event_delivery", reportId: delivery.report_id, traceId: delivery.trace_id,
      stage: "webhook", deliveryStage: "webhook", eventType: delivery.event_type,
      outcome: "retry_exhausted", attempt: delivery.attempts, lifecycleAttempt: delivery.lifecycle_attempt,
      errorCategory: "event_delivery_failed"
    }),
    onPersistenceFailure: (error, delivery) => captureLifecycleFailure(error, {
      service: "api", operation: "event_delivery_retry_persist", reportId: delivery.report_id, traceId: delivery.trace_id,
      stage: "retry_persist", deliveryStage: "retry_persist", eventType: delivery.event_type,
      outcome: "failed", attempt: delivery.attempts, lifecycleAttempt: delivery.lifecycle_attempt,
      errorCategory: "delivery_state_persist_failed"
    }),
    onWorkerFailure: (error) => captureLifecycleFailure(error, {
      service: "api", operation: "event_delivery_worker", stage: "webhook_claim",
      outcome: "failed", severity: "warning", ...errorFields(error)
    })
  });
  const queueSampler = new QueueObservabilitySampler(
    reports,
    (event, fields, level = "info") => app.log[level]({ event, ...fields }, "Queue observability sample"),
    { onFailure: (error) => captureLifecycleFailure(error, {
      service: "api", operation: "queue_snapshot", stage: "queues", outcome: "failed", severity: "warning"
    }) }
  );
  const operationalHealthSampler = new OperationalHealthSampler(
    reports,
    workerInstanceId,
    { preparation: config.preparationConcurrency, lifecycle: config.lifecycleConcurrency ?? 2, delivery: 1 },
    { onFailure: (error) => captureLifecycleFailure(error, {
      service: "api", operation: "operational_health_sample", stage: "alert_state",
      outcome: "failed", severity: "warning", ...errorFields(error)
    }) }
  );
  let stopping = false;
  const stop = async (signal: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    app.log.info({ signal }, "Shutting down");
    let shutdownFailed = false;
    const close = async (operation: string, action: () => Promise<unknown>): Promise<void> => {
      try {
        await action();
      } catch (error) {
        shutdownFailed = true;
        app.log.error({ event: "api_shutdown_step_failed", operation, ...safeErrorLogFields(error) }, "API shutdown step failed");
        captureLifecycleFailure(error, { service: "api", operation, stage: "shutdown", outcome: "failed", severity: "error" });
      }
    };
    await close("http_server_close", () => app.close());
    if (config.workerEnabled) {
      await close("preparation_worker_stop", () => preparationWorker.stop());
      await close("lifecycle_worker_stop", () => lifecycleRunner.stop());
      await close("event_delivery_worker_stop", () => eventDeliveryWorker.stop());
      await close("queue_sampler_stop", () => queueSampler.stop());
      await close("operational_health_sampler_stop", () => operationalHealthSampler.stop());
    }
    await close("database_close", () => database.close());
    await flushSentry();
    if (shutdownFailed) process.exitCode = 1;
  };
  try {
    await app.listen({ host: "0.0.0.0", port: config.port });
    if (config.workerEnabled) {
      preparationWorker.start();
      lifecycleRunner.start();
      eventDeliveryWorker.start();
      queueSampler.start();
      operationalHealthSampler.start();
    }
  } catch (error) {
    await app.close().catch(() => undefined);
    throw error;
  }
  const stopFromSignal = (signal: string): void => {
    void stop(signal).catch((error: unknown) => {
      process.stderr.write(`${JSON.stringify({
        timestamp: new Date().toISOString(), level: "error", event: "api_shutdown_failed",
        signal, ...safeErrorLogFields(error)
      })}\n`);
      captureLifecycleFailure(error, {
        service: "api", operation: "shutdown", stage: "shutdown", outcome: "failed", severity: "error"
      });
      void flushSentry().then(
        () => { process.exitCode = 1; },
        () => { process.exitCode = 1; }
      );
    });
  };
  process.once("SIGINT", () => stopFromSignal("SIGINT"));
  process.once("SIGTERM", () => stopFromSignal("SIGTERM"));
}

function diagnosticString(value: unknown, key: string): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "string" ? field : undefined;
}

function diagnosticNumber(value: unknown, key: string): number | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "number" && Number.isFinite(field) ? field : undefined;
}

function safeErrorLogFields(error: unknown): Record<string, unknown> {
  const summary = safeErrorSummary(error);
  return {
    errorName: summary.name,
    errorMessage: summary.message,
    ...(summary.stack === undefined ? {} : { errorStack: summary.stack }),
    ...(summary.causes.length === 0 ? {} : { errorCauses: summary.causes })
  };
}

type SafeFailureContextFields = Partial<Pick<LifecycleFailureContext,
  "requestId" | "providerStatusCode" | "providerErrorCode" | "errorCategory" |
  "upstreamResponseSummary" | "discordErrorCode" | "discordHttpStatus"
>>;

function errorFields(error: unknown): SafeFailureContextFields {
  let current: unknown = error;
  for (let depth = 0; depth < 5; depth += 1) {
    if (typeof current !== "object" || current === null) break;
    const record = current as Record<string, unknown>;
    const status = record.status ?? record.httpStatus;
    const responseSummary = record.responseSummary;
    const providerCode = record.providerCode;
    const requestId = record.requestId;
    const fields: SafeFailureContextFields = {};
    const isDiscordHttpError = record.name === "DiscordDsaHttpError" ||
      typeof responseSummary === "string" || typeof requestId === "string";
    if (typeof status === "number" && Number.isInteger(status)) {
      if (isDiscordHttpError) fields.discordHttpStatus = status;
      else fields.providerStatusCode = status;
    }
    if (typeof responseSummary === "string") {
      fields.upstreamResponseSummary = safeErrorSummary(new Error(responseSummary)).message;
    }
    if (typeof providerCode === "string") fields.providerErrorCode = providerCode;
    if (typeof requestId === "string") {
      fields.requestId = safeErrorSummary(new Error(requestId)).message.slice(0, 120);
    }
    if (typeof responseSummary === "string") {
      const match = /^code ([A-Za-z0-9_.-]{1,40})(?:;|$)/.exec(responseSummary);
      if (match?.[1] !== undefined) {
        fields.discordErrorCode = /^\d{1,6}$/u.test(match[1]) ? Number(match[1]) : match[1];
      }
    }
    if (Object.keys(fields).length > 0) return fields;
    current = record.cause;
  }
  return {};
}

main().catch(async (error: unknown) => {
  process.stderr.write(`${JSON.stringify({
    timestamp: new Date().toISOString(), level: "error", event: "api_startup_failed",
    ...safeErrorLogFields(error)
  })}\n`);
  captureLifecycleFailure(error, {
    service: "api", operation: "startup", stage: "startup", outcome: "failed", severity: "error"
  });
  await flushSentry();
  process.exitCode = 1;
});
