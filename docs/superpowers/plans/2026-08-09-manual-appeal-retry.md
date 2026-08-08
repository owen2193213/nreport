# Manual Appeal Retry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Retry Discord appeal ineligibility once after 10 seconds and let owners safely requeue a definitively ineligible appeal from a private button.

**Architecture:** Keep review URLs exclusively in the API's encrypted review-job payload. Extend the existing job retry path for the first `521004`, add one transactional API action that requeues the completed review job with idempotency and cooldown protection, and expose only an `appealRetryable` capability to the bot.

**Tech Stack:** TypeScript, Fastify, PostgreSQL, Discord.js, Vitest, npm workspaces

## Global Constraints

- The first `521004` schedules exactly one retry after 10 seconds; the second persists `ineligible`.
- Each manual click starts the same two-attempt cycle and leaves the button available after another definitive ineligible result.
- Only `ineligible` appeals are manually retryable; ambiguous submissions must never be retried.
- The API owns and retains encrypted review URLs; links and tokens never enter bot responses or logs.
- Manual retries charge no credit and do not create a new report.
- All bot interaction responses remain ephemeral and all status controls remain private.

---

### Task 1: Automatic ten-second ineligibility retry

**Files:**
- Modify: `apps/api/test/job-runner.test.ts`
- Modify: `apps/api/src/job-runner.ts`

**Interfaces:**
- Consumes: `isReviewIneligible(error)` and `Database.retryJob(job, message, delaySeconds)`.
- Produces: first-attempt `521004` rescheduling with `delaySeconds === 10`; second-attempt terminal `markReviewIneligible` behavior.

- [ ] **Step 1: Write the failing worker tests**

Add one test whose job has `attempts: 1` and whose review POST throws code `521004`; assert that
`retryJob` receives 10 seconds and `markReviewIneligible` is not called. Keep the existing terminal
test with `attempts: 2` and assert that it marks ineligible without calling `retryJob`.

- [ ] **Step 2: Run the focused worker tests and verify RED**

Run: `npm.cmd test -w @discord-dsa/api -- job-runner.test.ts`
Expected: the new first-attempt test fails because `521004` is finalized immediately.

- [ ] **Step 3: Implement the minimal worker branch**

Introduce an internal signal for first-attempt ineligibility. Before persisting an ineligible result,
raise that signal when `job.attempts < 2`; in `processJob`, catch it and call
`database.retryJob(job, safeMessage, 10)` without completing the job. Preserve all existing network,
rate-limit, ambiguous-POST, and already-requested behavior.

- [ ] **Step 4: Run the focused worker tests and verify GREEN**

Run: `npm.cmd test -w @discord-dsa/api -- job-runner.test.ts`
Expected: PASS.

### Task 2: Transactional manual appeal requeue

**Files:**
- Modify: `apps/api/test/backend.test.ts`
- Modify: `apps/api/src/database.ts`

**Interfaces:**
- Produces: `Database.retryIneligibleReview(input: { reportId: string; submitterDiscordUserId: string; idempotencyKey: string }): Promise<{ replayed: boolean; report: ReportRow }>`.
- Produces: `ReviewRetryError` with codes `report_not_found`, `report_owner_mismatch`, `review_not_ineligible`, `review_retry_unavailable`, and `review_retry_cooldown`.
- Produces: `appealRetryable(report: ReportRow): boolean` for response mapping.

- [ ] **Step 1: Write failing database tests**

Cover owner rejection, non-ineligible rejection, missing retained `submit_review` job rejection,
successful requeue, duplicate idempotency replay, pending-attempt exclusion, and a 30-second cooldown
between distinct manual requests. Assert a successful transaction resets the job to `pending`,
`attempts = 0`, `run_at = now()`, clears safe job errors, changes the report to `queued`, clears review
errors/deadline, and records a `review_queued` lifecycle event without exposing the payload.

- [ ] **Step 2: Run the focused database tests and verify RED**

Run: `npm.cmd test -w @discord-dsa/api -- backend.test.ts`
Expected: FAIL because the manual review-retry API does not exist.

- [ ] **Step 3: Add durable idempotency and cooldown state**

Add nullable `review_retry_idempotency_key text` and `review_retry_requested_at timestamptz` columns
to the reports table definition and idempotent migrations. Add them to `ReportRow`.

- [ ] **Step 4: Implement the transaction**

Lock the report, validate owner and current `ineligible` state, return a replay when the same key was
already accepted, enforce 30 seconds since `review_retry_requested_at`, lock the retained
`submit_review` job, require it to be completed or failed, reset it for a new two-attempt cycle, set
the report to `queued`, store the key/time, emit `review_queued`, and commit.

- [ ] **Step 5: Run the focused database tests and verify GREEN**

Run: `npm.cmd test -w @discord-dsa/api -- backend.test.ts`
Expected: PASS.

### Task 3: Shared contract and authenticated endpoint

**Files:**
- Modify: `packages/report-contracts/src/types.ts`
- Modify: `packages/report-contracts/src/api.ts`
- Modify: `packages/report-contracts/test/contracts.test.ts`
- Modify: `apps/api/src/server.ts`
- Modify: `apps/api/test/backend.test.ts`

**Interfaces:**
- Produces: `ReportView.appealRetryable: boolean`.
- Produces: `DsaApi.retryAppeal(internalReportId: string, interactionId: string, discordUserId: string): Promise<ReportDetail>`.
- Produces: `POST /v1/reports/:id/retry-appeal` with body `{ submitterDiscordUserId }` and idempotency key `appeal-retry:<interactionId>`.

- [ ] **Step 1: Write failing contract and route tests**

Assert the client sends the exact method, path, body, content type, and idempotency key. Assert the
route returns 202 for a new enqueue, 200 for replay, 403 for owner mismatch, 409 for invalid state or
cooldown, 404 for a missing report, and includes `appealRetryable` in report responses.

- [ ] **Step 2: Run contract and API tests and verify RED**

Run: `npm.cmd test -w @discord-dsa/contracts`

Run: `npm.cmd test -w @discord-dsa/api -- backend.test.ts`

Expected: FAIL for the missing method, field, and route.

- [ ] **Step 3: Implement the contract and route**

Add the required boolean field and client method. Parse and validate the Discord owner snowflake,
validate the idempotency header exactly like report retry, call `retryIneligibleReview`, log only
safe report/replay metadata, map `ReviewRetryError`, and return the updated public report.

- [ ] **Step 4: Run contract and API tests and verify GREEN**

Run: `npm.cmd test -w @discord-dsa/contracts`

Run: `npm.cmd test -w @discord-dsa/api -- backend.test.ts`

Expected: PASS.

### Task 4: Private bot retry control

**Files:**
- Modify: `apps/bot/test/bot.test.ts`
- Modify: `apps/bot/src/ui.ts`
- Modify: `apps/bot/src/interactions.ts`

**Interfaces:**
- Consumes: `ReportView.appealRetryable` and `DsaApi.retryAppeal(...)`.
- Produces: a `reports:retry-appeal:<internalReportId>` button labeled `Retry appeal` and an interaction handler that refreshes the private status payload.

- [ ] **Step 1: Write failing UI and interaction tests**

Assert only an ineligible report with `appealRetryable: true` receives the exact button. Assert a
button click defers privately, fetches and verifies the report owner, calls `retryAppeal` with the
interaction ID and actor ID, and edits the status response with `Appeal queued for another attempt.`
and no retry-appeal button while queued.

- [ ] **Step 2: Run the focused bot tests and verify RED**

Run: `npm.cmd test -w @discord-dsa/bot -- bot.test.ts`
Expected: FAIL because the control and handler do not exist.

- [ ] **Step 3: Implement the button and handler**

Give appeal retry precedence as its own control row without changing failed-report or denied-review
resubmission behavior. Handle `reports:retry-appeal`, assert ownership before mutation, call the API,
then edit the private source/status response with the refreshed embed and components. Do not charge
credits or create bot tracking rows.

- [ ] **Step 4: Run the focused bot tests and verify GREEN**

Run: `npm.cmd test -w @discord-dsa/bot -- bot.test.ts`
Expected: PASS.

### Task 5: Canonical documentation and full verification

**Files:**
- Modify: `docs/BOT_API.md`
- Modify: `docs/BOT_IMPLEMENTATION.md`
- Modify: `README.md`

**Interfaces:**
- Documents the endpoint, capability flag, 10-second automatic retry, 30-second manual cooldown,
  repeated button availability, and ambiguous-submission exclusion.

- [ ] **Step 1: Update canonical documentation**

Describe the exact request/response semantics and user-visible control. Replace the README statement
that an eligible appeal is submitted only once with the new bounded ineligibility retry semantics
while preserving the prohibition on repeating ambiguous POSTs.

- [ ] **Step 2: Run repository-required verification**

Run: `npm.cmd run lint`

Run: `npm.cmd run typecheck`

Run: `npm.cmd test`

Run: `npm.cmd run build`

Run: `npm.cmd run audit:high`

Expected: all commands exit 0 with no new warnings attributable to the change.

- [ ] **Step 3: Inspect scope and privacy**

Run: `git diff --check`

Run: `git status --short`

Run: `git diff -- apps/api apps/bot packages/report-contracts README.md docs/BOT_API.md docs/BOT_IMPLEMENTATION.md`

Expected: only the scoped TypeScript, tests, canonical docs, spec, and plan changed; no Python
diagnostics, secrets, review URLs, tokens, proxy values, raw email, or report context appear.
