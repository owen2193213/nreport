# OpenRouter Time Budget Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give AI legal research sufficient time to return a complete non-streaming structured response and classify an aborted response-body read correctly.

**Architecture:** `ReportWriter` owns one five-minute deadline per generate/refine workflow. Its OpenRouter helper derives a 150-second request budget from that deadline and retains the abort signal through response-body parsing, allowing an abort to be distinguished from invalid JSON. Tests exercise the public workflow errors using the injected request function.

**Tech Stack:** TypeScript, Node.js fetch/AbortSignal, Vitest.

## Global Constraints

- Keep the workflow bounded at five minutes and each OpenRouter request bounded at 150 seconds.
- Never log raw report content, model responses, credentials, or router payloads.
- Preserve OpenRouter provider routing, `require_parameters: true`, and strict structured outputs.

---

### Task 1: Time budget and timeout classification

**Files:**
- Modify: `apps/bot/test/report-writer.test.ts`
- Modify: `apps/bot/src/report-writer.ts`
- Modify: `docs/BOT_IMPLEMENTATION.md`

**Interfaces:**
- Consumes: `ReportWriter` injected `request` function and `ReportWriterError`.
- Produces: Five-minute workflow errors and a timeout error when `Response.json()` aborts.

- [ ] **Step 1: Write the failing tests**

Add a test where the injected request returns an object whose `json()` rejects with an `AbortError`, then assert that `generate()` rejects with `AI legal research timed out or could not be reached.` Add a direct deadline-expired test asserting the message names the five-minute workflow limit.

- [ ] **Step 2: Run the focused tests to verify they fail**

Run: `npm.cmd test -w @discord-dsa/bot -- report-writer.test.ts`

Expected: the abort-during-JSON test reports `malformed response`, and the deadline-expired test reports `90-second limit`.

- [ ] **Step 3: Implement the minimal budget and abort handling**

Set `WORKFLOW_TIMEOUT_MS` to `300_000` and `REQUEST_TIMEOUT_MS` to `150_000`. Store the request abort signal, use it for `fetch`, and in the `response.json()` catch branch use `signal.aborted` to emit the existing `network_or_timeout` safe category and timeout message; retain `malformed_response` for non-abort JSON failures. Update the workflow-limit message to say `5-minute`.

- [ ] **Step 4: Update the operational documentation**

Document the five-minute workflow and 150-second request budgets in `docs/BOT_IMPLEMENTATION.md`, alongside the AI generation workflow description.

- [ ] **Step 5: Run focused tests to verify they pass**

Run: `npm.cmd test -w @discord-dsa/bot -- report-writer.test.ts`

Expected: PASS.

- [ ] **Step 6: Run repository verification**

Run: `npm.cmd run lint`, `npm.cmd run typecheck`, `npm.cmd test`, `npm.cmd run build`, and `npm.cmd run audit:high`.

- [ ] **Step 7: Commit**

Run:

```powershell
git add apps/bot/src/report-writer.ts apps/bot/test/report-writer.test.ts docs/BOT_IMPLEMENTATION.md docs/superpowers/specs/2026-08-10-openrouter-time-budget-design.md docs/superpowers/plans/2026-08-10-openrouter-time-budget.md
git commit -m "fix(bot): extend OpenRouter research time budget"
```
