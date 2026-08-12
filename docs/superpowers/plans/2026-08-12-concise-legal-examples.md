# Concise Legal-Report Examples Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make AI reports concise for obvious messages while showing the required legal explanation through concrete synthesis examples.

**Architecture:** Keep all changes in the writer's prompt construction. `initialWriterPrompt` defines the decision rule, and `synthesisExamples` supplies two examples that the existing schema prompt attaches to every synthesis request.

**Tech Stack:** TypeScript, Vitest.

## Global Constraints

- Retain the 512-character report limit and English-only requirement.
- Treat examples as tone and structure guidance, not reusable legal conclusions.
- Preserve the existing requirement to explain slang, abbreviations, and coded wording briefly.
- Update `docs/BOT_IMPLEMENTATION.md` for this behavioral change.

---

### Task 1: Add Prompt-Content Regression Tests

**Files:**
- Modify: `apps/bot/test/report-writer.test.ts`

**Interfaces:**
- Consumes: the synthesis request at index `1` created by `ReportWriter.generate`.
- Produces: regression coverage for the writer instruction and concrete examples.

- [ ] **Step 1: Add failing assertions**

```ts
expect(JSON.stringify(synthesis.messages)).toContain(
  "When the message's meaning is obvious, do not elaborate on it."
);
expect(synthesis.messages[1]!.content).toContain("# FUCK YOUUUU");
expect(synthesis.messages[1]!.content).toContain(
  "Section 185 prohibits insulting another person."
);
expect(synthesis.messages[1]!.content).toContain("coded wording");
```

- [ ] **Step 2: Run the focused test to verify it fails**

Run: `npm.cmd test -w @discord-dsa/bot -- report-writer.test.ts`

Expected: FAIL because no obvious-meaning instruction or concrete examples exist.

### Task 2: Add the Writing Rule and Examples

**Files:**
- Modify: `apps/bot/src/report-writer.ts`
- Modify: `apps/bot/test/report-writer.test.ts`

**Interfaces:**
- Modifies: `initialWriterPrompt(): string` and `synthesisExamples(): string[]`.

- [ ] **Step 1: Add the minimum instruction**

```ts
"When the message's meaning is obvious, do not elaborate on it. Briefly state what the named law provision prohibits and clearly connect that prohibition to the reported content."
```

- [ ] **Step 2: Replace the completed-report placeholder with two labeled concrete examples**

Include a direct-insult example for `# FUCK YOUUUU` under Germany's Criminal Code, Section 185, and an ambiguous-wording example that briefly defines the term before the concise legal connection.

- [ ] **Step 3: Run the focused test to verify it passes**

Run: `npm.cmd test -w @discord-dsa/bot -- report-writer.test.ts`

Expected: PASS.

### Task 3: Document and Verify

**Files:**
- Modify: `docs/BOT_IMPLEMENTATION.md`

- [ ] **Step 1: Document the direct-versus-ambiguous explanation rule and structural examples**

- [ ] **Step 2: Run full verification**

Run: `npm.cmd run lint; npm.cmd run typecheck; npm.cmd test; npm.cmd run build; npm.cmd run audit:high`

Expected: all commands exit 0.

- [ ] **Step 3: Commit scoped files**

```powershell
git add apps/bot/src/report-writer.ts apps/bot/test/report-writer.test.ts docs/BOT_IMPLEMENTATION.md docs/superpowers/specs/2026-08-12-concise-legal-examples-design.md docs/superpowers/plans/2026-08-12-concise-legal-examples.md
git commit -m "fix(bot): clarify concise legal report writing"
```
