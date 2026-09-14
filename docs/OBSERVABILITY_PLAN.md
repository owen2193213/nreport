# Proposed coherent flow logging and queue monitoring

Status: correlation and aggregate queue sampling implemented, 2026-09-10; later dashboard, alert,
heartbeat, and broader span work remains proposed. Apply to the account-owned live API and separate
bot/email services. No new monitoring vendor or paid service is required for the initial rollout.
Preserve service/database ownership and avoid ambiguous Discord resubmission.

## Objectives

Answer for one report: where is it waiting, how long, which attempt/stage failed, is retry safe, was Discord submission confirmed, and did the bot update its card? Answer for the fleet: are queues progressing, where is capacity spent, and are user-visible errors increasing? Logs must not contain credentials or auth secrets (Discord tokens, encryption keys, API keys, proxy passwords). Operational logs may include Discord identifiers, message URLs, external Discord report IDs, and HTTP failure payloads to support bot and API diagnostics.

Testing-only persistence uses separate API and bot diagnostic ledgers, indexed by report ID, trace ID,
and time and purged after 30 days. Entries are SQL-only operational data. Aliases, evidence/report
context, failure bodies, and stack traces are permitted in this private phase; raw RFC822 mail,
credentials, cookies, proxy credentials, and verification codes remain prohibited. Review this policy
before public deployment.

## One correlation model

Generate a random opaque `traceId` when the API creates a report and persist it. Propagate that
exact value through preparation/provider operations, lifecycle jobs, durable lifecycle events and
the additive shared API contract to the bot. Report-scoped logs always carry this pair with the internal
`reportId`; neither is replaced by a workflow-local value. Each retry report gets its own pair while the durable
predecessor/successor report relationship remains authoritative. Use a separate `spanId`/parent span
per stage and attempt; HTTP `requestId` identifies a request, not the entire report.

The email worker starts an independent ingestion trace; after trusted parsing/correlation the API links it to the report trace. Restricted Railway and Cloudflare structured logs include the exact internal `reportId` beside `traceId` once a report is known, allowing either UUID to be searched directly. Worker forwarding failures additionally send signed metadata-only events to the API ledger, correlated by alias; if the API is unavailable the Worker log remains the fallback. Operational logs may include Discord IDs, external Discord report IDs, generated reporter email aliases, and message URLs where needed for diagnostics, while keeping real credentials and verification codes protected. Validate inbound correlation fields as UUIDs; unknown or rejected mail remains searchable only by `messageIdDigest`. Both IDs remain access-controlled operational metadata, never metric labels. Additive DTO changes require updates to BOT_API.md and bot implementation documentation.

## Structured schema and error preservation

Use one allowlisted JSON logger per service: `schemaVersion`, UTC timestamp, severity, service, environment, commit/deployment, event, reportId, traceId, spanId, parentSpanId, stage, attempt, durationMs and outcome. `reportId` is emitted only for report-scoped work. Provider operations add provider, model, HTTP status, safe provider code, finish reason, token counts and remaining deadline. Error events add stable errorCode, errorKind, retryable, submissionCertainty, nextAttemptDelayMs, errorFingerprint and selected safe stack locations.

Preserve typed errors/causes through writer, search and preparation wrappers. Translate them once to safe user-facing codes/messages at the API boundary. Distinguish rate limit, provider outage, incomplete output, schema validation, timeout/cancel, database failure and unknown internal error. Do not emit unsanitized arbitrary Error.message/cause or assume all errors took three attempts. Unknown failures receive a support reference and an internal safe fingerprint, not fabricated explanations.

Error and diagnostic logs across the bot and API may include error messages, causes, stack traces, and HTTP failure payloads to debug issues. Never log auth tokens, API keys, encryption secrets, proxy credentials, or session cookies. Apply access/retention policy to existing logs; do not export them into public tickets or silently delete historical evidence.

## Event vocabulary and lifecycle truth

Search Railway for `reportId:"<internal UUID>"` or `traceId:"<UUID>"`; retry chains begin at
`report_retry_completed` and follow `predecessorReportId`. Cloudflare uses `messageIdDigest` before the API
matches mail. Verification, ambiguous submission, receipt timeout, webhook retry, and bot-card retry records
retain stage, outcome, safe failure category, and the pair where a report exists.

Emit report.queued; job.claimed; stage.started/completed; job.retry_scheduled; job.failed; job.recovered; submission.started/confirmed/ambiguous; email.ingest.accepted/rejected; event.delivery.succeeded/failed; card.updated/update_failed; notification.sent/failed; reconciliation.completed/failed.

Every terminal attempt emits exactly one outcome with duration. Record queue wait at claim, and deadline remaining at provider start. Emit committed lifecycle transitions only after transaction success; use the existing transactional outbox where delivery guarantees matter. Logs describe execution, while API database/events remain lifecycle truth. A successful provider response is not a successful report. A bot notification failure is not a report submission failure.

Restore safe error logging to silent notification/reconciliation/lifecycle catches. Logger failure must never stop job processing; emissions must be bounded and nonthrowing. Keep successful HTTP access logs minimal; retain failure events unsampled. Sample routine heartbeats/access traffic, never lifecycle outcomes needed for incident reconstruction.

## Queue visibility and worker health

Separate preparation, Discord lifecycle and bot notification queues. Each snapshot reports readyPending, delayedPending, running, oldestReadyAgeMs, completion/retry/failure counts and worker busy/idle slots. Histograms cover queue wait, stage duration and end-to-end submission latency. Split lifecycle job type (verification/submit/appeal) and provider errors using bounded labels, not report/account IDs. Preserve existing queueLength compatibility; define it clearly before adding phase-specific fields. It must not be presented as a queue position.

The implemented API sampler emits `queue_snapshot` every 5 seconds to 5 minutes (60 seconds by
default) using one aggregate query. Samples are single-flight: interval ticks coalesce while a query
or log emission remains active, and shutdown clears the interval and drains that active sample before
the API closes its database. It separates preparation and lifecycle ready, delayed, running,
and oldest-ready age values and provides bounded lifecycle job-kind counts. Empty ages are `null`,
clock-skewed ages are clamped to zero, and repository/logger failures cannot stop later samples or
workers. Completion/retry/failure rates, busy-slot counts, and bot-queue aggregation remain future work.

Emit worker heartbeats with last-progress age and active-stage age. Alert separately for no worker, slow dependency, growing ready backlog, delayed retries and notification lag. Measure actual configured concurrency at startup as a safe integer; current connector access did not reveal its production value.

Reliability changes to accompany observability, subject to implementation review: propagate one deadline/abort signal through writer, provider and search requests; bound database operations; ensure late completion cannot commit after lease expiry; heartbeat/fence claimed jobs; schedule maintenance independently of long jobs; prevent appeal waits from blocking unrelated work. Measure throughput/provider limits before increasing concurrency. Do not retry ambiguous final Discord submissions.

## Dashboards and provisional alerts

First use Railway structured-log filters and periodic safe summary events. A trace view should order API preparation → submission → email decision → webhook → bot card/reply. Fleet view shows queue age/depth, active workers, throughput, timeout/error kinds, provider latency, retry delays and notification/reconciliation lag.

Initial proposed thresholds (tune from measured baseline, not an established SLO): oldest ready work >120 seconds for 5 minutes; backlog with no completions for 120 seconds; heartbeat absent for 60 seconds; preparation timeout rate >5% with at least 20 attempts over 10 minutes; terminal bot delivery lag >120 seconds. Avoid paging on one retryable 429. Include service/commit/stage/trace reference and next diagnostic action, never report content.

No new user-facing “still queued after five minutes” explanation is proposed. Queue visibility and internal alerts are separate concerns.

## Delivery plan and acceptance gates

1. Error taxonomy & diagnostics: preserve error causes, enable diagnostic payload logging for failures while protecting credentials, convert known-defect tests to ordinary tests after fixes.
2. Correlation: additive persisted trace fields and shared contracts, API/event/bot propagation. Test webhook/reconciliation/retry flows across boundaries and backwards compatibility. Deploy API and bot together as required by contract changes.
3. Queue/worker instrumentation: safe startup configuration, phase metrics, progress heartbeats and loop errors. Run controlled saturation/restart tests with fake provider dependencies and disposable PostgreSQL.
4. Reliability: cancellation, maintenance scheduling, leases/fencing and delivery idempotency. Prove no duplicate final submissions and progress under slow/failing dependencies before production rollout.
5. Controlled deployment: compare queue-wait/timeout/throughput distributions with the baseline; verify a controlled report/card trace and rollback on regression. No mass retries or historical report resubmissions. Update operational docs, thresholds and runbook from observed behavior.

Runbook: identify deployment and time zone → locate failure event → follow trace/stage attempts → distinguish ready backlog, delayed retry and running dependency → confirm submission certainty → inspect bot delivery separately → choose a safe retry/recovery action only after checking durable state.
