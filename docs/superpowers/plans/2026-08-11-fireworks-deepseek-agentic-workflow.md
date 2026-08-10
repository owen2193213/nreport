# Fireworks DeepSeek Agentic Workflow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore the conditional Brave research workflow and run its planner and writer directly on Fireworks DeepSeek V4 Flash instead of Groq or OpenRouter.

**Architecture:** Reapply the previously tested application-controlled planner/search/synthesis workflow on top of the latest `main`, then replace its provider adapter with a focused Fireworks client. The report writer chooses `high` reasoning only for planning and research-backed synthesis; no-research synthesis, refinement, and repair use enforced JSON Schema with reasoning disabled.

**Tech Stack:** TypeScript, Node.js `fetch`, Vitest, Fireworks OpenAI-compatible Chat Completions, Brave Search API, npm workspaces.

## Global Constraints

- Default model: `accounts/fireworks/models/deepseek-v4-flash`.
- No Groq client, Groq environment variables, or OpenRouter fallback in the restored workflow.
- Planning completion budget: 8,192 tokens, including reasoning and visible JSON.
- Research-backed synthesis budget: 12,288 tokens, including reasoning and visible JSON.
- Non-reasoning synthesis, refinement, and repair budget: 4,096 tokens.
- Keep one bounded retry only for network errors, HTTP 429, and HTTP 5xx.
- Never log prompts, completions, research passages, report context, secrets, or provider error bodies.
- Keep Brave searches conditional and permit at most one synthesis-requested follow-up search.
- Keep application-side country, category, legal-reference, query, and 512-character validation.
- After TypeScript changes run lint, workspace typecheck, tests, build, and `audit:high`.

## File structure

- `apps/bot/src/fireworks-client.ts`: direct Fireworks transport, response parsing, safe errors, retry, usage, and structured logs.
- `apps/bot/src/brave-research.ts`: restored conditional terminology and legal search client; no provider changes.
- `apps/bot/src/report-writer.ts`: restored planner/search/synthesis orchestration, reasoning selection, prompt schemas, and one repair path.
- `apps/bot/src/config.ts` and `apps/bot/src/main.ts`: Fireworks/Brave configuration and dependency wiring.
- `apps/bot/test/fireworks-client.test.ts`: provider contract tests.
- `apps/bot/test/brave-research.test.ts`: restored Brave behavior tests.
- `apps/bot/test/report-writer.test.ts`: workflow, request-shape, reasoning, token-budget, and prompt tests.
- `apps/bot/test/config.test.ts`, `apps/bot/test/bot.test.ts`: configuration and UI regression coverage.
- `README.md`, `apps/bot/.env.example`, `docs/BOT_API.md`, `docs/BOT_IMPLEMENTATION.md`: current operator-facing provider and workflow documentation.

---

### Task 1: Restore the agentic Brave workflow baseline

**Files:**
- Restore: `apps/bot/src/brave-research.ts`
- Restore: `apps/bot/src/report-writer.ts`
- Restore: `apps/bot/test/brave-research.test.ts`
- Restore: `apps/bot/test/report-writer.test.ts`
- Modify: `apps/bot/src/config.ts`
- Modify: `apps/bot/src/main.ts`
- Modify: `apps/bot/test/config.test.ts`
- Modify: `apps/bot/test/bot.test.ts`
- Modify: `apps/bot/src/ui.ts`
- Modify: `README.md`
- Modify: `apps/bot/.env.example`
- Modify: `docs/BOT_API.md`
- Modify: `docs/BOT_IMPLEMENTATION.md`

**Interfaces:**
- Consumes: the rollback commit `ff65f5f` and the latest bot changes already present on this branch.
- Produces: the tested conditional planner/search/synthesis code as the baseline for Tasks 2–4.

- [ ] **Step 1: Reapply the rollback commit in reverse without committing**

Run:

```powershell
git revert --no-commit ff65f5f
```

Expected: the Brave and agentic report-writer files return; conflicts may appear only where later provider/model documentation or bot tests touched the same lines.

- [ ] **Step 2: Resolve conflicts in favor of the restored workflow plus newer unrelated bot behavior**

Keep the newer admin-mention changes in `apps/bot/src/interactions.ts`, `apps/bot/src/ui.ts`, and `apps/bot/test/bot.test.ts`. For provider-specific conflicts, retain the restored Brave workflow temporarily so the Fireworks tests in Task 2 can fail against a coherent baseline.

- [ ] **Step 3: Run the restored focused tests**

Run:

```powershell
npm.cmd test -w @discord-dsa/bot -- brave-research.test.ts report-writer.test.ts
```

Expected: PASS before the provider rename begins.

- [ ] **Step 4: Commit the restoration checkpoint**

```powershell
git add -- README.md apps/bot/.env.example apps/bot/src/brave-research.ts apps/bot/src/config.ts apps/bot/src/main.ts apps/bot/src/report-writer.ts apps/bot/src/ui.ts apps/bot/test/bot.test.ts apps/bot/test/brave-research.test.ts apps/bot/test/config.test.ts apps/bot/test/report-writer.test.ts docs/BOT_API.md docs/BOT_IMPLEMENTATION.md
git commit -m "feat(bot): restore conditional Brave research workflow"
```

### Task 2: Replace the Groq transport with Fireworks

**Files:**
- Create: `apps/bot/src/fireworks-client.ts`
- Create: `apps/bot/test/fireworks-client.test.ts`
- Delete: `apps/bot/src/groq-client.ts`
- Delete: `apps/bot/test/groq-client.test.ts`

**Interfaces:**
- Produces: `AiRequestContext`, `FireworksStage`, `FireworksCompletion`, `FireworksClientError`, and `FireworksClient.complete(body, deadline, actor, stage)`.
- `FireworksClient.complete` returns `{ content, finishReason, usage }` and throws a safe typed error without exposing provider response bodies.

- [ ] **Step 1: Write Fireworks client tests that fail against the Groq client**

Cover this request shape:

```ts
expect(url).toBe("https://api.fireworks.ai/inference/v1/chat/completions");
expect(headers.Authorization).toBe("Bearer fireworks-secret");
expect(body).toMatchObject({
  model: "accounts/fireworks/models/deepseek-v4-flash",
  reasoning_effort: "high",
  stream: false
});
```

Also test usage parsing from `prompt_tokens`, `completion_tokens`, and optional
`completion_tokens_details.reasoning_tokens`; rejection of `finish_reason: "length"`; one retry for network, 429, and 5xx; and no retry for malformed payloads or refusals.

- [ ] **Step 2: Run the client test and confirm failure**

Run:

```powershell
npm.cmd test -w @discord-dsa/bot -- fireworks-client.test.ts
```

Expected: FAIL because `fireworks-client.ts` does not exist.

- [ ] **Step 3: Implement the minimal Fireworks client**

Use these exported shapes:

```ts
export type FireworksStage = "plan" | "synthesize" | "refine";

export type FireworksClientErrorKind =
  | "network"
  | "rate_limited"
  | "refusal"
  | "provider"
  | "malformed"
  | "incomplete"
  | "timeout";

export class FireworksClient {
  public async complete(
    body: Record<string, unknown>,
    deadline: number,
    actor: AiRequestContext,
    stage: FireworksStage
  ): Promise<FireworksCompletion>;
}
```

Set `model` and `stream: false` in the client, but let `report-writer.ts` supply the stage-specific `reasoning_effort`, token budget, and response format. Treat `finish_reason === "length"` as `incomplete` before returning content.

- [ ] **Step 4: Run the client tests**

Run:

```powershell
npm.cmd test -w @discord-dsa/bot -- fireworks-client.test.ts
```

Expected: PASS.

- [ ] **Step 5: Remove the Groq client and commit**

```powershell
git add -- apps/bot/src/fireworks-client.ts apps/bot/test/fireworks-client.test.ts apps/bot/src/groq-client.ts apps/bot/test/groq-client.test.ts
git commit -m "feat(bot): add direct Fireworks client"
```

### Task 3: Wire Fireworks configuration

**Files:**
- Modify: `apps/bot/src/config.ts`
- Modify: `apps/bot/src/main.ts`
- Modify: `apps/bot/.env.example`
- Modify: `apps/bot/test/config.test.ts`

**Interfaces:**
- Produces: `BotConfig.fireworksApiKey: string` and `BotConfig.fireworksModel: string`.
- Consumes: `FireworksClient` indirectly through `ReportWriter` construction.

- [ ] **Step 1: Change configuration tests first**

Require this environment shape:

```ts
FIREWORKS_API_KEY: "fireworks-secret",
FIREWORKS_MODEL: "accounts/fireworks/models/deepseek-v4-flash",
BRAVE_SEARCH_API_KEY: "brave-secret"
```

Assert the model defaults to `accounts/fireworks/models/deepseek-v4-flash` when `FIREWORKS_MODEL` is absent, and assert `GROQ_API_KEY`, `GROQ_MODEL`, `OPENROUTER_API_KEY`, and `OPENROUTER_MODEL` are not read.

- [ ] **Step 2: Run the config test and confirm failure**

Run:

```powershell
npm.cmd test -w @discord-dsa/bot -- config.test.ts
```

Expected: FAIL on missing Fireworks fields or retained Groq fields.

- [ ] **Step 3: Implement configuration and wiring**

Change the `ReportWriter` construction to:

```ts
new ReportWriter(
  config.fireworksApiKey,
  config.fireworksModel,
  config.braveSearchApiKey,
  countries,
  options
);
```

Update `.env.example` with dummy Fireworks and Brave values only.

- [ ] **Step 4: Run config and client tests**

Run:

```powershell
npm.cmd test -w @discord-dsa/bot -- config.test.ts fireworks-client.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit configuration**

```powershell
git add -- apps/bot/src/config.ts apps/bot/src/main.ts apps/bot/.env.example apps/bot/test/config.test.ts
git commit -m "feat(bot): configure Fireworks DeepSeek"
```

### Task 4: Add stage-aware reasoning, schemas, and budgets

**Files:**
- Modify: `apps/bot/src/report-writer.ts`
- Modify: `apps/bot/test/report-writer.test.ts`

**Interfaces:**
- Consumes: `FireworksClient.complete` from Task 2.
- Produces: planner, synthesis, refinement, and repair request bodies with the approved reasoning policy.

- [ ] **Step 1: Write request-shape and prompt tests**

Assert planning sends:

```ts
expect(planning.reasoning_effort).toBe("high");
expect(planning.max_completion_tokens).toBe(8_192);
expect(planning.response_format).toBeUndefined();
expect(JSON.stringify(planning.messages)).toContain('"provisionalLawReference"');
```

Assert synthesis with Brave material sends `reasoning_effort: "high"`, `max_completion_tokens: 12_288`, no `response_format`, and a prompt-embedded synthesis schema. Assert synthesis without Brave material sends `reasoning_effort: "none"`, `max_completion_tokens: 4_096`, and Fireworks `response_format.type === "json_schema"`. Assert refinement and repair also use `none`, 4,096, and enforced JSON Schema.

Assert writer prompts contain both ideas:

```text
Keep the report naturally concise and comfortably within 512 characters.
Do not count characters step by step or spend time optimizing the exact character count.
```

- [ ] **Step 2: Run the report-writer test and confirm failure**

Run:

```powershell
npm.cmd test -w @discord-dsa/bot -- report-writer.test.ts
```

Expected: FAIL because the restored workflow still sends Groq-shaped requests with uniform reasoning and budgets.

- [ ] **Step 3: Implement the Fireworks request policy**

Replace Groq imports and members with Fireworks names. Add constants:

```ts
const PLAN_COMPLETION_TOKEN_LIMIT = 8_192;
const RESEARCH_SYNTHESIS_COMPLETION_TOKEN_LIMIT = 12_288;
const MECHANICAL_COMPLETION_TOKEN_LIMIT = 4_096;
```

Add a helper that appends `JSON.stringify(responseFormat.json_schema.schema)` to the user prompt for reasoning-enabled calls. Do not send `response_format` on those calls. For non-reasoning calls, send the existing `response_format` object directly.

Select research-backed reasoning with `materials.length > 0`. A follow-up synthesis necessarily has material and therefore remains `high`. Preserve the existing semantic parsers after JSON parsing.

- [ ] **Step 4: Add one bounded synthesis repair**

When a completed synthesis contains malformed JSON or an invalid/oversized report, make one `reasoning_effort: "none"`, 4,096-token repair call with the enforced synthesis schema and the validation problem. Do not repair unsupported country/category changes, inconsistent search flags, a second follow-up request, provider failures, refusals, or token-limit completions.

- [ ] **Step 5: Run workflow tests**

Run:

```powershell
npm.cmd test -w @discord-dsa/bot -- report-writer.test.ts brave-research.test.ts fireworks-client.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit the writer migration**

```powershell
git add -- apps/bot/src/report-writer.ts apps/bot/test/report-writer.test.ts
git commit -m "feat(bot): run report workflow on DeepSeek V4 Flash"
```

### Task 5: Update operator documentation and regression coverage

**Files:**
- Modify: `README.md`
- Modify: `docs/BOT_API.md`
- Modify: `docs/BOT_IMPLEMENTATION.md`
- Modify: `apps/bot/test/bot.test.ts`

**Interfaces:**
- Documents: direct Fireworks + conditional Brave architecture, environment variables, reasoning policy, retries, and absence of provider fallback.

- [ ] **Step 1: Update documentation assertions first**

Make the bot regression test require `FIREWORKS_API_KEY`, `FIREWORKS_MODEL`, the DeepSeek model ID, and `BRAVE_SEARCH_API_KEY`; reject current operational references to Groq and OpenRouter in the bot configuration sections.

- [ ] **Step 2: Run the regression test and confirm failure**

Run:

```powershell
npm.cmd test -w @discord-dsa/bot -- bot.test.ts
```

Expected: FAIL while operator docs still name Groq.

- [ ] **Step 3: Update operator documentation**

Document that Fireworks performs planning and writing, Brave is called only when the planner requests term or legal research, reasoning is high only for planning/research interpretation, and there is no OpenRouter fallback. Keep the documented user-facing error messages and API lifecycle unchanged.

- [ ] **Step 4: Run bot tests**

Run:

```powershell
npm.cmd test -w @discord-dsa/bot
```

Expected: PASS.

- [ ] **Step 5: Commit documentation**

```powershell
git add -- README.md docs/BOT_API.md docs/BOT_IMPLEMENTATION.md apps/bot/test/bot.test.ts
git commit -m "docs(bot): document Fireworks Brave workflow"
```

### Task 6: Full verification and deployment handoff

**Files:**
- Verify all explicitly changed files from Tasks 1–5.

**Interfaces:**
- Produces: a branch ready to push and deploy once real Railway secrets are supplied.

- [ ] **Step 1: Run formatting and static checks**

```powershell
npm.cmd run lint
npm.cmd run typecheck
```

Expected: both exit 0.

- [ ] **Step 2: Run the full test suite**

```powershell
npm.cmd test
```

Expected: all test files and tests pass.

- [ ] **Step 3: Build and audit**

```powershell
npm.cmd run build
npm.cmd run audit:high
```

Expected: build exits 0 and audit reports no high-severity vulnerabilities.

- [ ] **Step 4: Review the final diff and configuration names**

```powershell
git diff --check
git status --short
rg -n "GROQ_|OPENROUTER_|api.groq.com" apps/bot README.md docs/BOT_API.md docs/BOT_IMPLEMENTATION.md
```

Expected: no whitespace errors, only intentional files are changed, and the search returns no current Groq/OpenRouter configuration references.

- [ ] **Step 5: Commit any verification-only corrections and push**

Stage only the files corrected during verification, commit them with a scoped message, then push `codex/fireworks-deepseek-workflow`. Railway must receive real `FIREWORKS_API_KEY` and `BRAVE_SEARCH_API_KEY` values before deployment; never commit or print them.
