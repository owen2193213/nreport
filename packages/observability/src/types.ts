export type SentryService = "api" | "bot";
export type SentrySeverity = "warning" | "error";

/** The deliberately small, privacy-safe context accepted for actionable failures. */
export interface LifecycleFailureContext {
  service: SentryService;
  operation: string;
  severity?: SentrySeverity;
  reportId?: string;
  traceId?: string;
  requestId?: string;
  stage?: string;
  phase?: string;
  outcome?: string;
  jobKind?: string;
  eventType?: string;
  deliveryStage?: string;
  lifecycleAttempt?: number;
  attempt?: number;
  method?: string;
  /** A route template only, for example `/v1/reports/:reportId/retry`. */
  route?: string;
  statusCode?: number;
  providerStatusCode?: number;
  providerErrorCode?: string;
  errorCategory?: string;
  /** A transport-allowlisted upstream response summary; never pass a raw response body. */
  upstreamResponseSummary?: string;
  discordErrorCode?: string | number;
  discordHttpStatus?: number;
  queueCount?: number;
  oldestAgeMs?: number;
}

export interface SafeErrorCause {
  name: string;
  message: string;
  stack?: string;
}

export interface SafeErrorSummary {
  name: string;
  message: string;
  stack?: string;
  causes: SafeErrorCause[];
}
