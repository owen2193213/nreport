# Message Report Content-First Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make message-report AI drafts focus on reported message content and the reporter's explanation, using the author name only when needed for clarity.

**Architecture:** Update the existing generalized initial writer prompt with a narrowly scoped message-report instruction. Protect the behavior with the existing mocked OpenRouter request test, which observes the actual outgoing writer conversation.

**Tech Stack:** TypeScript, Vitest, OpenRouter chat-completions request payloads.

## Global Constraints

- Preserve the API/bot ownership boundary; this change is bot-local.
- Do not change research behavior, report schemas, evidence fields, or the 512-character report limit.
- Keep profile and server report guidance unchanged.
- All final report text remains entirely in English.

---

### Task 1: Add message-specific writer guidance

**Files:**
- Modify: `apps/bot/test/report-writer.test.ts:618-646`
- Modify: `apps/bot/src/report-writer.ts:380-394`

**Interfaces:**
- Consumes: `initialWriterPrompt(): string`, included in `ReportWriter.generate()`'s writer conversation.
- Produces: Writer guidance that makes the subject of a message report the reported message content and the reporter explanation, not an unnecessary author-name reference.

- [ ] **Step 1: Write the failing test**

Add this assertion to the existing message-flow writer request test after the existing `Use this adaptable structure` assertion:

```ts
expect(messages).toContain(
  "For message reports, lead with the reported message's content or conduct and the reporter explanation"
);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm.cmd test -w @discord-dsa/bot -- report-writer.test.ts`

Expected: FAIL because the outgoing writer conversation does not yet contain the message-specific instruction.

- [ ] **Step 3: Write minimal implementation**

Append this sentence to the `initialWriterPrompt()` array immediately after the adaptable-structure guidance:

```ts
"For message reports, lead with the reported message's content or conduct and the reporter explanation; mention the author's username only when necessary for factual clarity."
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm.cmd test -w @discord-dsa/bot -- report-writer.test.ts`

Expected: PASS, including the new assertion and all existing report-writer tests.

- [ ] **Step 5: Commit**

```bash
git add apps/bot/src/report-writer.ts apps/bot/test/report-writer.test.ts docs/superpowers/plans/2026-08-08-message-report-content-first.md
git commit -m "fix: focus message reports on content"
```
