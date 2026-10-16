import * as Sentry from "@sentry/node";
import type { NodeOptions } from "@sentry/node";
import { safeErrorSummary, sanitizeFailureContext, sanitizeSentryBreadcrumb, sanitizeSentryEvent, sanitizeSentryLog, sanitizeSentryTransaction } from "./sanitize.js";
import type { LifecycleFailureContext, SentryService } from "./types.js";

let initialized = false;

function environmentName(): string | undefined {
  const value = process.env.SENTRY_ENVIRONMENT?.trim() || process.env.NODE_ENV?.trim();
  return value !== undefined && /^[A-Za-z0-9_.-]{1,64}$/u.test(value) ? value : undefined;
}

function releaseName(): string | undefined {
  const value = process.env.SENTRY_RELEASE?.trim() || process.env.RAILWAY_GIT_COMMIT_SHA?.trim();
  return value !== undefined && /^[A-Za-z0-9_.-]{1,80}$/u.test(value) ? value : undefined;
}

function traceSampleRate(): number {
  const raw = process.env.SENTRY_TRACES_SAMPLE_RATE?.trim();
  if (raw === undefined) return 0.05;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 && value <= 1 ? value : 0.05;
}

let fatalShutdownStarted = false;

function finishFatal(error: unknown): void {
  if (fatalShutdownStarted) return;
  fatalShutdownStarted = true;
  try {
    process.stderr.write(`${JSON.stringify({ level: "fatal", error: safeErrorSummary(error) })}\n`);
  } catch {
    // Fatal handling must not itself fail while trying to write diagnostics.
  }

  const watchdog = setTimeout(() => process.exit(1), 2_250);
  void flushSentry(2_000).finally(() => {
    clearTimeout(watchdog);
    process.exit(1);
  });
}

export function initializeSentry(service: SentryService, overrides: Pick<NodeOptions, "transport"> = {}): void {
  if (initialized) return;
  initialized = true;
  // Fatal diagnostics must be scrubbed even when telemetry is disabled or
  // initialization fails. Own both paths so Node never prints the raw Error.
  process.on("uncaughtException", (error) => {
    if (fatalShutdownStarted) return;
    captureLifecycleFailure(error, { service, operation: "process.uncaught_exception", severity: "error" });
    finishFatal(error);
  });
  process.on("unhandledRejection", (reason) => {
    if (fatalShutdownStarted) return;
    captureLifecycleFailure(reason, { service, operation: "process.unhandled_rejection", severity: "error" });
    finishFatal(reason);
  });
  const dsn = process.env.SENTRY_DSN?.trim();
  if (dsn === undefined || dsn.length === 0) return;

  try {
    Sentry.init({
      dsn,
      ...(overrides.transport === undefined ? {} : { transport: overrides.transport }),
      environment: environmentName(),
      release: releaseName(),
      dataCollection: {
        userInfo: false,
        cookies: false,
        httpHeaders: false,
        httpBodies: [],
        urlQueryParams: false,
        graphQL: { document: false, variables: false },
        genAI: { inputs: false, outputs: false },
        databaseQueryData: false,
        stackFrameVariables: false,
        frameContextLines: 0
      },
      enableLogs: false,
      tracesSampleRate: traceSampleRate(),
      maxBreadcrumbs: 20,
      maxValueLength: 1_000,
      normalizeDepth: 3,
      tracePropagationTargets: [],
      integrations: (integrations) => integrations.filter((integration) =>
        integration.name !== "OnUnhandledRejection" && integration.name !== "OnUncaughtException"),
      initialScope: { tags: { service } },
      beforeBreadcrumb: sanitizeSentryBreadcrumb,
      beforeSend: sanitizeSentryEvent,
      beforeSendTransaction: sanitizeSentryTransaction,
      beforeSendLog: sanitizeSentryLog
    });
  } catch {
    // Sentry configuration must never prevent the API or bot from starting.
    process.stderr.write(`Sentry initialization failed for ${service}; telemetry is disabled.\n`);
  }
}

export function captureLifecycleFailure(error: unknown, context: LifecycleFailureContext): string | undefined {
  try {
    if (!initialized || !Sentry.isEnabled()) return undefined;
    const safe = sanitizeFailureContext(context);
    const eventId = Sentry.withScope((scope) => {
      scope.setLevel(context.severity ?? "warning");
      scope.setTag("service", context.service);
      scope.setTag("operation", String(safe.operation));
      if (typeof safe.reportId === "string") scope.setTag("report_id", safe.reportId);
      if (typeof safe.traceId === "string") scope.setTag("report_trace_id", safe.traceId);
      if (typeof safe.requestId === "string") scope.setTag("request_id", safe.requestId);
      if (typeof safe.stage === "string") scope.setTag("stage", safe.stage);
      if (typeof safe.outcome === "string") scope.setTag("outcome", safe.outcome);
      if (typeof safe.jobKind === "string") scope.setTag("job_kind", safe.jobKind);
      if (typeof safe.eventType === "string") scope.setTag("event_type", safe.eventType);
      if (typeof safe.deliveryStage === "string") scope.setTag("delivery_stage", safe.deliveryStage);
      if (typeof safe.method === "string") scope.setTag("http.method", safe.method);
      if (typeof safe.route === "string") scope.setTag("http.route", safe.route);
      if (typeof safe.statusCode === "number") scope.setTag("http.status_code", String(safe.statusCode));
      if (typeof safe.providerErrorCode === "string") scope.setTag("provider.error_code", safe.providerErrorCode);
      if (typeof safe.discordErrorCode === "string" || typeof safe.discordErrorCode === "number") {
        scope.setTag("discord.error_code", String(safe.discordErrorCode));
      }
      scope.setContext("lifecycle", safe);
      return Sentry.captureException(error);
    });
    return eventId;
  } catch {
    // Error telemetry must never alter the lifecycle result or interrupt a worker.
    return undefined;
  }
}

export async function flushSentry(timeoutMs = 2_000): Promise<boolean> {
  if (!initialized || !Sentry.isEnabled()) return true;
  try {
    return await Sentry.flush(Math.max(0, Math.min(timeoutMs, 10_000)));
  } catch {
    return false;
  }
}
