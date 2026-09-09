# Queue, Preparation, and Observability Reliability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the confirmed preparation error-loss and cancellation defects, prevent one slow lifecycle job from stalling all work, make notification failures diagnosable and safely retryable, remove unsafe payload logging, and close the high-severity dependency audit finding.

**Architecture:** Keep the API as lifecycle authority and the bot as Discord-card owner. Preserve typed safe errors across API layers; carry a cancellation signal to every provider request; run bounded independent lifecycle loops with maintenance separated from work; emit allowlisted structured events with pseudonymous correlation. Preserve the rule that ambiguous final Discord submissions are never automatically retried.

**Tech Stack:** TypeScript 6, Node.js, Vitest, Fastify, PostgreSQL, Discord.js, npm workspaces.

**Spec:** `docs/REGRESSION_AUDIT_2026-09-09.md` and `docs/OBSERVABILITY_PLAN.md`

## Global Constraints

- Never log report evidence, prompts, generated text or reasoning, search queries/results, raw provider bodies/mail, verification codes, credentials, cookies, proxy URLs, generated identities, or raw Discord/internal report identifiers.
- Do not automatically retry an ambiguous final Discord report or appeal submission.
- Maintain API/bot/database ownership boundaries and update `docs/BOT_API.md` or `docs/BOT_IMPLEMENTATION.md` when a visible contract or operational behavior changes.
- Every production change follows red-green TDD; known-defect tests must be observed failing normally before their `.fails` marker is removed.
- Queue length remains a count, never a position or wait-time promise. Do not add the previously rejected five-minute user explanation.
- No live Discord submission diagnostics.

---

### Task 1: Preserve preparation failures, propagate cancellation, and sanitize provider logs

**Files:**
- Modify: `apps/api/src/preparation/ai-client.ts`
- Modify: `apps/api/src/preparation/brave-research.ts`
- Modify: `apps/api/src/preparation/report-writer.ts`
- Modify: `apps/api/src/preparation/api-report-preparer.ts`
- Modify: `apps/api/src/preparation-worker.ts`
- Modify: `apps/api/src/preparation/observability.ts`
- Modify: `apps/api/test/preparation-pipeline.test.ts`
- Modify: `apps/api/test/ai-client.test.ts`
- Modify: `apps/api/test/brave-research.test.ts`
- Modify: `apps/api/test/report-writer.test.ts`

**Interfaces:**
- `ReportWriterError` produces a stable `kind` compatible with `AiClientErrorKind` plus research kinds, and keeps a safe `cause` only for internal chaining.
- `ReportWriter.generate(..., signal?: AbortSignal)` propagates cancellation through `AiClient.complete` and `BraveResearchClient.search`.
- Failure logs contain bounded metadata only; worker diagnostics contain `errorCode`, stage, and safe kind without raw messages.

- [ ] Remove `.fails` from the two pipeline reproductions and run them to verify the existing `preparation_failed`/`still-running` failures.
- [ ] Add tests that provider error/refusal/429/incomplete/malformed/timeout kinds survive writer → preparer → worker and that log serialization excludes canary response/reasoning/body strings.
- [ ] Add an optional abort signal to writer/provider methods and combine it with request deadlines using a helper that handles already-aborted signals.
- [ ] Preserve stable error kinds when wrapping AI and Brave failures; map validation failures to `malformed`, and retain safe public failure messages.
- [ ] Replace provider-response fields in failure logs with allowlisted values such as status, finish reason, response size, attempt, and provider code category.
- [ ] Run `npm.cmd test -- apps/api/test/preparation-pipeline.test.ts apps/api/test/ai-client.test.ts apps/api/test/brave-research.test.ts apps/api/test/report-writer.test.ts` and verify ordinary passes.
- [ ] Update the audit document to mark these defects fixed with command evidence.

### Task 2: Ensure lifecycle queue progress and independently scheduled maintenance

**Files:**
- Modify: `apps/api/src/config.ts`
- Modify: `apps/api/.env.example`
- Modify: `apps/api/src/lifecycle-runner-v2.ts`
- Modify: `apps/api/src/main.ts`
- Modify: `apps/api/src/report-repository.ts` only if phase-specific queue snapshots are required
- Modify: `apps/api/test/lifecycle-runner-v2.test.ts`
- Modify: `apps/api/test/accounts.test.ts`
- Modify: `docs/BOT_IMPLEMENTATION.md`

**Interfaces:**
- `LIFECYCLE_CONCURRENCY` is bounded 1..16, default 2, and starts that many independent claim loops.
- Maintenance has its own loop/timer and continues while lifecycle jobs run.
- `onIterationError` receives safe structured context (`worker`, optional job kind, error kind); errors do not kill loops.

- [ ] Add failing tests proving two jobs can make progress concurrently, a sleeping appeal does not block a request-code job, one failed job frees its slot, and maintenance runs while a job is stalled.
- [ ] Add config boundary tests for default, valid, zero, and >16 lifecycle concurrency.
- [ ] Refactor the runner into bounded job loops plus an independent maintenance loop; stopping awaits all loops without accepting new work.
- [ ] Emit safe job claimed/completed/retried/failed and maintenance failure events with duration/attempt/kind, without report identifiers.
- [ ] Retain single-submission boundary behavior and strengthen assertions that ambiguous results never call retry or submit again.
- [ ] Run focused lifecycle/config tests and update operational documentation.

### Task 3: Make bot notification/reconciliation failures observable and terminal replies idempotent

**Files:**
- Modify: `apps/bot/src/account-notifier.ts`
- Modify: `apps/bot/src/account-database.ts`
- Modify: `apps/bot/src/observability.ts`
- Modify: `apps/bot/test/account-notifier.test.ts`
- Modify: `apps/bot/test/account-overhaul.test.ts`
- Modify: `docs/BOT_IMPLEMENTATION.md`

**Interfaces:**
- Bot logs use allowlisted error name/code/status only; arbitrary `error.message` and raw validation arrays are excluded.
- Notification delivery records a durable decision-reply state/claim before completing an outbox event, so crash/retry cannot deliberately issue a second terminal reply.
- Silent loop/reconciliation catches emit bounded safe events and continue processing other accounts.

- [ ] Add failing tests for duplicate event delivery, crash/retry around reply acknowledgement, reconciliation failure isolation, and log canary exclusion.
- [ ] Add the smallest database state/transaction needed to claim/complete/release a decision reply and use it around `message.reply`.
- [ ] Log claimed/completed/retry/reconciliation outcomes with event type, attempt and safe error category, never IDs or report details.
- [ ] Ensure one account or Discord failure cannot stop later notification/reconciliation work.
- [ ] Run focused bot tests and update operational documentation.

### Task 4: Add coherent queue/flow summaries and contract tests

**Files:**
- Create: `apps/api/src/operational-observability.ts`
- Modify: `apps/api/src/report-repository.ts`
- Modify: `apps/api/src/main.ts`
- Modify: `apps/api/test/report-repository.test.ts`
- Create: `apps/api/test/operational-observability.test.ts`
- Modify: `docs/OBSERVABILITY_PLAN.md`

**Interfaces:**
- Repository returns bounded aggregate snapshots for preparation/lifecycle: ready pending, delayed pending, running, oldest ready age, grouped job kind; no per-report data.
- A periodic sampler emits queue snapshots and worker heartbeat/progress events; it never throws into workers.

- [ ] Add failing mapping tests for empty, delayed, active, and mixed queue snapshots and logger-failure isolation.
- [ ] Implement one aggregate SQL query and a sampler with injected clock/sleep/logger for deterministic tests.
- [ ] Start/stop it with workers and document Railway filters/events and provisional alert thresholds.
- [ ] Ensure high-cardinality IDs are absent from emitted summary fields.
- [ ] Run focused API tests.

### Task 5: Dependency remediation and complete release verification

**Files:**
- Modify: root `package-lock.json`
- Modify: `package.json` only if a direct safe version/override is needed
- Modify: `docs/REGRESSION_AUDIT_2026-09-09.md`

**Interfaces:**
- `npm audit --audit-level=high` exits zero; no unreviewed major runtime upgrade.

- [ ] Run `npm.cmd audit --json` and record dependency paths without copying secrets.
- [ ] Apply the minimal supported updates for mailparser/nodemailer and Vitest/@vitest-mocker; do not use forced major upgrades blindly.
- [ ] Run `npm.cmd ci`, lint, all-workspace typecheck, full tests, build, and high audit.
- [ ] Review the complete diff for architecture/privacy/idempotency and run a final independent code review.
- [ ] Update the audit with exact passing/expected-failure counts and any remaining non-release-blocking advisories.
