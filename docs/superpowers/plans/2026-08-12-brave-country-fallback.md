# Brave Search Country Fallback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route every report country unsupported by Brave Search to Brave's `ALL` target so research does not fail with HTTP 422.

**Architecture:** Keep report-country ownership in the API and place Brave-specific target normalization in `brave-research.ts`. Both Brave request variants consume one helper, while report country and legal query semantics stay intact.

**Tech Stack:** TypeScript, Vitest, Brave Search API.

## Global Constraints

- Preserve the API/bot ownership boundary; do not alter API country validation or generated identities.
- Do not log secrets or sensitive report context.
- Use Brave's documented country targets: `AT`, `BE`, `DK`, `FI`, `FR`, `DE`, `GR`, `IT`, `NL`, `PL`, `PT`, `ES`, and `SE`; use `ALL` for every other country.
- Update the implementation guide because legal-search operational behavior changes.

---

### Task 1: Normalize Brave Country Targets

**Files:**
- Modify: `apps/bot/src/brave-research.ts`
- Modify: `apps/bot/test/report-writer.test.ts`

**Interfaces:**
- Produces: `braveSearchCountry(country: string): string`
- Consumes: report-country code passed to `BraveResearchClient.search`.

- [ ] **Step 1: Write the failing regression test**

```ts
expect(braveSearchCountry("DE")).toBe("DE");
expect(braveSearchCountry("IE")).toBe("ALL");
for (const country of ["BG", "HR", "CY", "CZ", "HU", "IE", "LV", "LT", "LU", "MT", "RO", "SK", "SI"]) {
  expect(braveSearchCountry(country)).toBe("ALL");
}
```

- [ ] **Step 2: Run the focused test to verify it fails**

Run: `npm.cmd test -w @discord-dsa/bot -- report-writer.test.ts`

Expected: FAIL because `braveSearchCountry` does not yet exist.

- [ ] **Step 3: Implement the minimum helper and route requests through it**

```ts
const BRAVE_COUNTRIES = new Set(["AT", "BE", "DK", "FI", "FR", "DE", "GR", "IT", "NL", "PL", "PT", "ES", "SE"]);

export function braveSearchCountry(country: string): string {
  const normalized = country.toUpperCase();
  return BRAVE_COUNTRIES.has(normalized) ? normalized : "ALL";
}
```

Use the helper for the Web Search URL parameter and LLM Context JSON body.

- [ ] **Step 4: Add an integration-level request assertion**

```ts
const irelandDraft = { ...draft(), country: "IE" };
await writer(request).generate(irelandDraft, ACTOR);
expect(bodyAt<Record<string, unknown>>(request, 1).country).toBe("ALL");
```

- [ ] **Step 5: Run the focused test to verify it passes**

Run: `npm.cmd test -w @discord-dsa/bot -- report-writer.test.ts`

Expected: PASS with the fallback and existing research tests green.

### Task 2: Document and Verify the Operational Behavior

**Files:**
- Modify: `docs/BOT_IMPLEMENTATION.md:265-269`

**Interfaces:**
- Documents: Brave country-targeting fallback for term and legal research.

- [ ] **Step 1: Update the research behavior paragraph**

Add that Brave receives its supported country code when available and `ALL` otherwise; the country-specific query stays unchanged.

- [ ] **Step 2: Run full repository verification**

Run: `npm.cmd run lint; npm.cmd run typecheck; npm.cmd test; npm.cmd run build; npm.cmd run audit:high`

Expected: each command exits 0.

- [ ] **Step 3: Commit the scoped change**

```powershell
git add apps/bot/src/brave-research.ts apps/bot/test/report-writer.test.ts docs/BOT_IMPLEMENTATION.md docs/superpowers/specs/2026-08-12-brave-country-fallback-design.md docs/superpowers/plans/2026-08-12-brave-country-fallback.md
git commit -m "fix(bot): fall back to all Brave countries"
```
