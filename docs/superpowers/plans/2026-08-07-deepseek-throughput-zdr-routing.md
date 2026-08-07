# DeepSeek Throughput and ZDR Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Default the bot to DeepSeek V4 Flash and dynamically route every AI request to the fastest compatible ZDR endpoint.

**Architecture:** Keep model selection configurable through `OPENROUTER_MODEL`. Replace the model-specific provider list with one shared OpenRouter preference object that filters for privacy and parameter compatibility, then sorts eligible endpoints by current throughput.

**Tech Stack:** TypeScript, Vitest, OpenRouter Chat Completions API, npm workspaces

## Global Constraints

- Preserve the API/bot ownership boundary and existing report lifecycle.
- Never weaken `zdr: true`, `data_collection: "deny"`, or `require_parameters: true`.
- Keep `max_completion_tokens: 4096` on report-producing calls.
- Preserve `OPENROUTER_MODEL` overrides and provider fallbacks.
- Do not touch protected Python diagnostics.

---

### Task 1: Default model and provider-routing behavior

**Files:**
- Modify: `apps/bot/test/config.test.ts`
- Modify: `apps/bot/test/report-writer.test.ts`
- Modify: `apps/bot/src/config.ts`
- Modify: `apps/bot/src/report-writer.ts`
- Modify: `apps/bot/.env.example`

**Interfaces:**
- Consumes: `loadBotConfig(env)` and `ReportWriter`'s OpenRouter request bodies.
- Produces: default model string `deepseek/deepseek-v4-flash` and provider preferences `{ zdr: true, data_collection: "deny", require_parameters: true, sort: "throughput" }` for every AI stage.

- [x] **Step 1: Change tests first**

Update the configuration expectation to:

```ts
expect(config.openRouterModel).toBe("deepseek/deepseek-v4-flash");
```

Update every research, writing, refinement, and repair provider assertion to:

```ts
expect(body.provider).toEqual({
  zdr: true,
  data_collection: "deny",
  require_parameters: true,
  sort: "throughput"
});
```

- [x] **Step 2: Run focused tests and verify RED**

Run:

```powershell
npm.cmd test -w @discord-dsa/bot -- config.test.ts report-writer.test.ts
```

Expected: failures show the old MiniMax default, missing research ZDR, and the fixed provider order.

- [x] **Step 3: Implement the minimal production change**

Set the configuration fallback and `.env.example` value to `deepseek/deepseek-v4-flash`. Make both provider helper methods return:

```ts
{
  zdr: true,
  data_collection: "deny",
  require_parameters: true,
  sort: "throughput"
}
```

- [x] **Step 4: Run focused tests and verify GREEN**

Run the same focused Vitest command. Expected: all selected tests pass.

### Task 2: Operator documentation and repository verification

**Files:**
- Modify: `docs/BOT_API.md`
- Modify: `docs/BOT_IMPLEMENTATION.md`

**Interfaces:**
- Consumes: implemented configuration and provider behavior from Task 1.
- Produces: operator-facing documentation matching the deployed behavior.

- [x] **Step 1: Update documentation**

Replace MiniMax as the documented default with `deepseek/deepseek-v4-flash`. State that every AI stage requires ZDR, denies collection, requires parameter support, and uses OpenRouter's dynamic `sort: "throughput"` routing rather than a fixed provider list. Update the decision log accordingly.

- [x] **Step 2: Run required verification**

Run from the repository root:

```powershell
npm.cmd run lint
npm.cmd run typecheck
npm.cmd test
npm.cmd run build
npm.cmd run audit:high
git diff --check
```

Expected: all commands pass; the audit reports no high-severity vulnerabilities; `git diff --check` reports no whitespace errors.

- [x] **Step 3: Review scope**

Confirm only the intended model/routing files, their tests/docs, the plan, and the already-present `max_completion_tokens` work are modified. Do not stage or commit protected scripts or unrelated files.
