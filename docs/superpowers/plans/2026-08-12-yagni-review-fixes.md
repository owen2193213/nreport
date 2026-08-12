# YAGNI Review Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Correct the confirmed analytics and notification bugs while documenting the digest worker's intentional at-least-once delivery guarantee.

**Architecture:** Keep the existing API and database contracts. Simplify the bot UI by removing cursor state, refresh notification preferences at the last responsible moment, and make chart rendering treat missing samples as gaps.

**Tech Stack:** TypeScript 6, discord.js 14, PostgreSQL, Vitest 4, `@napi-rs/canvas`.

## Global Constraints

- Do not add tables, distributed locks, Discord delivery tokens, or new dependencies.
- Keep all Discord interaction responses ephemeral.
- Preserve API/bot database ownership boundaries.
- Use test-first red-green cycles for production behavior changes.
- Do not edit protected Python diagnostics or unrelated untracked files.

---

### Task 1: Bound Action History Without Pagination

**Files:**
- Modify: `apps/bot/test/analytics.test.ts`
- Modify: `apps/bot/src/analytics-ui.ts`
- Modify: `apps/bot/src/interactions.ts`

**Interfaces:**
- Consumes: `DsaApi.actionHistory()` and `ActionHistoryPage`.
- Produces: one ephemeral Action History view containing at most 25 results and no cursor controls.

- [ ] **Step 1: Write failing tests**

Change the history component test to assert that a non-null API cursor never appears in serialized components. Change preset and custom-range interaction tests to assert `limit: 25`, with the custom test asserting the exact `startAt` and `endAt` values.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npm.cmd test -w @discord-dsa/bot -- analytics.test.ts`

Expected: FAIL because the current UI includes short cursors and both handlers request 10 rows.

- [ ] **Step 3: Implement the minimum change**

Remove the optional cursor parameter and Next-page row from `analyticsComponents()`. Stop passing `page.nextCursor` from `actionHistoryView()`. Request `limit: 25` from both history handlers and ignore any legacy cursor segment in a component ID.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run: `npm.cmd test -w @discord-dsa/bot -- analytics.test.ts`

Expected: PASS.

### Task 2: Reload Notification Preferences at Delivery

**Files:**
- Modify: `apps/bot/test/notification-preferences.test.ts`
- Modify: `apps/bot/src/notifier.ts`

**Interfaces:**
- Consumes: `BotDatabase.getNotificationPreferences(userId)`.
- Produces: lifecycle delivery decisions based on preferences read immediately before delivery.

- [ ] **Step 1: Write the failing test**

Configure the claimed job snapshot with `actioned: true`, make `getNotificationPreferences()` return `actioned: false`, and assert the real worker suppresses the job before API or Discord fetches.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npm.cmd test -w @discord-dsa/bot -- notification-preferences.test.ts`

Expected: FAIL because the worker currently trusts the claimed snapshot and attempts `api.report()`.

- [ ] **Step 3: Implement the minimum change**

Call `getNotificationPreferences(job.discord_user_id)` after the lifecycle allowlist check and use that result with `allowsLifecycleNotification()`. Do not change claim SQL or outbox schema.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run: `npm.cmd test -w @discord-dsa/bot -- notification-preferences.test.ts`

Expected: PASS.

### Task 3: Render Missing Reply Samples as Gaps

**Files:**
- Modify: `apps/bot/test/analytics.test.ts`
- Modify: `apps/bot/src/analytics-charts.ts`

**Interfaces:**
- Consumes: `ReportAnalytics.series[].medianReplySeconds`.
- Produces: PNG charts whose reply-time series omit null points instead of plotting zero.

- [ ] **Step 1: Write the failing test**

Export a small pure `chartValues(chart, analytics)` helper and assert that reply-time input `[3600, null, 7200]` returns `[1, null, 2]`, while volume values remain numeric.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npm.cmd test -w @discord-dsa/bot -- analytics.test.ts`

Expected: FAIL because `chartValues` does not exist and current rendering converts null to zero.

- [ ] **Step 3: Implement the minimum change**

Return `Array<number | null>` from `chartValues()`. Compute maxima from known values only. When drawing, start a new path after each null and draw circles only for known points. Render the existing no-data message when no known values exist.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run: `npm.cmd test -w @discord-dsa/bot -- analytics.test.ts`

Expected: PASS.

### Task 4: Document Digest Delivery Semantics and Verify

**Files:**
- Modify: `docs/BOT_IMPLEMENTATION.md`

**Interfaces:**
- Consumes: existing digest job send-then-complete behavior.
- Produces: an operator-visible statement that scheduled digest delivery is at-least-once.

- [ ] **Step 1: Update documentation**

State that a process or database failure after Discord accepts a DM but before job completion can produce a duplicate retry, and that this small window is retained to avoid silently losing digests.

- [ ] **Step 2: Run repository verification**

Run in order:

```powershell
npm.cmd run lint
npm.cmd run typecheck
npm.cmd test
npm.cmd run build
npm.cmd run audit:high
git diff --check
```

Expected: all commands exit 0; Vitest reports zero failed test files.

- [ ] **Step 3: Inspect scope and commit**

Run `git status --short`, confirm unrelated untracked files remain unstaged, stage only the files named in this plan, and commit with `fix(bot): apply YAGNI analytics and notification fixes`.
