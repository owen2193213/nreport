# Max Completion Tokens Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Send MiniMax report-writing completion budgets through `max_completion_tokens` instead of deprecated `max_tokens`.

**Architecture:** Keep the existing `ReportWriter` workflow and 4,096-token constant unchanged. Modify only the OpenRouter request field used by write, refine, and repair calls, then update request-shape tests and canonical documentation.

**Tech Stack:** TypeScript, Vitest, npm workspaces, OpenRouter Chat Completions API

## Global Constraints

- Legal-research requests remain uncapped.
- Final report text remains limited to 512 characters.
- Reasoning, schema validation, routing, repair, and timeout behavior remain unchanged.

---

### Task 1: Migrate Report Completion Budget Parameter

**Files:**
- Modify: `apps/bot/test/report-writer.test.ts`
- Modify: `apps/bot/src/report-writer.ts`
- Modify: `docs/BOT_API.md`
- Modify: `docs/BOT_IMPLEMENTATION.md`

**Interfaces:**
- Consumes: `REPORT_COMPLETION_TOKEN_LIMIT` with value `4_096`.
- Produces: OpenRouter request bodies containing `max_completion_tokens: 4_096` and no `max_tokens` for write, refine, and repair stages.

- [x] **Step 1: Write failing request-shape assertions**

Change each report-producing request body type and assertion from:

```ts
max_tokens: number;
expect(body.max_tokens).toBe(4_096);
```

to:

```ts
max_completion_tokens: number;
max_tokens?: number;
expect(body.max_completion_tokens).toBe(4_096);
expect(body.max_tokens).toBeUndefined();
```

- [x] **Step 2: Verify the focused tests fail**

Run: `npm.cmd test -w @discord-dsa/bot -- report-writer.test.ts`

Expected: FAIL because report-producing request bodies still contain `max_tokens` and lack `max_completion_tokens`.

- [x] **Step 3: Apply the minimal production change**

In the refine and shared report-request bodies, replace:

```ts
max_tokens: REPORT_COMPLETION_TOKEN_LIMIT,
```

with:

```ts
max_completion_tokens: REPORT_COMPLETION_TOKEN_LIMIT,
```

- [x] **Step 4: Update canonical documentation**

State in `docs/BOT_API.md` and `docs/BOT_IMPLEMENTATION.md` that report-producing calls send `max_completion_tokens: 4096`, while reports remain limited to 512 characters.

- [x] **Step 5: Verify focused and repository-wide checks**

Run, in order:

```powershell
npm.cmd test -w @discord-dsa/bot -- report-writer.test.ts
npm.cmd run lint
npm.cmd run typecheck
npm.cmd test
npm.cmd run build
npm.cmd run audit:high
```

Expected: every command exits successfully with zero test failures, lint errors, type errors, build errors, or high-severity audit findings.
