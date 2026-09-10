# Proposed coherent flow logging and queue monitoring

Status: correlation and aggregate queue sampling implemented, 2026-09-10; later dashboard, alert,
heartbeat, and broader span work remains proposed. Apply to the account-owned live API and separate
bot/email services. No new monitoring vendor or paid service is required for the initial rollout.
Preserve service/database ownership and avoid ambiguous Discord resubmission.

## Objectives

Answer for one report: where is it waiting, how long, which attempt/stage failed, is retry safe, was Discord submission confirmed, and did the bot update its card? Answer for the fleet: are queues progressing, where is capacity spent, and are user-visible errors increasing? Logs must not contain report evidence or credentials.

## One correlation model

Generate a random opaque `traceId` when the API creates a report and persist it. Propagate it through preparation/lifecycle jobs, durable lifecycle events and the additive shared API contract to the bot. Each retry report gets its own trace while the durable predecessor/successor report relationship remains authoritative. Use a separate `spanId`/parent span per stage and attempt; HTTP `requestId` identifies a request, not the entire report.

The email worker starts an independent ingestion trace; after trusted parsing/correlation the API links it to the report trace. Never expose aliases, verification codes, Discord IDs, raw report IDs or message URLs to achieve correlation. Validate inbound trace format/length and generate server-owned values when absent. Traces remain access-controlled operational metadata, never metric labels. Additive DTO changes require updates to BOT_API.md and bot implementation documentation.

## Structured schema and error preservation

Use one allowlisted JSON logger per service: `schemaVersion`, UTC timestamp, severity, service, environment, commit/deployment, event, traceId, spanId, parentSpanId, stage, attempt, durationMs and outcome. Provider operations add provider, model, HTTP status, safe provider code, finish reason, token counts and remaining deadline. Error events add stable errorCode, errorKind, retryable, submissionCertainty, nextAttemptDelayMs, errorFingerprint and selected safe stack locations.

Preserve typed errors/causes through writer, search and preparation wrappers. Translate them once to safe user-facing codes/messages at the API boundary. Distinguish rate limit, provider outage, incomplete output, schema validation, timeout/cancel, database failure and unknown internal error. Do not print arbitrary Error.message/cause or assume all errors took three attempts. Unknown failures receive a support reference and an internal safe fingerprint, not fabricated explanations.

Immediately replace raw `response` payload logging in AI error paths with selected counters/status fields. Never log prompts, generated text/reasoning, evidence, search query/results, raw mail, provider bodies, tokens, keys, proxy URLs, cookies or generated identities. Redaction helpers alone are insufficient; test actual emission with canary sensitive data. Apply access/retention policy to existing potentially sensitive logs; do not export them into tickets or silently delete historical evidence.

## Event vocabulary and lifecycle truth

Emit report.queued; job.claimed; stage.started/completed; job.retry_scheduled; job.failed; job.recovered; submission.started/confirmed/ambiguous; email.ingest.accepted/rejected; event.delivery.succeeded/failed; card.updated/update_failed; notification.sent/failed; reconciliation.completed/failed.

Every terminal attempt emits exactly one outcome with duration. Record queue wait at claim, and deadline remaining at provider start. Emit committed lifecycle transitions only after transaction success; use the existing transactional outbox where delivery guarantees matter. Logs describe execution, while API database/events remain lifecycle truth. A successful provider response is not a successful report. A bot notification failure is not a report submission failure.

Restore safe error logging to silent notification/reconciliation/lifecycle catches. Logger failure must never stop job processing; emissions must be bounded and nonthrowing. Keep successful HTTP access logs minimal; retain failure events unsampled. Sample routine heartbeats/access traffic, never lifecycle outcomes needed for incident reconstruction.

## Queue visibility and worker health

Separate preparation, Discord lifecycle and bot notification queues. Each snapshot reports readyPending, delayedPending, running, oldestReadyAgeMs, completion/retry/failure counts and worker busy/idle slots. Histograms cover queue wait, stage duration and end-to-end submission latency. Split lifecycle job type (verification/submit/appeal) and provider errors using bounded labels, not report/account IDs. Preserve existing queueLength compatibility; define it clearly before adding phase-specific fields. It must not be presented as a queue position.

The implemented API sampler emits `queue_snapshot` every 5 seconds to 5 minutes (60 seconds by
default) using one aggregate query. It separates preparation and lifecycle ready, delayed, running,
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

1. Privacy/error taxonomy: remove payload logging, preserve safe causes, convert known-defect tests to ordinary tests after fixes. Gate on canary non-disclosure and exact error classification.
2. Correlation: additive persisted trace fields and shared contracts, API/event/bot propagation. Test webhook/reconciliation/retry flows across boundaries and backwards compatibility. Deploy API and bot together as required by contract changes.
3. Queue/worker instrumentation: safe startup configuration, phase metrics, progress heartbeats and loop errors. Run controlled saturation/restart tests with fake provider dependencies and disposable PostgreSQL.
4. Reliability: cancellation, maintenance scheduling, leases/fencing and delivery idempotency. Prove no duplicate final submissions and progress under slow/failing dependencies before production rollout.
5. Controlled deployment: compare queue-wait/timeout/throughput distributions with the baseline; verify a controlled report/card trace and rollback on regression. No mass retries or historical report resubmissions. Update operational docs, thresholds and runbook from observed behavior.

Runbook: identify deployment and time zone → locate failure event → follow trace/stage attempts → distinguish ready backlog, delayed retry and running dependency → confirm submission certainty → inspect bot delivery separately → choose a safe retry/recovery action only after checking durable state.
