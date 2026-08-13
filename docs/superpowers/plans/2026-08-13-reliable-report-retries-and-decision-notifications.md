# Reliable Report Retries and Decision Notifications Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add restart-safe, safety-classified automatic report retries, one-card DM continuity, distinct detailed decision notifications, quick-report continuation, and correct ineligible-appeal recovery.

**Architecture:** The API remains authoritative for retry eligibility and enforces automatic/manual retry limits through an explicit retry mode. The bot durably orchestrates safe successor creation from its notification outbox, inherits its own encrypted tracking/display state, and routes every interaction through one status-card updater. Pure UI helpers render compact final-decision embeds and state-derived recovery controls.

**Tech Stack:** TypeScript, Node.js, Fastify, PostgreSQL, discord.js, Vitest, npm workspaces.

## Global Constraints

- A case has at most three total automatic lifecycle attempts: the original plus two automatic successors.
- Never automatically retry ambiguous final report/appeal POSTs, `discord_receipt_timeout`, deterministic failures, or `retryable: false`.
- A receipt-timeout case has exactly one manual retry opportunity across its chain.
- Reported-user mentions must use `allowedMentions: { parse: [] }` and never ping the target.
- Preserve API/bot database ownership boundaries and use `@discord-dsa/contracts` for shared HTTP types.
- Never log report context, message excerpts, usernames, raw email, verification codes, or secrets.
- Update `docs/BOT_API.md` for public behavior and `docs/BOT_IMPLEMENTATION.md` for operational behavior.

---

### Task 1: API Retry Modes and Server-Enforced Limits

**Files:**
- Modify: `packages/report-contracts/src/types.ts`
- Modify: `packages/report-contracts/src/api.ts`
- Modify: `packages/report-contracts/test/contracts.test.ts`
- Modify: `apps/api/src/server.ts`
- Modify: `apps/api/src/validation.ts`
- Modify: `apps/api/src/database.ts`
- Test: `apps/api/test/backend.test.ts`
- Test: `apps/api/test/server.test.ts`

**Interfaces:**
- Produces: `type ReportRetryMode = "automatic" | "manual"`.
- Produces: `DsaApi.retryReport(reportId, interactionId, userId, overrides?, mode?)`, defaulting to `manual` for existing callers and serializing `{ mode, ...overrides }`.
- Produces: API retry records with a required validated `mode` and database guards for automatic attempt and receipt-timeout limits.

- [ ] **Step 1: Write failing contract and API tests**

Add tests proving that `retryReport(..., undefined, "automatic")` sends `mode: "automatic"`, omitted mode sends `mode: "manual"`, automatic retry is rejected when `retry_sequence >= 2`, receipt timeout is rejected in automatic mode, and a second receipt-timeout retry in a rooted chain is rejected.

```ts
expect(JSON.parse(String(requestInit.body))).toMatchObject({
  submitterDiscordUserId: USER_ID,
  mode: "automatic"
});
expect(() => automaticRetryAtSequenceTwo()).rejects.toMatchObject({
  code: "report_not_retryable"
});
```

- [ ] **Step 2: Run focused tests and verify failure**

Run: `npm.cmd test -w @discord-dsa/contracts -- --run contracts.test.ts`

Run: `npm.cmd test -w @discord-dsa/api -- --run backend.test.ts server.test.ts`

Expected: FAIL because retry mode and chain-limit guards do not exist.

- [ ] **Step 3: Implement the minimal retry-mode contract and guards**

Validate the request body as:

```ts
interface RetryReportRequest {
  submitterDiscordUserId: string;
  mode: "automatic" | "manual";
  reportReason?: string;
  context?: string;
}
```

In the retry transaction, reject automatic mode unless `status === "failed"`, `retryable === true`, `error_code !== "discord_receipt_timeout"`, and `retry_sequence < 2`. For manual receipt-timeout retry, recursively identify the root and reject if any earlier report in that chain already has `error_code = 'discord_receipt_timeout'` and a successor.

- [ ] **Step 4: Run focused tests and verify pass**

Run the two commands from Step 2. Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add -- packages/report-contracts/src/types.ts packages/report-contracts/src/api.ts packages/report-contracts/test/contracts.test.ts apps/api/src/server.ts apps/api/src/validation.ts apps/api/src/database.ts apps/api/test/backend.test.ts apps/api/test/server.test.ts
git commit -m "feat(api): enforce safe retry limits"
```

### Task 2: Terminal Ineligible Appeals Become Resubmittable

**Files:**
- Modify: `apps/api/src/database.ts`
- Modify: `apps/api/src/job-runner.ts`
- Test: `apps/api/test/backend.test.ts`
- Test: `apps/api/test/job-runner.test.ts`

**Interfaces:**
- Produces: `review_status = "ineligible"` maps to `appealRetryable: false` and `resubmittable: true`.
- Consumes: the existing `521004` one-confirmation-attempt classifier.

- [ ] **Step 1: Write failing tests**

Assert an ineligible report view has `appealRetryable === false` and `resubmittable === true`, and that `retryReviewIneligible` rejects after the confirmation attempt.

```ts
expect(reportToView(ineligibleRow)).toMatchObject({
  appealRetryable: false,
  resubmittable: true
});
```

- [ ] **Step 2: Run focused tests and verify failure**

Run: `npm.cmd test -w @discord-dsa/api -- --run backend.test.ts job-runner.test.ts`

Expected: FAIL because ineligibility currently exposes appeal retry.

- [ ] **Step 3: Change only terminal-state mapping and stale-request validation**

Keep the existing single internal confirmation attempt for Discord code `521004`. Once persisted as ineligible, make the ordinary fresh-report resubmission path available and make the appeal retry endpoint return `review_not_retryable`.

- [ ] **Step 4: Re-run focused tests and commit**

Run the command from Step 2. Expected: PASS.

```powershell
git add -- apps/api/src/database.ts apps/api/src/job-runner.ts apps/api/test/backend.test.ts apps/api/test/job-runner.test.ts
git commit -m "fix(api): make ineligible appeals resubmittable"
```

### Task 3: Durable Bot Automatic-Retry Orchestration

**Files:**
- Modify: `apps/bot/src/database.ts`
- Modify: `apps/bot/src/notifier.ts`
- Test: `apps/bot/test/bot.test.ts`

**Interfaces:**
- Produces: `BotDatabase.trackAutomaticRetry(predecessorTrackingId, interactionKey, report): Promise<string>`.
- Produces: successor tracking that copies encrypted request, AI decisions, snapshots, quick-report mode, DM preference, and `status_dm_message_id` transactionally.
- Consumes: `DsaApi.retryReport(..., undefined, "automatic")` from Task 1.

- [ ] **Step 1: Write failing database and notifier tests**

Cover safe failure at sequences 0 and 1, no retry at sequence 2, no retry for receipt timeout/unsafe failure, duplicate event replay, inherited status DM, and terminal reply only after retry exhaustion.

```ts
expect(api.retryReport).toHaveBeenCalledWith(
  failed.internalReportId,
  `auto:${event.eventId}`,
  USER_ID,
  undefined,
  "automatic"
);
expect(statusMessage.reply).not.toHaveBeenCalled();
```

- [ ] **Step 2: Run bot tests and verify failure**

Run: `npm.cmd test -w @discord-dsa/bot -- --run bot.test.ts`

Expected: FAIL because failure notifications do not create durable successors.

- [ ] **Step 3: Implement transactional tracking inheritance**

Add a narrow database method that locks the predecessor tracking row, upserts the successor by stable interaction key, copies bot-owned encrypted/display columns and saved DM ID, and returns the existing tracking ID on replay.

- [ ] **Step 4: Implement notifier orchestration before rendering failure**

In `deliverNotifications`, branch on `report_failed`: attempt an automatic successor only when API state satisfies the safety boundary. Complete the predecessor notification after successor tracking succeeds; enqueue/observe the successor through existing mechanisms. Let thrown transient errors leave the notification job retryable.

- [ ] **Step 5: Re-run bot tests and commit**

Run the command from Step 2. Expected: PASS.

```powershell
git add -- apps/bot/src/database.ts apps/bot/src/notifier.ts apps/bot/test/bot.test.ts
git commit -m "feat(bot): orchestrate safe automatic report retries"
```

### Task 4: One Status Card Across Every Report Path

**Files:**
- Modify: `apps/bot/src/interactions.ts`
- Modify: `apps/bot/src/database.ts`
- Test: `apps/bot/test/bot.test.ts`

**Interfaces:**
- Produces: a single interaction delivery helper returning `"current" | "stored" | "created" | "unavailable"`.
- Consumes: inherited successor `status_dm_message_id` from Task 3.

- [ ] **Step 1: Write failing interaction tests**

Test DM-originated retry, slash-command retry, resend-as-is, rewrite-and-resend, ordinary submit, quick submit, and deleted saved-card replacement. In the DM-originated cases assert no `user.send` and full history in `interaction.editReply`.

```ts
expect(user.send).not.toHaveBeenCalled();
expect(JSON.stringify(editReply.mock.calls[0]?.[0])).not.toContain(
  "Check your DMs for the full status log."
);
```

- [ ] **Step 2: Run bot tests and verify failure**

Run: `npm.cmd test -w @discord-dsa/bot -- --run bot.test.ts`

Expected: FAIL on retry/resubmission paths that unconditionally send a second DM.

- [ ] **Step 3: Extract and apply the shared delivery rule**

Replace unconditional `sendReportDm` plus `history: "dm_notice"` combinations with one helper that compares the source interaction message ID to the saved status ID, edits the current DM when equal, edits the stored card when different, and creates only when absent. On Discord `10008`, create and persist one replacement.

- [ ] **Step 4: Re-run bot tests and commit**

Run the command from Step 2. Expected: PASS.

```powershell
git add -- apps/bot/src/interactions.ts apps/bot/src/database.ts apps/bot/test/bot.test.ts
git commit -m "fix(bot): preserve one report status DM"
```

### Task 5: Compact, Distinct Decision Embeds

**Files:**
- Modify: `apps/bot/src/ui.ts`
- Modify: `apps/bot/src/notifier.ts`
- Test: `apps/bot/test/bot.test.ts`

**Interfaces:**
- Produces: `reportDecisionEmbed(eventType, report, snapshot): EmbedBuilder | null`.
- Produces: `isAppealAcceptance(report): boolean`, based on authoritative review state/timeline.

- [ ] **Step 1: Write failing pure-render and delivery tests**

Cover report accepted, appeal accepted, report denied, appeal denied, captured/unavailable message evidence, profile target, and server target. Assert title, category, link/excerpt, mention/display/username, and empty allowed mentions.

```ts
expect(embed.toJSON()).toMatchObject({ title: "Appeal accepted" });
expect(JSON.stringify(embed.toJSON())).toContain(`<@${AUTHOR_ID}>`);
expect(reply).toHaveBeenCalledWith(expect.objectContaining({
  allowedMentions: { parse: [] }
}));
```

- [ ] **Step 2: Run bot tests and verify failure**

Run: `npm.cmd test -w @discord-dsa/bot -- --run bot.test.ts`

Expected: FAIL because decisions are plain text and `actioned` is not appeal-aware.

- [ ] **Step 3: Implement sanitized compact rendering**

Reuse existing category, target, snapshot, truncation, and message-author helpers. Limit the message excerpt to a concise embed-safe length, strip control/format Unicode through the existing sanitization utility, and never invent missing evidence. Replace `lifecycleReplyText` for final accepted/denied events with the embed renderer while retaining concise text for non-decision failure events.

- [ ] **Step 4: Re-run bot tests and commit**

Run the command from Step 2. Expected: PASS.

```powershell
git add -- apps/bot/src/ui.ts apps/bot/src/notifier.ts apps/bot/test/bot.test.ts
git commit -m "feat(bot): add detailed decision notifications"
```

### Task 6: Quick-Report Retry Continuation and Ineligible Controls

**Files:**
- Modify: `apps/bot/src/types.ts`
- Modify: `apps/bot/src/interactions.ts`
- Modify: `apps/bot/src/ui.ts`
- Modify: `apps/bot/src/database.ts`
- Test: `apps/bot/test/bot.test.ts`

**Interfaces:**
- Produces: `ReportDraft.quickSubmit?: boolean` persisted in the encrypted draft/tracking metadata.
- Produces: bounded `generateQuickReport` loop with three total attempts only for classified transient writer failures.
- Consumes: `resubmittable` ineligible state from Task 2.

- [ ] **Step 1: Write failing quick-flow and control tests**

Assert two transient writer failures followed by success calls create-report immediately, three transient failures stop, deterministic failures do not retry, and ineligible reports render **Send as is** plus **Rewrite & send** without **Retry appeal**. Assert a stale retry-appeal button is rejected.

```ts
expect(reportWriter.generate).toHaveBeenCalledTimes(3);
expect(api.createReport).toHaveBeenCalledOnce();
expect(JSON.stringify(controls)).not.toContain("retry-appeal");
```

- [ ] **Step 2: Run bot tests and verify failure**

Run: `npm.cmd test -w @discord-dsa/bot -- --run bot.test.ts`

Expected: FAIL because quick generation falls back to a manual regenerate card and ineligible state prioritizes appeal retry.

- [ ] **Step 3: Implement bounded quick continuation and state-derived controls**

Set `quickSubmit: true` when the context-menu quick flow creates its draft. Retry only writer errors classified as transient, preserve the same draft/DM progress card, and call `submitQuickDraft` immediately after success. Order `reportRetryComponents` so ineligible/resubmittable state yields **Send as is** (`reports:retry`) and **Rewrite & send** (`reports:rewrite`) and never appeal retry.

- [ ] **Step 4: Re-run bot tests and commit**

Run the command from Step 2. Expected: PASS.

```powershell
git add -- apps/bot/src/types.ts apps/bot/src/interactions.ts apps/bot/src/ui.ts apps/bot/src/database.ts apps/bot/test/bot.test.ts
git commit -m "feat(bot): continue quick reports through safe retries"
```

### Task 7: Documentation and Full Verification

**Files:**
- Modify: `docs/BOT_API.md`
- Modify: `docs/BOT_IMPLEMENTATION.md`

**Interfaces:**
- Documents: retry mode, three-attempt ceiling, receipt-timeout manual limit, DM continuity, decision embeds, quick continuation, and ineligible appeal actions.

- [ ] **Step 1: Update canonical documentation**

Document the exact automatic/manual retry request shape and response/error behavior in `BOT_API.md`. Document the bot outbox orchestration, single-card routing, decision embed fields, quick behavior, and notification copy in `BOT_IMPLEMENTATION.md`.

- [ ] **Step 2: Run scoped and repository-wide verification**

```powershell
npm.cmd run lint
npm.cmd run typecheck
npm.cmd test
npm.cmd run build
npm.cmd run audit:high
git diff --check
```

Expected: every command exits 0. Do not run transport diagnostics.

- [ ] **Step 3: Review only intended files and commit docs**

```powershell
git status --short
git diff -- docs/BOT_API.md docs/BOT_IMPLEMENTATION.md
git add -- docs/BOT_API.md docs/BOT_IMPLEMENTATION.md
git commit -m "docs: document reliable report recovery"
```

- [ ] **Step 4: Use verification-before-completion, review the complete branch diff, merge, and push**

Confirm the full suite output is fresh, inspect `git diff main...HEAD --stat` and `git diff main...HEAD`, merge the branch into `main` without staging unrelated untracked files, rerun a post-merge status check, and push `main` to the configured GitHub remote.
