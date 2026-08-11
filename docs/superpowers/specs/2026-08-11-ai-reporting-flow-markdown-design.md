# AI Reporting Flow Markdown Guide Design

## Outcome

Create `docs/AI_REPORTING_FLOW.md` as the detailed written companion to the interactive reporting-flow visual. The guide must explain the current implementation in ordinary language while retaining the exact prompt text, conditional response contracts, provider settings, example outputs, validation rules, and recovery paths needed for debugging.

## Audience

The primary reader is an operator or developer investigating how one Discord report moves from a command or context-menu action through AI planning, optional research, report writing, review, API creation, and Discord lifecycle processing. The reader should not need to open the TypeScript source to understand the normal path or determine which component owns a field.

## Structure

The document will contain:

1. A short overview and Mermaid flowchart of the shared route.
2. A comparison of message, profile, and server report inputs and AI-visible evidence.
3. The combined form, AI/manual split, and field-ownership rules.
4. The complete planning request: exact system prompt, exact conditional user-prompt template, conditional JSON Schema, valid examples, and validation failures.
5. The Brave terminology and legal-research branches, including request shapes and query safeguards.
6. The complete synthesis request: exact system prompt, exact user-prompt template, response schema, completed and follow-up examples, and repair behavior.
7. Review actions, including manual edit, Refine, Regenerate, and Change country.
8. Quick Report, both experimental batch modes, and appeal Rewrite & resend.
9. The bot-to-API request, credit boundary, verification, Discord submission, lifecycle updates, appeal, and retry paths.
10. A compact failure and retry reference plus a source-of-truth file list.

Every technical block will be followed by a short explanation of what it means and why the boundary exists. Example values will be clearly labeled as illustrative and will not imitate captured provider responses.

## Fidelity Rules

- Reproduce the writer and planner system prompts exactly.
- Reproduce every sentence assembled by `plannerPrompt`, `synthesisPrompt`, `initialWriterPrompt`, `refinementPrompt`, `repairPrompt`, and `synthesisRepairPrompt` exactly, using named placeholders and explicit conditional markers for runtime branches.
- Reproduce the planner, synthesis, and report-only JSON Schemas with their current property names, types, limits, required fields, and `additionalProperties: false` behavior.
- Explain that supplied country, category, and explanation are omitted from planner output, and that all three are absent from synthesis output.
- Use the current Fireworks DeepSeek and Brave architecture with no OpenRouter fallback.
- Keep examples generic and free of real Discord identifiers, report data, secrets, or provider transcripts.
- Treat code as the source of truth where older prose documentation differs.

## Verification

- Check every displayed prompt sentence and schema field against `apps/bot/src/report-writer.ts`.
- Check Brave request shapes and limits against `apps/bot/src/brave-research.ts`.
- Check Fireworks timeouts, retries, reasoning settings, and token allowances against `apps/bot/src/fireworks-client.ts` and the call sites.
- Check report-type inputs and final API payloads against `apps/bot/src/commands.ts`, `apps/bot/src/types.ts`, and `docs/BOT_API.md`.
- Run Markdown hygiene checks for trailing whitespace, broken local links, unresolved drafting markers, and malformed Mermaid/code fences.
- Run the repository test suite before completion.

