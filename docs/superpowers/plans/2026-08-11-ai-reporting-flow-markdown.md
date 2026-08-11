# AI Reporting Flow Markdown Guide Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create a detailed, source-faithful Markdown guide to every normal and variant Discord DSA reporting path, including exact AI prompt templates, structured outputs, examples, and plain-language explanations.

**Architecture:** Add one canonical explanatory document at `docs/AI_REPORTING_FLOW.md`. Organize it from user entry through provider calls and application validation to API/Discord lifecycle processing; keep exact prompts and schemas in fenced blocks and explain each block immediately afterward.

**Tech Stack:** GitHub-flavored Markdown, Mermaid, JSON/HTTP/text code fences, and the existing TypeScript implementation as source of truth.

## Global Constraints

- Cover `message_urf`, `user_urf`, and `guild_urf`, plus Manual, Quick Report, experimental batches, Refine, Regenerate, and Rewrite & resend.
- Reproduce current prompt sentences and response schemas exactly, with named placeholders and explicit conditional markers.
- Clearly separate application-owned, planner-owned, and synthesis-owned fields.
- Clearly label every generated output as illustrative rather than captured provider data.
- Include current Fireworks DeepSeek reasoning/token settings and Brave request/query limits.
- Include no real Discord data, credentials, provider transcripts, or secrets.
- Prefer current code over stale prose when they disagree.

---

### Task 1: Write and verify the AI reporting-flow guide

**Files:**
- Create: `docs/AI_REPORTING_FLOW.md`
- Reference: `apps/bot/src/report-writer.ts`
- Reference: `apps/bot/src/brave-research.ts`
- Reference: `apps/bot/src/fireworks-client.ts`
- Reference: `apps/bot/src/commands.ts`
- Reference: `apps/bot/src/types.ts`
- Reference: `packages/report-contracts/src/catalog.ts`
- Reference: `docs/BOT_IMPLEMENTATION.md`
- Reference: `docs/BOT_API.md`

**Interfaces:**
- Consumes: Current report entry points, evidence shapes, prompt fragments, conditional JSON schemas, provider settings, validations, and lifecycle contracts.
- Produces: A standalone operator/developer guide whose headings and local links remain stable enough to reference during debugging.

- [x] **Step 1: Draft the normal flow and report-type inputs**

Create the overview, shared Mermaid diagram, input/evidence comparison, combined-form behavior, AI/manual split, field-ownership table, and report-type-specific examples. Explain media exclusion and how fixed versus Auto fields differ.

- [x] **Step 2: Add exact provider prompt flows and outputs**

Add the planner system prompt, complete conditional planner template, planner schema, fixed/all-Auto example outputs, and validation explanation. Add Brave term/law request shapes and safeguards. Add the writer system prompt, complete synthesis template, synthesis schema, completed/follow-up examples, and bounded repair behavior.

- [x] **Step 3: Add editing, variant, and backend lifecycle paths**

Add exact Refine, report-only Repair, synthesis Repair, experimental variation, and rewrite prompt branches. Explain Regenerate, Quick Report, both experimental modes, final reviewed API inputs, credit reservation, verification, Discord submission, lifecycle updates, automatic appeal, and immutable retry behavior.

- [x] **Step 4: Run document-fidelity checks**

Check that every required prompt sentence, schema property, flow identifier, token limit, timeout, and retry bound appears. Check all referenced local files exist, all fenced blocks are balanced, Mermaid has one start and end fence, and no `TBD`, `TODO`, real secret prefix, or trailing whitespace remains.

- [x] **Step 5: Run repository verification and commit**

Run `git diff --check` and `npm.cmd test`. Stage only `docs/AI_REPORTING_FLOW.md` and this plan, leaving unrelated untracked files untouched, then commit with `docs: document AI reporting flow`.
