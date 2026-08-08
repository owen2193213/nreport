# Experimental Batch Latest Outcomes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show the original targeted message once and the latest API, Discord, or appeal outcome for every item in the experimental batch aggregate DM.

**Architecture:** Keep the original message in the existing encrypted batch draft and decrypt it only while rendering the private aggregate DM. Add one nullable appeal-status column to batch items, persist all three authoritative lifecycle dimensions on create/observe/retry transitions, and use pure presentation helpers to select the latest user-facing outcome.

**Tech Stack:** TypeScript, PostgreSQL through `pg`, discord.js 14 embeds, `@discord-dsa/contracts`, Vitest.

## Global Constraints

- Keep one aggregate DM and continue suppressing individual batch lifecycle DMs.
- Show only the latest outcome per item, not a growing history.
- Outcome precedence is appeal status, Discord status, API status, then worker state.
- Read the original target only from the existing encrypted `ReportDraft.messageSnapshot`.
- Never persist message content in plaintext or include it in structured logs.
- Do not change credits, concurrency, create idempotency, lifecycle retry, or ambiguity behavior.
- Preserve the API/bot ownership boundary; no API endpoint or DTO changes are required.
- Keep every current message-category result and the reported-message preview within Discord embed limits.
- Update `docs/BOT_API.md` and `docs/BOT_IMPLEMENTATION.md`.

---

### Task 1: Pure latest-outcome and reported-message presentation

**Files:**
- Modify: `apps/bot/src/experimental-batch-ui.ts`
- Modify: `apps/bot/test/experimental-batches.test.ts`

**Interfaces:**
- Consumes: `ReportStatus`, `DiscordReportStatus`, `DiscordReviewStatus`, `MessageSnapshot`, and `ExperimentalBatchItemState`.
- Produces: `ExperimentalOutcomeInput`, `experimentalLatestOutcome(item: ExperimentalOutcomeInput): string`, `experimentalReportedMessage(snapshot: MessageSnapshot): string`, and extended aggregate display inputs `reportedMessage`, `lastStatus`, `lastDiscordStatus`, and `lastReviewStatus`.

- [ ] **Step 1: Write failing outcome-precedence tests**

Import the new helpers and add table-driven tests:

```ts
it.each([
  [{ state: "submitted", lastStatus: "submitted", lastDiscordStatus: null,
     lastReviewStatus: "approved" }, "Appeal accepted"],
  [{ state: "submitted", lastStatus: "submitted", lastDiscordStatus: "actioned",
     lastReviewStatus: null }, "Report accepted"],
  [{ state: "submitted", lastStatus: "submitted", lastDiscordStatus: "closed_no_action",
     lastReviewStatus: null }, "Report closed without action"],
  [{ state: "submitted", lastStatus: "submitted", lastDiscordStatus: "received",
     lastReviewStatus: null }, "Report received — awaiting decision"],
  [{ state: "submitted", lastStatus: "submitted", lastDiscordStatus: null,
     lastReviewStatus: null }, "Submitted — awaiting confirmation"],
  [{ state: "preparing", lastStatus: null, lastDiscordStatus: null,
     lastReviewStatus: null }, "Preparing with AI"]
] as const)("selects the authoritative latest outcome", (item, expected) => {
  expect(experimentalLatestOutcome(item)).toBe(expected);
});

it.each([
  ["queued", "Appeal preparing"],
  ["requested", "Appeal submitted — awaiting confirmation"],
  ["received", "Appeal received — awaiting decision"],
  ["confirmation_timeout", "Appeal submitted — confirmation not received"],
  ["request_failed", "Appeal failed"],
  ["ineligible", "Appeal unavailable"],
  ["request_ambiguous", "Appeal uncertain"],
  ["approved", "Appeal accepted"],
  ["not_approved", "Appeal denied"]
] as const)("renders review status %s", (lastReviewStatus, expected) => {
  expect(experimentalLatestOutcome({
    state: "submitted",
    lastStatus: "submitted",
    lastDiscordStatus: "actioned",
    lastReviewStatus
  })).toBe(expected);
});
```

- [ ] **Step 2: Write failing original-message and embed-limit tests**

Add a real `MessageSnapshot` fixture. Assert text is normalized and bounded, while an empty text
message becomes `No text content · 2 attachments · 1 embed`. Extend the complete-catalog embed test
with `reportedMessage: "Original targeted content"` and lifecycle fields, then assert the description
contains `Reported message` and the serialized character count remains at most 6,000.

```ts
expect(experimentalReportedMessage(snapshot)).toContain("Original targeted content");
expect(experimentalReportedMessage({
  ...snapshot, content: "", attachments: [attachment, attachment], embeds: [embed]
})).toBe("No text content · 2 attachments · 1 embed");
```

- [ ] **Step 3: Run the focused test and verify RED**

Run: `npm.cmd test -w @discord-dsa/bot -- experimental-batches.test.ts`

Expected: FAIL because the helpers and display fields do not exist.

- [ ] **Step 4: Implement the minimal pure presentation helpers**

Define `ExperimentalOutcomeInput` with exactly `state`, `lastStatus`, `lastDiscordStatus`, and
`lastReviewStatus`; make `ExperimentalBatchDisplayItem` extend it with its existing presentation
properties. Extend
`ExperimentalBatchDisplayView` with `reportedMessage: string | null`. Implement exact lookup maps for
all contract statuses. `experimentalLatestOutcome` must return the first available label using the
required precedence. `experimentalReportedMessage` must normalize CRLF, trim, use the attachment/embed
fallback, and truncate to 500 characters.

Append this to the embed description when present:

```ts
const reportedMessage = view.reportedMessage
  ? `\n\n**Reported message**\n${truncate(view.reportedMessage, 500)}`
  : "";
```

Replace the item's current state-only line with:

```ts
`Latest: **${experimentalLatestOutcome(item)}**`
```

- [ ] **Step 5: Run the focused test and verify GREEN**

Run: `npm.cmd test -w @discord-dsa/bot -- experimental-batches.test.ts`

Expected: PASS for all outcome, message-preview, and embed-limit tests.

- [ ] **Step 6: Commit the presentation layer**

```powershell
git add apps/bot/src/experimental-batch-ui.ts apps/bot/test/experimental-batches.test.ts
git commit -m "feat(bot): render latest batch outcomes"
```

---

### Task 2: Persist appeal status with each batch item

**Files:**
- Modify: `apps/bot/src/database.ts`
- Modify: `apps/bot/test/experimental-batches.test.ts`

**Interfaces:**
- Consumes: `ReportView.reviewStatus` on create, observe, and retry responses.
- Produces: `ExperimentalBatchWorkItemRow.last_review_status: DiscordReviewStatus | null` and an idempotent schema migration for `last_review_status text`.

- [ ] **Step 1: Write a failing persistence test**

Add a small fake `LifecyclePool` that records parameters for the
`UPDATE experimental_report_batch_items` query. Call `observeExperimentalBatchItem` with a report
whose `reviewStatus` is `approved` and assert the captured value is `approved`. Add equivalent
assertions for `markExperimentalSubmissionCreated` with `null` and
`trackExperimentalRetryReport` with `requested`.

```ts
await database.observeExperimentalBatchItem(
  "item-id",
  "tracking-id",
  report({ status: "submitted", discordStatus: "actioned", reviewStatus: "approved" }),
  0
);
expect(pool.lastBatchReviewStatus).toBe("approved");
```

- [ ] **Step 2: Run the persistence test and verify RED**

Run: `npm.cmd test -w @discord-dsa/bot -- experimental-batches.test.ts`

Expected: FAIL because batch items do not persist `reviewStatus`.

- [ ] **Step 3: Add the idempotent column and row type**

Add `last_review_status text` to the new-table definition and this migration for existing bot
databases:

```sql
ALTER TABLE experimental_report_batch_items
  ADD COLUMN IF NOT EXISTS last_review_status text;
```

Import `DiscordReviewStatus` and add this exact row property:

```ts
last_review_status: DiscordReviewStatus | null;
```

- [ ] **Step 4: Store review status in every authoritative transition**

Update `markExperimentalSubmissionCreated`, `observeExperimentalBatchItem`, and
`trackExperimentalRetryReport` so their item updates set `last_review_status` from
`report.reviewStatus`. Keep `report_tracking` unchanged because the batch item is the aggregate
presentation record and ordinary lifecycle rendering already fetches the authoritative API report.

- [ ] **Step 5: Run focused tests and typecheck**

Run:

```powershell
npm.cmd test -w @discord-dsa/bot -- experimental-batches.test.ts
npm.cmd run typecheck -w @discord-dsa/bot
```

Expected: both commands exit 0.

- [ ] **Step 6: Commit persistence**

```powershell
git add apps/bot/src/database.ts apps/bot/test/experimental-batches.test.ts
git commit -m "feat(bot): persist batch appeal outcomes"
```

---

### Task 3: Feed encrypted message and lifecycle state into aggregate refreshes

**Files:**
- Modify: `apps/bot/src/experimental-batch-worker.ts`
- Modify: `apps/bot/test/experimental-batches.test.ts`

**Interfaces:**
- Consumes: the extended `ExperimentalBatchWorkItemRow`, encrypted `ReportDraft`, and Task 1's `experimentalReportedMessage`.
- Produces: every aggregate refresh passes `reportedMessage` plus each item's three latest lifecycle fields to `experimentalBatchEmbed`.

- [ ] **Step 1: Write the failing worker refresh test**

Extend the existing single-aggregate-DM test with an encrypted draft containing a real
`messageSnapshot`, and a saved row containing:

```ts
last_status: "submitted",
last_discord_status: "actioned",
last_review_status: "approved"
```

Inspect the first sent embed and the subsequent edited embed. Assert both contain the original
message preview, and the edited item field contains `Appeal accepted`.

- [ ] **Step 2: Run the worker test and verify RED**

Run: `npm.cmd test -w @discord-dsa/bot -- experimental-batches.test.ts`

Expected: FAIL because the worker does not pass the message snapshot or lifecycle fields to the UI.

- [ ] **Step 3: Implement aggregate refresh mapping**

Import `experimentalReportedMessage`. In `performBatchRefresh`, decrypt `first.encrypted_draft` once:

```ts
let reportedMessage: string | null = null;
try {
  const draft = decryptJson<ReportDraft>(
    first.encrypted_draft,
    this.config.dataEncryptionKey
  );
  if (draft.messageSnapshot) {
    reportedMessage = experimentalReportedMessage(draft.messageSnapshot);
  }
} catch {
  reportedMessage = null;
}
```

Pass `row.last_status`, `row.last_discord_status`, and `row.last_review_status` into every display
item and pass `reportedMessage` into the batch view. Do not log decryption failures or message data.

- [ ] **Step 4: Run focused worker tests and verify GREEN**

Run: `npm.cmd test -w @discord-dsa/bot -- experimental-batches.test.ts`

Expected: PASS, including the existing one-message send/edit behavior.

- [ ] **Step 5: Commit worker integration**

```powershell
git add apps/bot/src/experimental-batch-worker.ts apps/bot/test/experimental-batches.test.ts
git commit -m "feat(bot): refresh batch lifecycle outcomes"
```

---

### Task 4: Canonical documentation and repository verification

**Files:**
- Modify: `docs/BOT_API.md`
- Modify: `docs/BOT_IMPLEMENTATION.md`

**Interfaces:**
- Consumes: the implemented message preview, lifecycle precedence, and same-message refresh behavior.
- Produces: operator documentation matching the deployed UI.

- [ ] **Step 1: Update the canonical docs**

Document that the aggregate card shows the bounded original target message once and that each item
shows its latest appeal, Discord, API, or worker outcome in that precedence. State that webhook and
feed events wake the item, fetch authoritative API detail, and edit the same aggregate DM.

- [ ] **Step 2: Check source and documentation consistency**

Run:

```powershell
rg -n "Reported message|latest outcome|last_review_status|experimentalLatestOutcome" apps/bot docs/BOT_API.md docs/BOT_IMPLEMENTATION.md
git diff --check
```

Expected: source, tests, and both canonical docs describe the same behavior with no whitespace
errors.

- [ ] **Step 3: Run required repository validation**

Run from the isolated worktree root:

```powershell
npm.cmd run lint
npm.cmd run typecheck
npm.cmd test
npm.cmd run build
npm.cmd run audit:high
```

Expected: every command exits 0. Do not run transport diagnostics.

- [ ] **Step 4: Review privacy and scope**

Run:

```powershell
git status --short
git diff --stat main...
git diff main... -- apps/bot docs/BOT_API.md docs/BOT_IMPLEMENTATION.md
```

Confirm there is no plaintext message-content column, raw message logging, API endpoint change,
protected diagnostic script change, or unrelated file.

- [ ] **Step 5: Commit documentation**

```powershell
git add docs/BOT_API.md docs/BOT_IMPLEMENTATION.md
git commit -m "docs: document batch latest outcomes"
```
