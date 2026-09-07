# Components V2 Report Experience Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the account-owned Discord bot's minimal embeds and raw report forms with the approved direct-submit Components V2 experience, safe target context, coalesced card updates, precise decision notifications, and appeal-denial replacement actions.

**Architecture:** Keep Discord presentation and notification scheduling in `apps/bot`, public replacement authorization in the API, and shared request/response shapes in `packages/report-contracts`. Extract pure report UI/classification builders from interaction routing so component payloads, privacy boundaries, recovery rules, and lifecycle grouping are testable without Discord network calls.

**Tech Stack:** TypeScript, discord.js 14.27 Components V2/modal builders, Fastify, PostgreSQL, Vitest, npm workspaces.

**Spec:** `docs/superpowers/specs/2026-09-07-components-v2-report-experience-design.md`

**Implementation status:** Complete. All seven tasks were implemented and verified on 2026-09-07; the detailed checkboxes below preserve the original execution recipe.

## Global Constraints

- Quick Report Message is final consent and calls create immediately with `useAi: true`.
- Normal report entry points open the report modal directly; modal submission creates immediately with no target preview or review step.
- Components V2 messages set `MessageFlags.IsComponentsV2` and contain no `content` or `embeds`.
- The report text renderer consumes only `ReportDetail.finalText`; target metadata is never concatenated into its code block.
- Message evidence excludes replied-to/reference context.
- `report denied`, `appeal denied`, `report accepted`, and `appeal accepted` remain distinct.
- Report-denied decision DMs default off; other decision and problem DMs default on.
- Ineligible and two-minute confirmation timeouts expose no resend-as-is or automatic retry.
- Non-terminal card edits debounce for 2 seconds, remain at least 5 seconds apart, skip identical visible payloads, and collapse rapid internal states.
- The bot never imports API database/job internals, and the API remains authoritative for replacement eligibility and immutable evidence.

---

### Task 1: Shared replacement and evidence contract

**Files:**
- Modify: `packages/report-contracts/src/types.ts`
- Modify: `packages/report-contracts/src/schemas.ts`
- Modify: `packages/report-contracts/src/api.ts`
- Test: `packages/report-contracts/test/contracts.test.ts`

**Interfaces:**
- Produces: `RetryReportInput`, with legacy failure modes plus appeal-denial `rewrite_ai` and `edit_manual` variants.
- Produces: message snapshots with no `referencedMessage` field.
- Produces: `DsaApi.retryReport(reportId, idempotencyKey, input)`.

- [ ] **Step 1: Write failing contract tests**

```ts
expect(REPORT_RETRY_MODES).toEqual(["reuse", "regenerate", "rewrite_ai", "edit_manual"]);
expect(retryReportBodySchema.oneOf).toBeDefined();
expect("referencedMessage" in messageSnapshot).toBe(false);
```

- [ ] **Step 2: Run the focused contract tests and verify the new expectations fail**

Run: `npm.cmd test -w @nreport/contracts -- contracts.test.ts`

- [ ] **Step 3: Implement the discriminated retry input and remove referenced-message DTOs**

```ts
export type RetryReportInput =
  | { mode: "reuse" | "regenerate" | "rewrite_ai" }
  | { mode: "edit_manual"; country: string; category: string; finalText: string; profileElements?: UserProfileElement[]; guildElements?: GuildElement[] };
```

- [ ] **Step 4: Make the client serialize the complete input and run contract tests green**

Run: `npm.cmd test -w @nreport/contracts`

### Task 2: API-enforced appeal-denial replacements

**Files:**
- Modify: `apps/api/src/validation.ts`
- Modify: `apps/api/src/server-v2.ts`
- Modify: `apps/api/src/report-repository.ts`
- Modify: `apps/api/src/preparation-worker.ts`
- Modify: `apps/api/src/preparation/api-report-preparer.ts`
- Modify: `apps/api/src/preparation/types.ts`
- Test: `apps/api/test/report-repository.test.ts`
- Test: `apps/api/test/preparation-worker.test.ts`
- Test: `apps/api/test/server-v2.test.ts`

**Interfaces:**
- Consumes: `RetryReportInput` from Task 1.
- Produces: appeal-denied-only `rewrite_ai` and `edit_manual` successors with copied target/evidence and one-successor/idempotency enforcement.

- [ ] **Step 1: Add failing repository and route tests**

```ts
expect(reportRetryableModes(appealDeniedAi)).toEqual(["rewrite_ai", "edit_manual"]);
expect(reportRetryableModes(ineligible)).toEqual([]);
await repository.retry(accountId, reportId, key, { mode: "edit_manual", country: "DE", category: "harassment", finalText: "Complete replacement." });
```

- [ ] **Step 2: Run focused API tests and confirm failures are caused by the missing modes**

Run: `npm.cmd test -w @nreport/api -- report-repository.test.ts server-v2.test.ts preparation-worker.test.ts`

- [ ] **Step 3: Implement validation and retry-row construction**

`rewrite_ai` copies immutable target/evidence, clears country/category/description, forces AI, and records an internal rewrite directive. `edit_manual` copies immutable target/evidence, applies only supplied editable fields, forces manual mode, and preserves flow-specific element validation.

- [ ] **Step 4: Feed the autonomous rewrite instruction into the existing writer prompt**

```ts
const APPEAL_DENIAL_REWRITE_INSTRUCTION = "Discord denied the automatic appeal, but no explanatory denial reason was provided. Re-evaluate the original evidence independently. Write a materially improved replacement report and choose the strongest supported country, category, and legal reference; these may differ from the prior report. Do not invent a denial reason, new evidence, or facts not present in the captured target.";
```

- [ ] **Step 5: Run all API tests green**

Run: `npm.cmd test -w @nreport/api`

### Task 3: Pure Components V2 report UI

**Files:**
- Create: `apps/bot/src/report-ui.ts`
- Test: `apps/bot/test/report-ui.test.ts`

**Interfaces:**
- Produces: `TargetDisplayContext`, `ReportViewState`, `classifyReportView(report)`, `buildStatusCard(report, context)`, `buildDecisionDm(report, context)`, and `buildReportModal(...)`.
- Produces: `statusMessageOptions(...)` and decision options with `allowedMentions: { parse: [] }`.

- [ ] **Step 1: Write failing payload tests for modal dropdowns and Components V2 cards**

```ts
expect(status.flags).toBe(MessageFlags.IsComponentsV2);
expect(status).not.toHaveProperty("embeds");
expect(JSON.stringify(status.components)).toContain("@username");
expect(extractReportCodeBlock(status)).toBe(report.finalText);
expect(JSON.stringify(status.components)).not.toContain(`${context.userId}\n${report.finalText}`);
```

- [ ] **Step 2: Verify focused tests fail because `report-ui.ts` does not exist**

Run: `npm.cmd test -w @nreport/discord-dsa-bot -- report-ui.test.ts`

- [ ] **Step 3: Implement grouped lifecycle classification and exact recovery rules**

Classify preparation/submission groups, direct versus appealed action, explicit timeouts, ineligible, and appeal denial. Only fresh appeal denial returns `rewrite_ai` and `edit_manual` actions.

- [ ] **Step 4: Implement status/decision Components V2 builders and privacy-safe code blocks**

Use `ContainerBuilder`, `SectionBuilder`, `ThumbnailBuilder`, `TextDisplayBuilder`, `SeparatorBuilder`, and action rows. Escape triple backticks in `finalText`, and pass it to the code-block renderer as a separate argument.

- [ ] **Step 5: Implement current modal components with concrete labels and flow catalogs**

Use `LabelBuilder` with `RadioGroupBuilder`, `StringSelectMenuBuilder`, and `TextInputBuilder`. Country is optional with no component `min_length`; profile/server elements are required multi-selects.

- [ ] **Step 6: Run report UI tests green**

Run: `npm.cmd test -w @nreport/discord-dsa-bot -- report-ui.test.ts`

### Task 4: Capture and persist safe target context

**Files:**
- Modify: `apps/bot/src/message-resolver.ts`
- Create: `apps/bot/src/server-resolver.ts`
- Modify: `apps/bot/src/account-database.ts`
- Test: `apps/bot/test/message-resolver.test.ts`
- Test: `apps/bot/test/account-overhaul.test.ts`

**Interfaces:**
- Consumes: `TargetDisplayContext` from Task 3.
- Produces: encrypted `target_display_context` on report links, inherited when a successor link is created.

- [ ] **Step 1: Add failing tests proving referenced messages are absent and context ciphertext is stored/inherited**

```ts
expect(snapshotMessage(message)).not.toHaveProperty("referencedMessage");
expect(beginLinkQuery.values).toContain(encryptedContext);
```

- [ ] **Step 2: Run focused tests red**

Run: `npm.cmd test -w @nreport/discord-dsa-bot -- message-resolver.test.ts account-overhaul.test.ts`

- [ ] **Step 3: Remove reference capture and add best-effort server/profile/message display-context resolution**

Sanitize excerpts, use literal `@username`, count attachments, and never add referenced-message content.

- [ ] **Step 4: Add idempotent database columns and encrypted-context accessors**

Add `encrypted_target_context`, successor inheritance, `visible_payload_hash`, `card_dirty_at`, `last_card_edit_at`, and decision-delivery markers without storing readable evidence.

- [ ] **Step 5: Run focused bot tests green**

Run: `npm.cmd test -w @nreport/discord-dsa-bot -- message-resolver.test.ts account-overhaul.test.ts`

### Task 5: Direct-submit interactions and appeal recovery

**Files:**
- Modify: `apps/bot/src/account-interactions.ts`
- Modify: `apps/bot/src/commands.ts`
- Modify: `apps/bot/src/main.ts`
- Test: `apps/bot/test/account-overhaul.test.ts`

**Interfaces:**
- Consumes: Task 3 UI builders and Task 4 encrypted context.
- Produces: direct normal modal, immediate Quick Report, modal-submit create, `rewrite_ai` button, and `edit_manual` modal handling.

- [ ] **Step 1: Add failing interaction tests**

Prove blank AI country/category are omitted, manual blank/unsupported values fail after modal submission, selected elements come from dropdown values, quick and modal flows call create immediately, and no review custom ID is emitted.

- [ ] **Step 2: Run interaction tests red**

Run: `npm.cmd test -w @nreport/discord-dsa-bot -- account-overhaul.test.ts`

- [ ] **Step 3: Route buttons/selects/modals and use the live API catalog**

Cache the account catalog briefly, construct flow-specific choices, validate submitted values, and keep optional country free of Discord `min_length`.

- [ ] **Step 4: Implement replacement actions**

`Rewrite with AI` immediately enqueues `{ mode: "rewrite_ai" }`. `Edit manually` shows one modal and submits `{ mode: "edit_manual", ... }`; neither action exists for ineligible or timeout states.

- [ ] **Step 5: Replace embed replies/status creation with Components V2 payloads and run tests green**

Run: `npm.cmd test -w @nreport/discord-dsa-bot`

### Task 6: Coalesced cards and differentiated DMs

**Files:**
- Modify: `apps/bot/src/account-database.ts`
- Modify: `apps/bot/src/account-notifier.ts`
- Modify: `apps/bot/src/commands.ts`
- Test: `apps/bot/test/account-overhaul.test.ts`

**Interfaces:**
- Consumes: Task 3 classification/renderers and Task 4 scheduling columns.
- Produces: one dirty-card job per case, visible-payload hash skipping, terminal bypass, and notification preferences `decision`, `reportDenied`, `problems`, `dailyDigest`, `weeklyDigest`.

- [ ] **Step 1: Add failing scheduling and notification tests**

Prove rapid non-terminal events claim once after the debounce, edits respect spacing, identical hashes skip, terminal states claim immediately, report-denied defaults off, and appeal-denied defaults on.

- [ ] **Step 2: Run focused tests red**

Run: `npm.cmd test -w @nreport/discord-dsa-bot -- account-overhaul.test.ts`

- [ ] **Step 3: Implement durable dirty-card claiming and hash completion**

Event ingestion upserts the newest state and dirty timestamp. The worker fetches once immediately before rendering and completes or reschedules the case atomically.

- [ ] **Step 4: Send compact decision/problem Components V2 DMs only after card update**

Progress produces no extra DM. Report accepted, appeal accepted, and appeal denied follow decision settings; report denied follows its separate default-off setting. Timeouts and credential/action problems follow the problem setting.

- [ ] **Step 5: Update settings command and run all bot tests green**

Run: `npm.cmd test -w @nreport/discord-dsa-bot`

### Task 7: Contract documentation and full verification

**Files:**
- Modify: `docs/BOT_API.md`
- Modify: `docs/BOT_IMPLEMENTATION.md`

**Interfaces:**
- Documents the final public retry input, direct-submit UI, Components V2 card behavior, notification defaults, timeout behavior, and ownership boundary.

- [ ] **Step 1: Update canonical API and bot implementation documentation**

Document that `finalText` is the only report-code-block source, `Auto` means omission, appeal-denial replacements are linked, and report-denied notification defaults off.

- [ ] **Step 2: Run the repository-required verification suite**

Run:

```powershell
npm.cmd run lint
npm.cmd run typecheck
npm.cmd test
npm.cmd run build
npm.cmd run audit:high
```

- [ ] **Step 3: Inspect the scoped diff and verify every specification bullet has an implementation or test**

Run: `git diff --check` and `git status --short`.
