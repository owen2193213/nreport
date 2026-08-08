# Experimental Report Batches Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add two durable experimental message commands that create either ten same-category reports or one report per message category, reserve all credits atomically, retry safely, and aggregate every outcome in one DM card.

**Architecture:** The interaction handler only validates, reserves, enqueues, and acknowledges. New bot-owned PostgreSQL batch tables and an `ExperimentalBatchWorker` persist and process individual report pipelines with concurrency two; ordinary single-report `DsaApi` create/retry calls preserve the API boundary. Batch-linked tracking rows disable individual DMs, while lifecycle ingestion wakes the owning batch item so the worker updates the shared card.

**Tech Stack:** TypeScript, Node.js, discord.js 14, PostgreSQL through `pg`, Vitest, existing `ReportWriter` and `DsaApi`.

## Global Constraints

- Commands are named exactly `Experimental 10x Same Category` and `Experimental All Categories`.
- Same-category reserves exactly 10 credits and creates 10 distinct reports with one AI-selected `reportType`.
- All-categories snapshots `reportReasons("message_urf")` and reserves/creates exactly one item per captured category.
- A non-bypassed user must reserve the complete batch atomically before AI work; admins and `WHITELIST_ENABLED=false` preserve the existing bypass.
- Item-pipeline concurrency is exactly 2.
- AI preparation gets at most two total attempts; a created retryable report gets at most one lifecycle retry without another credit.
- Never automatically retry `ambiguous_submission_state` or any other API result with `retryable=false`.
- Every item has a stable, unique create idempotency identity derived from batch ID and ordinal.
- Sensitive message data, explanations, final context, and create inputs remain encrypted and never enter structured logs.
- The bot continues to call only existing single-report API endpoints through `@discord-dsa/contracts`.
- Update both `docs/BOT_API.md` and `docs/BOT_IMPLEMENTATION.md` for the bot-visible behavior.
- Do not edit protected Python diagnostics or run Discord transport diagnostics.

---

### Task 1: Batch domain model and deterministic helpers

**Files:**
- Modify: `apps/bot/src/types.ts`
- Create: `apps/bot/src/experimental-batches.ts`
- Create: `apps/bot/test/experimental-batches.test.ts`

**Interfaces:**
- Consumes: `ReportDraft`, `ReportDetail`, and message `ReportReason` catalog entries.
- Produces: `ExperimentalBatchMode`, `ExperimentalBatchItemState`, `ExperimentalBatchRecord`, `ExperimentalBatchItemRecord`, `experimentalBatchDefinitions(mode, reasons)`, `experimentalItemIdentity(batchId, ordinal)`, `explanationFingerprint(value)`, and `experimentalVariationInstruction(...)`.

- [ ] **Step 1: Write failing domain-helper tests**

```ts
import { USER_MESSAGE_REPORT_REASONS } from "@discord-dsa/contracts";
import { describe, expect, it } from "vitest";
import {
  explanationFingerprint,
  experimentalBatchDefinitions,
  experimentalItemIdentity,
  experimentalVariationInstruction
} from "../src/experimental-batches.js";

describe("experimental report batch domain", () => {
  it("creates ten blocked same-category items after one Auto seed", () => {
    const items = experimentalBatchDefinitions("same_category_10x", USER_MESSAGE_REPORT_REASONS);
    expect(items).toHaveLength(10);
    expect(items[0]).toMatchObject({ ordinal: 1, reportType: null, state: "queued" });
    expect(items.slice(1).every((item) => item.state === "blocked")).toBe(true);
  });

  it("captures every message category exactly once in catalog order", () => {
    const items = experimentalBatchDefinitions("all_categories", USER_MESSAGE_REPORT_REASONS);
    expect(items.map((item) => item.reportType)).toEqual(
      USER_MESSAGE_REPORT_REASONS.map((reason) => reason.value)
    );
  });

  it("normalizes explanation fingerprints and creates stable per-item identities", () => {
    expect(explanationFingerprint("  HATE\nSpeech ")).toBe(
      explanationFingerprint("hate speech")
    );
    expect(experimentalItemIdentity("batch-id", 3)).toBe("experimental:batch-id:3");
  });

  it("gives each variant a factual distinctness instruction", () => {
    expect(experimentalVariationInstruction(2, 10, ["First reason"])).toContain(
      "Variant 2 of 10"
    );
    expect(experimentalVariationInstruction(2, 10, ["First reason"])).toContain(
      "Do not invent evidence"
    );
  });
});
```

- [ ] **Step 2: Run the focused test and confirm RED**

Run: `npm.cmd test -w @discord-dsa/bot -- experimental-batches.test.ts`

Expected: FAIL because `experimental-batches.js` and its exports do not exist.

- [ ] **Step 3: Add the batch types and minimal pure implementation**

Add these public types to `apps/bot/src/types.ts`:

```ts
export type ExperimentalBatchMode = "same_category_10x" | "all_categories";
export type ExperimentalBatchItemState =
  | "blocked" | "queued" | "preparing" | "creating" | "reconciling"
  | "observing" | "retrying" | "submitted" | "failed";
export type ExperimentalBatchCreditState = "none" | "reserved" | "consumed" | "released";

export interface ExperimentalBatchRecord {
  id: string;
  discordUserId: string;
  interactionId: string;
  mode: ExperimentalBatchMode;
  itemCount: number;
  encryptedDraft: string;
  categories: Array<{ label: string; value: string }>;
  sharedReportType: string | null;
  statusDmMessageId: string | null;
  dmBlocked: boolean;
}

export interface ExperimentalBatchItemRecord {
  id: string;
  batchId: string;
  ordinal: number;
  reportType: string | null;
  state: ExperimentalBatchItemState;
  preparationAttempts: number;
  createAttempts: number;
  lifecycleRetries: number;
  explanationFingerprint: string | null;
  trackingId: string | null;
  originalReportId: string | null;
  currentReportId: string | null;
  successorReportId: string | null;
  creditState: ExperimentalBatchCreditState;
  safeErrorCode: string | null;
}
```

Implement `experimental-batches.ts` with SHA-256 over `value.normalize("NFKC").toLocaleLowerCase("en").trim().replace(/\s+/g, " ")`, a stable identity of `experimental:${batchId}:${ordinal}`, and definitions that use one queued Auto seed plus nine blocked items or one queued item per supplied category.

- [ ] **Step 4: Run the focused test and confirm GREEN**

Run: `npm.cmd test -w @discord-dsa/bot -- experimental-batches.test.ts`

Expected: PASS for all four domain tests.

- [ ] **Step 5: Commit the domain layer**

```powershell
git add apps/bot/src/types.ts apps/bot/src/experimental-batches.ts apps/bot/test/experimental-batches.test.ts
git commit -m "feat(bot): define experimental report batches"
```

---

### Task 2: Atomic batch reservation and non-blocking command enqueue

**Files:**
- Modify: `apps/bot/src/commands.ts`
- Modify: `apps/bot/src/interactions.ts`
- Modify: `apps/bot/src/database.ts`
- Modify: `apps/bot/src/types.ts`
- Modify: `apps/bot/test/bot.test.ts`
- Modify: `apps/bot/test/experimental-batches.test.ts`

**Interfaces:**
- Consumes: `experimentalBatchDefinitions`, `reportReasons("message_urf")`, `encryptJson`, existing access/default-country helpers, `bot_users`, and `credit_ledger`.
- Produces: `BotDatabase.reserveExperimentalBatch(input)`, two registered message commands, and `InteractionHandler.startExperimentalBatch(interaction, mode)` that returns after durable enqueue.

- [ ] **Step 1: Add failing command and interaction tests**

Extend command registration expectations from 7 to 9 and assert:

```ts
for (const name of ["Experimental 10x Same Category", "Experimental All Categories"]) {
  const command = COMMANDS.find((candidate) => candidate.name === name);
  expect(command?.type).toBe(ApplicationCommandType.Message);
  expect(name.length).toBeLessThanOrEqual(32);
}
```

Add policy tests before the interaction test:

```ts
expect(batchBalanceAfterReservation(20, 10, false)).toBe(10);
expect(batchBalanceAfterReservation(20, 18, false)).toBe(2);
expect(batchBalanceAfterReservation(20, 18, true)).toBe(20);
expect(() => batchBalanceAfterReservation(9, 10, false)).toThrow("10 report credits");
```

Add an interaction test whose database mock exposes `reserveExperimentalBatch`, while `reportWriter.generate` and `api.createReport` throw if called. Assert the handler defers first and calls:

```ts
expect(reserveExperimentalBatch).toHaveBeenCalledWith(expect.objectContaining({
  userId: "1197857362942378017",
  interactionId: "interaction-id",
  mode: "same_category_10x",
  requiredCredits: 10,
  adminBypass: false
}));
expect(generate).not.toHaveBeenCalled();
expect(createReport).not.toHaveBeenCalled();
expect(JSON.stringify(editReply.mock.calls.at(-1)?.[0])).toContain("10 credits reserved");
```

Add the equivalent all-category assertion using `USER_MESSAGE_REPORT_REASONS.length`.

- [ ] **Step 2: Run focused bot tests and confirm RED**

Run: `npm.cmd test -w @discord-dsa/bot -- bot.test.ts`

Expected: FAIL because the reservation policy, commands, and handler branch do not exist.

- [ ] **Step 3: Add the reservation schema and transaction**

Extend `SCHEMA_SQL` with `experimental_report_batches` and
`experimental_report_batch_items`. Use the exact state and credit-state checks from Task 1, unique
constraints for `(batch_id, ordinal)`, and a partial unique index on
`(batch_id, explanation_fingerprint)` where the fingerprint is non-null. Add
`experimental_batch_id uuid` to `credit_ledger` and indexes on item `(run_at, locked_at)` and batch
user/time.

Implement `batchBalanceAfterReservation(current, required, bypass)` so bypass returns `current`, an
insufficient balance throws `AccessError("no_credits", \`You need ${required} report credits.\`)`, and
the normal result is `current - required`.

Implement `reserveExperimentalBatch` as one transaction: lock/validate the user, replay an existing
`interaction_id`, insert the encrypted batch and every definition, deduct the full count once, and
write one `credit_ledger` row with reason `experimental_batch_reserved` and
`delta=-requiredCredits`. Return `{ batchId, itemCount, balanceBefore, balanceAfter, replayed }` only
after COMMIT.

- [ ] **Step 4: Register commands and implement enqueue-only handler behavior**

Create two `ContextMenuCommandBuilder` values with user-install integration and existing contexts, append them to `COMMANDS`, and branch in `handleMessageContext` before the current Quick Report branch.

The new method must begin with:

```ts
await interaction.deferReply({ flags: EPHEMERAL });
await this.requireReportAccess(interaction.user.id);
const access = await this.database.getAccess(interaction.user.id);
const draft: ReportDraft = {
  flow: "message_urf",
  messageUrl: interaction.targetMessage.url,
  messageSnapshot: snapshotMessage(interaction.targetMessage),
  sendToDms: false
};
this.applyDraftDefaults(draft, access.defaultCountry);
```

Snapshot `reportReasons("message_urf")`, derive definitions and count, encrypt the draft, then call `reserveExperimentalBatch`. Edit the deferred response with the exact reserved count and do not call the writer or API.

- [ ] **Step 5: Run focused bot tests and confirm GREEN**

Run: `npm.cmd test -w @discord-dsa/bot -- bot.test.ts`

Expected: PASS, including the existing Quick Report tests.

- [ ] **Step 6: Commit the atomic enqueue surface**

```powershell
git add apps/bot/src/commands.ts apps/bot/src/interactions.ts apps/bot/src/database.ts apps/bot/src/types.ts apps/bot/test/bot.test.ts apps/bot/test/experimental-batches.test.ts
git commit -m "feat(bot): enqueue experimental report commands"
```

---

### Task 3: Durable worker claiming and per-item credit settlement

**Files:**
- Modify: `apps/bot/src/database.ts`
- Modify: `apps/bot/src/types.ts`
- Modify: `apps/bot/test/experimental-batches.test.ts`

**Interfaces:**
- Consumes: persisted batches from Task 2, encrypted draft, existing `credit_ledger`, and `report_tracking` conventions.
- Produces: `claimExperimentalBatchItems`, `prepareExperimentalBatchItem`, `markExperimentalSubmissionCreated`, `rescheduleExperimentalBatchItem`, `failExperimentalBatchItem`, `observeExperimentalBatchItem`, `experimentalBatchView`, `saveExperimentalBatchDm`, `markExperimentalBatchDmBlocked`, and `acceptedExperimentalReasons`.

- [ ] **Step 1: Add failing settlement and claim-policy tests**

Add retry-policy assertions:

```ts
expect(experimentalRetryDelaySeconds(1)).toBe(15);
expect(experimentalRetryDelaySeconds(2)).toBe(30);
```

Add fake-database worker-state tests that claim only due rows, cap the requested claim limit at two,
recover rows whose `locked_at` is older than five minutes, and settle the same failed item twice
while returning only one credit.

- [ ] **Step 2: Run focused tests and confirm RED**

Run: `npm.cmd test -w @discord-dsa/bot -- experimental-batches.test.ts`

Expected: FAIL because retry policy and worker persistence methods are absent.

- [ ] **Step 3: Complete idempotent worker indexes and item references**

Add the nullable unique `tracking_id` reference on items and confirm the Task 2 migration has the
claim and fingerprint indexes required by the worker. Keep every migration statement idempotent.

- [ ] **Step 4: Implement atomic reservation and worker persistence methods**

`prepareExperimentalBatchItem` must, in one transaction, enforce the fingerprint uniqueness, store
the seed's shared category and unblock siblings when applicable, and insert a `report_tracking` row
with `dm_enabled=false`, `poll_at=NULL`, credit state inherited from the item, and interaction identity
`experimental:<batchId>:<ordinal>`.

`failExperimentalBatchItem` must be idempotent: only a `reserved` item returns one credit and writes
`experimental_batch_released`; bypassed items remain `none`. Created items remain consumed.

- [ ] **Step 5: Route accepted lifecycle events back to batch items**

Inside the existing `ingestLifecycleEvent` transaction, after inbox insertion, run an update joining
the tracking ID to `experimental_report_batch_items` and set that item to `observing`, `run_at=now()`,
and `locked_at=NULL`. Keep the existing notification-outbox insertion guarded by `dm_enabled`, so
batch-linked rows create no individual notification job.

- [ ] **Step 6: Run focused and existing lifecycle tests**

Run: `npm.cmd test -w @discord-dsa/bot -- experimental-batches.test.ts bot.test.ts`

Expected: PASS with reservation rollback, idempotent release, stale-lock claim, and lifecycle wakeup covered.

- [ ] **Step 7: Commit persistence**

```powershell
git add apps/bot/src/database.ts apps/bot/src/types.ts apps/bot/test/experimental-batches.test.ts
git commit -m "feat(bot): persist experimental report batches"
```

---

### Task 4: AI variation input and bounded aggregate embed

**Files:**
- Modify: `apps/bot/src/types.ts`
- Modify: `apps/bot/src/report-writer.ts`
- Create: `apps/bot/src/experimental-batch-ui.ts`
- Modify: `apps/bot/test/report-writer.test.ts`
- Modify: `apps/bot/test/experimental-batches.test.ts`

**Interfaces:**
- Consumes: batch/item view records, `experimentalVariationInstruction`, existing report writer prompts, and discord.js `EmbedBuilder`.
- Produces: optional encrypted-draft `experimentalVariation`, writer prompt enforcement, and `experimentalBatchEmbed(view)`.

- [ ] **Step 1: Write failing writer and embed tests**

Add a writer test that supplies:

```ts
experimentalVariation: {
  ordinal: 2,
  total: 10,
  priorReportReasons: ["The first accepted explanation."]
}
```

and asserts the research request contains `Variant 2 of 10`, the prior explanation, `materially
different`, and `Do not invent evidence`.

Build a view with all `USER_MESSAGE_REPORT_REASONS` and maximum-length explanation summaries. Assert:

```ts
const json = experimentalBatchEmbed(view).toJSON();
expect(json.fields).toHaveLength(USER_MESSAGE_REPORT_REASONS.length);
expect(json.fields!.every((field) => field.value.length <= 1_024)).toBe(true);
const characters =
  (json.title?.length ?? 0) +
  (json.description?.length ?? 0) +
  json.fields!.reduce((sum, field) => sum + field.name.length + field.value.length, 0);
expect(characters).toBeLessThanOrEqual(6_000);
```

- [ ] **Step 2: Run both focused tests and confirm RED**

Run: `npm.cmd test -w @discord-dsa/bot -- report-writer.test.ts experimental-batches.test.ts`

Expected: FAIL because the variation is ignored and the embed builder is absent.

- [ ] **Step 3: Add experimental variation to the research prompt**

Extend `ReportDraft` with:

```ts
experimentalVariation?: {
  ordinal: number;
  total: number;
  priorReportReasons: string[];
};
```

Append the pure variation instruction in `researchPrompt` only when this property exists. It must
ask for a distinct explanation and report while treating prior text as comparison data, not facts or
instructions.

- [ ] **Step 4: Implement the aggregate embed**

Use title `Experimental report batch`, a description containing mode and aggregate counts, and one
field per item. Field names are `<ordinal>. <category label>` truncated to 256 characters. Values
contain status, a 180-character explanation preview, short original/current IDs, and retry successor
when present, truncated to 1,024 characters. Color is yellow while active, red only when every item
failed, and blue otherwise. Add no buttons.

- [ ] **Step 5: Run focused tests and confirm GREEN**

Run: `npm.cmd test -w @discord-dsa/bot -- report-writer.test.ts experimental-batches.test.ts`

Expected: PASS and serialized embed data stays within tested limits.

- [ ] **Step 6: Commit writer and UI support**

```powershell
git add apps/bot/src/types.ts apps/bot/src/report-writer.ts apps/bot/src/experimental-batch-ui.ts apps/bot/test/report-writer.test.ts apps/bot/test/experimental-batches.test.ts
git commit -m "feat(bot): generate distinct batch report variants"
```

---

### Task 5: Durable bounded worker, safe retries, and aggregate delivery

**Files:**
- Create: `apps/bot/src/experimental-batch-worker.ts`
- Modify: `apps/bot/src/experimental-batches.ts`
- Modify: `apps/bot/src/database.ts`
- Modify: `apps/bot/test/experimental-batches.test.ts`

**Interfaces:**
- Consumes: `BotDatabase` methods from Task 3, `ReportWriter.generate`, `draftToCreateInput`, `DsaApi.createReport/report/retryReport`, encryption helpers, and `experimentalBatchEmbed`.
- Produces: `ExperimentalBatchWorker.start()`, `.stop()`, and `.tick()` plus an exported `runWithConcurrency(items, 2, operation)` helper.

- [ ] **Step 1: Write failing concurrency and same-category worker tests**

Use database, API, writer, and Discord-client fakes. Make four operations wait on controlled promises,
call `tick`, and assert peak active operations is exactly 2. For same-category, return
`sub_other_hate_speech` from the seed and assert all nine subsequently prepared drafts carry that
fixed `reportType`. Assert ten create calls use ten different identities.

- [ ] **Step 2: Write failing retry and settlement tests**

Cover these independent cases:

```ts
// AI fails once, succeeds once: two generate calls, no credit release.
// AI fails twice: failExperimentalBatchItem called once with a safe code.
// API-created report has retryable=true: retryReport called once and no reserve call occurs.
// Retry successor also fails: retryReport still called only once.
// error.code === "ambiguous_submission_state": retryReport never called.
// definite create rejection: item credit released; another item still completes.
// ambiguous create transport error: same item identity/input is retained for reconciliation.
```

Also assert every meaningful state transition edits the same saved DM message ID and `user.send` is
called only when no saved aggregate message exists.

- [ ] **Step 3: Run worker tests and confirm RED**

Run: `npm.cmd test -w @discord-dsa/bot -- experimental-batches.test.ts`

Expected: FAIL because `ExperimentalBatchWorker` does not exist.

- [ ] **Step 4: Implement bounded worker lifecycle**

Implement a five-second background loop matching the existing notifier's start/stop pattern. `tick`
claims at most two due items and runs them through `Promise.allSettled`; a `ticking` guard prevents
overlap. Each item decrypts its batch draft, loads previously accepted encrypted reasons, attaches
the variation, and calls `generate`.

After successful generation, apply the writer result, build/encrypt `CreateReportInput`, persist the
tracking row, and call `createReport` with the stable item identity. Use database transitions rather
than keeping correctness only in memory.

- [ ] **Step 5: Implement safe create reconciliation and lifecycle retry**

Permanent 4xx errors, including idempotency conflict 409, fail and release; 429 schedules the one
create retry. A 5xx or unknown/transport outcome enters `reconciling` and reissues the same
idempotent create identity after 60 seconds, so it can recover an API record without creating a
replacement identity. Once a report exists, fetch its detail on due observations. Call `retryReport` exactly
once only when `status === "failed" && retryable === true`; use identity
`experimental-retry:<batchId>:<ordinal>` and persist the successor through a batch-specific retry
tracking method with `dm_enabled=false` and no credit deduction.

- [ ] **Step 6: Implement aggregate DM refresh and blocked-DM handling**

After each committed item transition, load the batch view and edit its saved DM. If absent, fetch the
user and send one message, then persist its ID. Treat Discord error 50007 as permanent for the batch,
mark `dm_blocked=true`, and continue report processing without repeated sends. Treat unknown-message
10008 as a deleted card and send one replacement.

- [ ] **Step 7: Run focused worker tests and confirm GREEN**

Run: `npm.cmd test -w @discord-dsa/bot -- experimental-batches.test.ts`

Expected: PASS for concurrency, restart-safe state transitions, both retry budgets, ambiguity rules,
credit settlement, and single-message aggregation.

- [ ] **Step 8: Commit the worker**

```powershell
git add apps/bot/src/experimental-batch-worker.ts apps/bot/src/experimental-batches.ts apps/bot/src/database.ts apps/bot/test/experimental-batches.test.ts
git commit -m "feat(bot): process experimental batches durably"
```

---

### Task 6: Startup wiring and lifecycle aggregation

**Files:**
- Modify: `apps/bot/src/main.ts`
- Modify: `apps/bot/src/database.ts`
- Modify: `apps/bot/src/notifier.ts`
- Modify: `apps/bot/test/bot.test.ts`
- Modify: `apps/bot/test/experimental-batches.test.ts`

**Interfaces:**
- Consumes: `ExperimentalBatchWorker`, lifecycle inbox events, existing notification worker, shared `DsaApi`, Discord client, writer, config, and database.
- Produces: process startup/shutdown integration and aggregate-only lifecycle delivery for batch-linked tracking.

- [ ] **Step 1: Add failing lifecycle routing tests**

Create a batch-linked tracking fixture and ingest a `report_failed` event. Assert it wakes the batch
item and creates no ordinary notification outbox job. On the next batch-worker tick, return a
retryable report and assert the lifecycle retry occurs once and the aggregate card is edited.

Keep the existing non-batch test and assert it still creates/delivers the ordinary per-report DM.

- [ ] **Step 2: Run lifecycle tests and confirm RED**

Run: `npm.cmd test -w @discord-dsa/bot -- bot.test.ts experimental-batches.test.ts`

Expected: FAIL until startup and lifecycle batch routing are connected.

- [ ] **Step 3: Wire start and stop**

Construct `ExperimentalBatchWorker(database, api, client, config, reportWriter)` after login, start it
beside `NotificationWorker`, and stop both before destroying the client and closing the database.
Do not add new gateway intents.

- [ ] **Step 4: Complete lifecycle routing**

Ensure both webhook ingestion and 15-minute feed reconciliation use the same database event path.
Batch-linked events wake only the batch item; normal tracking keeps existing notification behavior.
Do not fetch or expose report content inside the webhook handler.

- [ ] **Step 5: Run bot workspace tests and confirm GREEN**

Run: `npm.cmd test -w @discord-dsa/bot`

Expected: PASS with existing normal Quick Report and notifier behavior unchanged.

- [ ] **Step 6: Commit integration**

```powershell
git add apps/bot/src/main.ts apps/bot/src/database.ts apps/bot/src/notifier.ts apps/bot/test/bot.test.ts apps/bot/test/experimental-batches.test.ts
git commit -m "feat(bot): aggregate experimental batch lifecycles"
```

---

### Task 7: Canonical documentation and full verification

**Files:**
- Modify: `docs/BOT_API.md`
- Modify: `docs/BOT_IMPLEMENTATION.md`
- Modify: `README.md` only if its command list is found to enumerate every user command.

**Interfaces:**
- Consumes: implemented names, credit counts, background behavior, retries, and result delivery.
- Produces: canonical operator and bot-contract documentation matching the shipped behavior.

- [ ] **Step 1: Add exact command contract documentation**

Add both command names to the command list. Document that all-categories uses the catalog snapshot
count rather than a fixed 10, complete credits are reserved before work, the interaction returns
after enqueue, AI preparation retries once, API lifecycle retry happens once only when safe, and one
aggregate DM replaces individual batch lifecycle DMs.

- [ ] **Step 2: Check documentation and source consistency**

Run:

```powershell
rg -n "Experimental 10x Same Category|Experimental All Categories|same_category_10x|all_categories" apps/bot docs/BOT_API.md docs/BOT_IMPLEMENTATION.md
git diff --check
```

Expected: both public names occur in commands/tests/docs; internal mode names occur only in bot code/tests; no whitespace errors.

- [ ] **Step 3: Run required repository validation**

Run in order from the repository root:

```powershell
npm.cmd run lint
npm.cmd run typecheck
npm.cmd test
npm.cmd run build
npm.cmd run audit:high
```

Expected: every command exits 0. Do not run `test:headers`, `test:client-readonly`, or `test:post-headers`.

- [ ] **Step 4: Review the final diff for privacy and scope**

Run:

```powershell
git status --short
git diff --stat HEAD
git diff HEAD -- apps/bot docs/BOT_API.md docs/BOT_IMPLEMENTATION.md
```

Confirm no secrets, raw message/report content logging, protected Python changes, API/bot boundary
violations, or unrelated user files are present.

- [ ] **Step 5: Commit documentation and final fixes**

```powershell
git add docs/BOT_API.md docs/BOT_IMPLEMENTATION.md
git commit -m "docs: document experimental report batches"
```
