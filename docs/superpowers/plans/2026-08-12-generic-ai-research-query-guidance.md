# Generic AI Research Query Guidance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Instruct the AI planner to produce generic, reusable law and terminology research queries.

**Architecture:** Change only the planner prompt in the bot report writer. Preserve the existing query validator as the enforcement boundary, and lock the prompt wording down with a request-prompt regression test.

**Tech Stack:** TypeScript, Vitest, npm workspaces.

## Global Constraints

- Do not change `validateResearchQuery` or its privacy behavior.
- Search queries must remain under the existing 400-character and 50-word limits.
- Do not expose report metadata to external research providers.

---

### Task 1: Planner prompt guidance

**Files:**
- Modify: `apps/bot/test/report-writer.test.ts`
- Modify: `apps/bot/src/report-writer.ts`

**Interfaces:**
- Consumes: `ReportWriter.generate()` and its Fireworks planning request.
- Produces: A planner prompt that requires generic standalone law and terminology queries.

- [ ] **Step 1: Write the failing test**

Add a report-writer test that creates a normal plan and asserts that the first Fireworks request prompt contains `generic, standalone searches`, `Germany laws on online threats`, and `what does [slang] mean in online context`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm.cmd test -w @discord-dsa/bot -- --run test/report-writer.test.ts`

Expected: FAIL because the current planner prompt lacks the generic-query wording and examples.

- [ ] **Step 3: Write minimal implementation**

Replace the existing generic search-query rule in `plannerPrompt` with instructions requiring a generic standalone query that describes only the law or concept, never the reported incident, and include the two approved examples.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm.cmd test -w @discord-dsa/bot -- --run test/report-writer.test.ts`

Expected: PASS.

- [ ] **Step 5: Verify the bot workspace**

Run: `npm.cmd run lint -w @discord-dsa/bot; npm.cmd run typecheck -w @discord-dsa/bot; npm.cmd test -w @discord-dsa/bot -- --run`

Expected: all commands exit successfully.

- [ ] **Step 6: Commit and push**

Stage only the two implementation files and these design and plan documents. Commit with `fix(bot): guide AI toward generic research queries`, then push the current branch.
