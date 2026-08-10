# Gemma 4 OpenRouter Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Default the bot's OpenRouter usage to Gemma 4 31B while retaining environment overrides and provider-neutral routing.

**Architecture:** The bot continues to send its existing model, privacy, structured-output, and research settings through OpenRouter. Configuration selects `google/gemma-4-31b-it` only when the operator did not set `OPENROUTER_MODEL`; request construction no longer supplies a provider ordering, leaving compatible-provider selection to OpenRouter.

**Tech Stack:** TypeScript, Vitest, OpenRouter Chat Completions API, npm workspaces.

## Global Constraints

- Preserve `OPENROUTER_MODEL` as an operator override.
- Keep report-writing `zdr: true`, and keep `data_collection: "deny"` and `require_parameters: true` on all OpenRouter requests.
- Do not pin, order, or prefer providers in application code.
- Do not change prompts, JSON schemas, web research behavior, timeouts, retries, or the bot/API contract.
- Update `README.md`, `apps/bot/.env.example`, `docs/BOT_API.md`, and `docs/BOT_IMPLEMENTATION.md` when their configuration or behavior text changes.

---

### Task 1: Make the default and routing provider-neutral

**Files:**
- Modify: `apps/bot/test/config.test.ts:22-27`
- Modify: `apps/bot/test/report-writer.test.ts:115,269-282,543-556,692-705`
- Modify: `apps/bot/src/config.ts:78`
- Modify: `apps/bot/src/report-writer.ts:1160-1187`
- Modify: `apps/bot/.env.example:20-23`
- Modify: `README.md:96-103`
- Modify: `docs/BOT_API.md:79,808`
- Modify: `docs/BOT_IMPLEMENTATION.md:73,187-191,287-292,618-621`

**Interfaces:**
- Consumes: `loadBotConfig(env): BotConfig` and `new ReportWriter(apiKey, model, supportedCountries, dependencies)`.
- Produces: `BotConfig.openRouterModel` defaults to `"google/gemma-4-31b-it"`; all OpenRouter request payloads use provider objects without an `order` property.

- [ ] **Step 1: Write the failing tests**

Change the configuration expectation and test fixture to the desired default. Update request-payload assertions so they require the preserved constraints but no provider order:

```ts
it("requires an OpenRouter key and defaults to Gemma 4 31B", () => {
  const config = loadBotConfig(environment());
  expect(config.openRouterModel).toBe("google/gemma-4-31b-it");
});

expect(research.provider).toEqual({
  data_collection: "deny",
  require_parameters: true
});

expect(writing.provider).toEqual({
  zdr: true,
  data_collection: "deny",
  require_parameters: true
});
```

- [ ] **Step 2: Run the focused tests to verify they fail**

Run: `npm.cmd test -w @discord-dsa/bot -- config.test.ts report-writer.test.ts`

Expected: FAIL because the default is still `minimax/minimax-m2.7` and request bodies still contain `provider.order`.

- [ ] **Step 3: Write the minimal implementation**

Replace the default in `loadBotConfig` and simplify the two routing helpers:

```ts
openRouterModel: env.OPENROUTER_MODEL?.trim() || "google/gemma-4-31b-it",

private provider() {
  return { zdr: true, data_collection: "deny", require_parameters: true };
}

private researchProvider() {
  return { data_collection: "deny", require_parameters: true };
}
```

Update the environment example and operator docs to name Gemma 4 31B, remove claims of preferred MiniMax providers, and state that OpenRouter selects a compatible provider under the retained constraints.

- [ ] **Step 4: Run focused tests to verify they pass**

Run: `npm.cmd test -w @discord-dsa/bot -- config.test.ts report-writer.test.ts`

Expected: PASS; all relevant payload assertions show no `provider.order`.

- [ ] **Step 5: Run the repository validation suite**

Run:

```powershell
npm.cmd run lint
npm.cmd run typecheck
npm.cmd test
npm.cmd run build
npm.cmd run audit:high
```

Expected: every command exits successfully. Do not run the authorized Discord transport diagnostics.

- [ ] **Step 6: Commit the implementation**

```powershell
git add -- apps/bot/src/config.ts apps/bot/src/report-writer.ts apps/bot/test/config.test.ts apps/bot/test/report-writer.test.ts apps/bot/.env.example README.md docs/BOT_API.md docs/BOT_IMPLEMENTATION.md docs/superpowers/plans/2026-08-10-gemma-4-openrouter-routing.md
git commit -m "feat(bot): default OpenRouter to Gemma 4"
```
