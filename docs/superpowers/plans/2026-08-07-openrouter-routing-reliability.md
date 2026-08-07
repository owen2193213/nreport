# OpenRouter Routing Reliability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore uptime-aware OpenRouter routing while preferring providers that reliably deliver at least 50 TPS, and remove ZDR only from research calls.

**Architecture:** Keep separate provider helpers for research and report-producing stages. Both deny data collection, require parameter support, and set a soft p90 throughput preference; only report-producing stages require ZDR.

**Tech Stack:** TypeScript, Vitest, OpenRouter Chat Completions API, npm workspaces

## Global Constraints

- Keep DeepSeek V4 Flash as the default model.
- Keep ZDR on writing, refinement, and repair.
- Research must deny data collection but must not require ZDR.
- Remove explicit provider sorting so OpenRouter's uptime-aware load balancing remains enabled.
- Keep existing timeouts, fallbacks, schemas, and completion limits.

---

### Task 1: Correct provider preferences

**Files:**
- Modify: `apps/bot/test/report-writer.test.ts`
- Modify: `apps/bot/src/report-writer.ts`

**Interfaces:**
- Consumes: `provider()` and `researchProvider()` request-body helpers.
- Produces: research preferences without ZDR and report preferences with ZDR; both include `preferred_min_throughput: { p90: 50 }` and no `sort`.

- [x] **Step 1: Write failing provider assertions**

For research requests, expect:

```ts
{
  data_collection: "deny",
  require_parameters: true,
  preferred_min_throughput: { p90: 50 }
}
```

For writing, refinement, and repair, expect the same object plus `zdr: true`.

- [x] **Step 2: Verify RED**

Run `npm.cmd test -w @discord-dsa/bot -- report-writer.test.ts`. Expect failures because current requests contain `sort: "throughput"` and research contains `zdr: true`.

- [x] **Step 3: Implement the minimal helper changes**

Remove `sort` from both helpers, remove `zdr` from `researchProvider()`, and add `preferred_min_throughput: { p90: 50 }` to both helpers.

- [x] **Step 4: Verify GREEN**

Run the same focused test command. Expect all report-writer tests to pass.

### Task 2: Align documentation and verify the repository

**Files:**
- Modify: `README.md`
- Modify: `docs/BOT_API.md`
- Modify: `docs/BOT_IMPLEMENTATION.md`
- Modify: `docs/superpowers/plans/2026-08-07-deepseek-throughput-zdr-routing.md`

**Interfaces:**
- Consumes: corrected provider behavior from Task 1.
- Produces: documentation that distinguishes research privacy from report-stage ZDR and describes uptime-aware throughput preferences.

- [x] **Step 1: Update routing documentation**

State that research denies collection without ZDR; report-producing stages retain ZDR; all stages use the soft p90 50 TPS preference with normal uptime-aware load balancing. Amend the earlier plan so it does not remain as contradictory operational guidance.

- [x] **Step 2: Run complete verification**

Run:

```powershell
npm.cmd run lint
npm.cmd run typecheck
npm.cmd test
npm.cmd run build
npm.cmd run audit:high
git diff --check
```

Expected: every command exits successfully, all tests pass, and the audit reports no high-severity vulnerabilities.

- [ ] **Step 3: Review scope**

Confirm no protected Python scripts or unrelated files changed and mark this plan complete.
