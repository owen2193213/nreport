# Reporting Flow Visual Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and verify one interactive visual that documents every current Discord DSA reporting route and exposes the exact AI prompts, schemas, outputs, ownership boundaries, and recovery paths.

**Architecture:** Create one self-contained HTML fragment outside the repository in the thread visualization directory. The fragment stores the three report-type evidence descriptions and the shared pipeline as local JavaScript data; native controls select report type, drafting mode, and a flow node, while one detail region renders the selected node's complete technical contract.

**Tech Stack:** Semantic HTML, scoped CSS, inline JavaScript, native buttons, and the Codex visualization host utilities; no network requests or runtime dependencies.

## Global Constraints

- The three primary flows are `message_urf`, `user_urf`, and `guild_urf`.
- Manual mode must bypass Fireworks and Brave completely.
- Prompt text and JSON schemas must match the current TypeScript source exactly, with runtime data represented by named placeholders.
- Country, category, and reporter explanation are immutable synthesis context and must not appear in synthesis output.
- Show Quick Report, experimental batches, refinement/regeneration, and appeal rewrite/resend as compact variants.
- Do not include real user data, provider responses, secrets, or outbound API calls.
- The fragment must remain usable at 736 px and 360 px in light and dark themes.

---

### Task 1: Build and verify the reporting-flow visual

**Files:**
- Create: `C:/Users/Zhuoxuan/.codex/visualizations/2026/08/07/019fd9be-19b8-7163-9f53-5813f05e34d1/discord-dsa-reporting-flow.html`
- Reference: `apps/bot/src/report-writer.ts`
- Reference: `apps/bot/src/brave-research.ts`
- Reference: `apps/bot/src/fireworks-client.ts`
- Reference: `apps/bot/src/commands.ts`
- Reference: `apps/bot/src/types.ts`
- Reference: `docs/BOT_IMPLEMENTATION.md`
- Reference: `docs/BOT_API.md`

**Interfaces:**
- Consumes: Current prompt strings, conditional JSON Schemas, report evidence shapes, provider settings, validations, and lifecycle descriptions from the reference files.
- Produces: One HTML fragment whose root is `#dsa-report-flow`, with controls named `data-flow`, `data-mode`, and `data-node`; the script exposes no globals and performs no external requests.

- [x] **Step 1: Create the complete fragment**

Use a transparent top-level surface with:

- A concise title and current implementation label.
- Native report-type buttons for Message, Profile, and Server.
- Native AI/Manual drafting-mode buttons.
- A vertically connected sequence: entry and evidence, modal and ownership, planner, optional searches, synthesis, optional follow-up and repair, review, API creation, Discord lifecycle, and appeal/retry outcomes.
- A selected-node detail section containing provider settings, exact system prompt, exact user prompt template, exact response schema, valid example output, validation, and failure behavior whenever applicable.
- A variants section linking Quick Report, both experimental batch modes, Refine, Regenerate, and Rewrite & resend to their divergence points.
- Local JavaScript that updates report-specific node labels and details, hides the AI-only path in Manual mode, updates `aria-pressed`, and keeps one selected node.

- [x] **Step 2: Check source fidelity**

Compare the displayed strings with `WRITER_SYSTEM_PROMPT`, the planning system prompt, `plannerPrompt`, `initialWriterPrompt`, `refinementPrompt`, `repairPrompt`, `synthesisRepairPrompt`, `plannerResponseFormat`, `synthesisResponseFormat`, and `reportResponseFormat`. Confirm the visual shows:

- Planner: high reasoning, 8,192 completion tokens.
- Research synthesis: high reasoning, 12,288 completion tokens.
- Mechanical synthesis/refine/repair: no reasoning, 4,096 completion tokens.
- One 90-second workflow deadline and provider calls capped at 45 seconds.
- One eligible Fireworks retry, one eligible Brave retry, one synthesis follow-up search, and one output repair.
- Brave Web Search for terminology and Brave LLM Context for law research.
- Media URLs omitted from every report-type evidence shape.

- [x] **Step 3: Validate markup and behavior**

Read the fragment back and reject literal escaped markup (`\\"`) or newline escapes used in place of real markup. Inspect the script for missing selectors and undefined identifiers. Render the fragment with the bundled visualization renderer and verify that selecting each report type, Manual mode, and several detail nodes updates the visible content without console errors.

- [x] **Step 4: Verify responsive presentation**

Inspect the rendered result at approximately 736 px and 360 px. Confirm controls wrap, the flow remains vertical, prompt blocks wrap without horizontal page overflow, buttons retain visible focus behavior, and every meaningful node is keyboard-selectable. Check both light and dark host themes.

- [x] **Step 5: Deliver the visual**

Return the visualization content reference for the exact fragment path and one short note explaining that selecting a stage reveals its prompt and structured contract.
