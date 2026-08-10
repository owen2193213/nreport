# AI Contract Field Ownership Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove fixed and previously resolved fields from AI JSON contracts so later stages cannot repeat or change application-owned state.

**Architecture:** Build the planner schema from only unresolved Auto fields, then merge the planner's choices with fixed draft values inside the application. Reduce synthesis to model-owned research and report fields; attach immutable country, category, and explanation after parsing. Keep refinement and report repair report-only.

**Tech Stack:** TypeScript, Vitest, Fireworks Chat Completions, Brave Search, npm workspaces

## Global Constraints

- Fixed or resolved country, category, and reporter explanation must never appear in a later AI output schema.
- Existing one-follow-up-search, one-repair, provider retry, privacy, and usage-accounting behavior remains unchanged.
- Reasoning calls embed the reduced schema in the prompt; non-reasoning calls use Fireworks JSON Schema.
- No new provider, fallback, dependency, or deployment variable is introduced.

---

### Task 1: Planner outputs only unresolved fields

**Files:**
- Modify: `apps/bot/src/report-writer.ts`
- Test: `apps/bot/test/report-writer.test.ts`

**Interfaces:**
- Consumes: `ReportDraft` fixed/Auto values and the existing Fireworks completion client.
- Produces: `parsePlan(content, draft, countries)` returning a complete `ResearchPlan` after merging fixed draft values with AI-selected Auto values.

- [ ] **Step 1: Write failing tests for fixed-field omission**

Add a test that captures the planner request for a draft with fixed country, category, and explanation and asserts the planner JSON Schema does not contain `country`, `reportType`, or `reportReason`. Return a plan containing only research fields:

```ts
it("omits fixed fields from the planner output contract", async () => {
  request.mockResolvedValueOnce(
    fireworks({
      termResearchRequired: false,
      termSearchQuery: null,
      lawResearchRequired: false,
      lawSearchQuery: null,
      provisionalLawReference: "Germany's Criminal Code (StGB), section 130"
    })
  );
  await writer.generate(reportDraft, actor);
  const schema = bodyAt<{ messages: Array<{ content: string }> }>(request, 0).messages[1]!.content;
  expect(schema).not.toContain('"country"');
  expect(schema).not.toContain('"reportType"');
  expect(schema).not.toContain('"reportReason"');
});
```

Update the mocked synthesis response in that test to use the reduced synthesis shape from Task 2 if needed while keeping the initial assertion focused on the planner request.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npm.cmd test -w @discord-dsa/bot -- report-writer.test.ts -t "omits fixed fields"`

Expected: FAIL because the current planner schema always contains all three fields.

- [ ] **Step 3: Make planner schema conditional and merge application state**

Change `plannerResponseFormat` so `country`, `reportType`, and `reportReason` are added only when their corresponding draft value is absent. Keep research fields required. Change `parsePlan` to read optional AI fields only for Auto values and use `draft.country`, `draft.reportType`, and `draft.reportBrief` directly when fixed. Preserve the existing supported-country, supported-category, explanation-length, research-query, and provisional-law validations.

Use a single complete `ResearchPlan` after parsing:

```ts
const country = draft.country ?? parsedCountry;
const reportType = draft.reportType ?? parsedReportType;
const reportReason = draft.reportBrief ?? parsedReportReason;
```

Remove fixed-field echo instructions from `plannerPrompt`; describe fixed values as context only.

- [ ] **Step 4: Add and run Auto-field coverage**

Extend the existing Auto test to assert that all three Auto properties are present in the planner schema and that the final result contains the AI selections. Run:

`npm.cmd test -w @discord-dsa/bot -- report-writer.test.ts -t "Auto|fixed fields"`

Expected: PASS.

- [ ] **Step 5: Commit the planner boundary**

```powershell
git add -- apps/bot/src/report-writer.ts apps/bot/test/report-writer.test.ts
git commit -m "fix(bot): keep fixed fields out of AI planning output"
```

### Task 2: Synthesis outputs only model-owned fields

**Files:**
- Modify: `apps/bot/src/report-writer.ts`
- Test: `apps/bot/test/report-writer.test.ts`

**Interfaces:**
- Consumes: immutable `ResearchPlan`, research materials, and the Fireworks client.
- Produces: a completed synthesis containing only `lawReference`, `researchSummary`, and `report`, or a follow-up containing only `followUpType` and `followUpQuery`; `generate` attaches the plan's immutable fields to `WriterResult`.

- [ ] **Step 1: Write the mismatch regression as a reduced-contract test**

Replace duplicated resolved fields in the synthesis fixture with:

```ts
{
  status: "completed",
  followUpType: null,
  followUpQuery: null,
  lawReference: "Germany's Criminal Code (StGB), section 130",
  researchSummary: "The supplied conduct is relevant to the cited provision.",
  report: "Please review the supplied evidence under Germany's Criminal Code (StGB), section 130."
}
```

Assert that the synthesis schema/prompt contains none of `country`, `reportType`, or `reportReason`, and that the final `WriterResult` still contains the plan's immutable values.

- [ ] **Step 2: Run the regression and verify RED**

Run: `npm.cmd test -w @discord-dsa/bot -- report-writer.test.ts -t "synthesis.*resolved fields"`

Expected: FAIL because the current synthesis parser requires all three repeated fields.

- [ ] **Step 3: Reduce synthesis types, schema, parser, and validation**

Remove `country`, `reportType`, and `reportReason` from `CompletedSynthesis` and `FollowUpSynthesis`. Remove them from `synthesisResponseFormat`, `parseSynthesis`, `synthesisPrompt` echo instructions, and `validateCompleted`. Delete mismatch errors that can no longer occur. Keep law reference, research summary, report length, follow-up status, and null-field consistency validation strict.

Construct application output from the plan:

```ts
return {
  country: plan.country,
  reportType: plan.reportType,
  reportReason: plan.reportReason,
  legalResearch: {
    country: plan.country,
    lawReference: completion.lawReference,
    summary: completion.researchSummary,
    sources,
    researchedAt,
    searchRequests
  },
  report: completion.report,
  conversation
};
```

- [ ] **Step 4: Keep follow-up and repair contracts narrow**

Update the follow-up fixture so it contains only status, follow-up type/query, and null model-owned completion fields. Ensure synthesis repair regenerates only synthesis-owned fields and cannot mention immutable fields in its response schema. Retain report-only `reportResponseFormat` for refinement.

- [ ] **Step 5: Run all report-writer tests**

Run: `npm.cmd test -w @discord-dsa/bot -- report-writer.test.ts`

Expected: PASS with no field-drift error tests remaining.

- [ ] **Step 6: Commit the synthesis boundary**

```powershell
git add -- apps/bot/src/report-writer.ts apps/bot/test/report-writer.test.ts
git commit -m "fix(bot): keep resolved fields out of AI synthesis output"
```

### Task 3: Document and verify the ownership contract

**Files:**
- Modify: `docs/BOT_API.md`
- Modify: `docs/BOT_IMPLEMENTATION.md`
- Modify: `README.md`

**Interfaces:**
- Consumes: the implemented planner and synthesis contracts.
- Produces: operator documentation that accurately describes application-owned immutable state and reduced AI outputs.

- [ ] **Step 1: Update canonical documentation**

Document that fixed fields are omitted from planner output, Auto selections are merged into application state, and synthesis never outputs resolved country, category, or explanation. State that repair/refinement remain report-only and mismatch failures are eliminated by construction.

- [ ] **Step 2: Run focused and full validation**

Run, stopping on the first failure:

```powershell
npm.cmd test -w @discord-dsa/bot -- report-writer.test.ts
npm.cmd run lint
npm.cmd run typecheck
npm.cmd test
npm.cmd run build
npm.cmd run audit:high
git diff --check
```

Expected: all commands exit 0; the full test summary reports zero failures; npm audit reports zero high-severity vulnerabilities.

- [ ] **Step 3: Commit documentation and final corrections**

```powershell
git add -- README.md docs/BOT_API.md docs/BOT_IMPLEMENTATION.md apps/bot/src/report-writer.ts apps/bot/test/report-writer.test.ts
git commit -m "docs(bot): document AI field ownership"
```

- [ ] **Step 4: Merge and push after verification**

Merge the verified feature branch into `main`, rerun `npm.cmd test` on merged `main`, and push `main` only after the merged suite passes.
