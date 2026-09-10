# Task 4 report

Status: **DONE_WITH_CONCERNS**

## Files changed

- `packages/report-contracts/src/types.ts`, `packages/report-contracts/src/schemas.ts`, and contract tests
- `apps/api/src/report-repository.ts`, `preparation-worker.ts`, `lifecycle-runner-v2.ts`,
  `event-delivery-v2.ts`, `main.ts`, new `operational-observability.ts`, and focused tests
- `apps/bot/src/account-database.ts`, `account-notifier.ts`, `health.ts`, and focused tests
- `docs/BOT_API.md`, `docs/BOT_IMPLEMENTATION.md`, and `docs/OBSERVABILITY_PLAN.md`

## Red/green evidence

The inherited RED suite was reproduced before implementation: contracts were 17/17 green while
API had 196 green and 3 failing tests plus the missing sampler module, and bot had 46 green and 5
failing tests. Failures covered report UUID generation, event feed/webhook propagation, bot UUID
validation/inbox persistence/notifier logs, and the absent sampler. The final GREEN run is 32 test
files and 306 tests passing.

## Exact verification

- `npm.cmd test -w @nreport/contracts`
- `npm.cmd test -w @nreport/api -- test/report-repository.test.ts test/event-delivery-v2.test.ts test/operational-observability.test.ts test/lifecycle-runner-v2.test.ts test/preparation-worker.test.ts`
- `npm.cmd test -w @nreport/discord-dsa-bot -- test/account-overhaul.test.ts test/account-notifier.test.ts`
- `npm.cmd run lint` — exit 0
- `npm.cmd run typecheck` — exit 0 across all workspaces
- `npm.cmd test` — 32 files, 306 tests passed
- `npm.cmd run build` — exit 0 for contracts, client, API, and bot
- `npm.cmd run audit:high` — completed against the registry; reported the concern below

No live Discord or provider diagnostics were run.

## Migration and compatibility analysis

The API migration adds a nullable UUID column, backfills every existing report with
`gen_random_uuid()`, then installs the default, non-null constraint, and unique index. New reports
and retry reports also receive explicit server-generated `randomUUID()` values; request schemas do
not accept caller trace values.

The bot migration creates `trace_id` as non-null for fresh databases and additively adds it as
nullable on existing databases so historical inbox rows remain readable. Strict webhook validation
then requires a UUID for all newly accepted events, and every accepted event persists that UUID.
Deploying the bot before the API intentionally makes old trace-less envelopes fail with HTTP 400;
the API delivery outbox retains and retries them durably until the API is upgraded. The services
must therefore be deployed together in that order. Existing lifecycle execution-token fencing and
ambiguous-submission retry rules are unchanged.

## Self-review

- The trace is propagated through report rows, preparation claims, lifecycle jobs/reports and
  outcomes, event feed/webhook envelopes, bot inbox rows, notification logs, and reconciliation logs.
- Logs added here use the trace as their only high-cardinality correlation key and include bounded
  event/stage/outcome/duration/error fields without raw report, account, job, event, Discord user,
  message, evidence, secret, or provider payload values.
- `queueSnapshot()` uses one aggregate SQL query, separates ready/delayed/running work and null
  empty ages, clamps clock skew, and limits job-kind dimensions to the three supported kinds.
- Sampler, lifecycle, preparation, event-delivery, and bot logger callbacks are isolated so logging
  failure cannot stop durable work. Lifecycle job ownership remains fenced by execution token.

## Concern

`npm audit --audit-level=high` reports one existing high-severity transitive `nodemailer`
vulnerability through `mailparser`, plus three moderate Vitest advisories. This task does not change
dependency manifests or the lockfile; remediation should be handled as a separate dependency update.

## Commit

Scoped task commit: `feat: add trace and queue observability` (the exact hash is returned with the
task result).

## Review follow-up

The review findings were reproduced with new failing tests before implementation: the focused API
suite had 14 failures with 192 passes, and the focused bot suite had 4 failures with 47 passes.
Coverage demonstrated the missing persisted-trace handoff into the writer, alternate `actorKey`
correlation in provider logs, incomplete lifecycle/notifier outcome fields, overlapping sampler
queries, non-draining shutdown, and asynchronous logger rejection.

The API now passes each report's persisted `trace_id` through `PreparationWorker`,
`ReportPreparer`, `ApiReportPreparer`, `ReportWriter`, AI, search, workflow, and usage diagnostics.
Provider event names remain stable, `actorKey` has been removed, and provider operations use
`traceId` as their only report-level correlation key. Lifecycle and bot notification/reconciliation
events now consistently include bounded stage, outcome, and duration fields, with a safe category
on failures and no raw identifiers.

The queue sampler now coalesces interval ticks onto one in-flight sample. `stop()` clears the
interval and awaits the active database query and log emission before API database shutdown. Both
synchronous logger throws and asynchronous logger rejections are isolated. Focused verification is
206/206 API tests and 51/51 bot tests passing. The fresh full verification after these corrections
is lint exit 0, workspace typecheck exit 0, 32 test files with 309/309 tests passing, and build exit
0. The required high-severity audit completed and still reports the unchanged dependency concern
above: one high transitive `nodemailer` vulnerability and three moderate Vitest advisories. No live
Discord or provider diagnostics were run.
