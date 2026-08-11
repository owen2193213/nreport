# Reporting Flow Visual Design

## Outcome

Create one interactive flowchart that documents the implemented Discord DSA reporting workflow. It must make the overall route easy to scan while allowing an operator to inspect the complete AI request template, expected structured response, validation, and recovery behavior at each AI stage.

The visual is explanatory only. It lives in the thread's visualization directory, outside the deployable repository, and does not call providers or expose real report data.

## Scope

The primary selectable flows are:

- Message report (`message_urf`)
- User-profile report (`user_urf`)
- Server report (`guild_urf`)

The shared pipeline also shows these variants without duplicating the entire chart:

- AI-disabled manual reporting
- Quick Report Message
- Experimental 10x Same Category
- Experimental All Categories
- Refine and regenerate
- Appeal rewrite and resend

The operational lifecycle continues through review, credit reservation, API creation, email verification, Discord submission, lifecycle updates, automatic appeal where eligible, and retry or rewrite outcomes.

## Layout

The top of the visual contains two compact control groups:

1. Report type: Message, Profile, or Server.
2. Drafting mode: AI or Manual.

Below the controls, a single vertical flowchart shows the active route. Shared stages are not repeated. Report-type-specific input and evidence nodes change when the selected report type changes. Manual mode bypasses every Fireworks and Brave stage.

Selecting a flowchart node opens one detail area below the chart. For ordinary stages it explains inputs, ownership, output, and validation. For AI stages it additionally shows the complete system prompt, user prompt template, JSON Schema, provider settings, and a schema-valid illustrative response. Long prompt text appears only in this selected-node detail so the chart remains readable.

A compact variants section attaches Quick Report, experimental batches, refinement/regeneration, and appeal rewrite/resend to the stage where each diverges or rejoins the normal route.

## Source of Truth

The visual is derived directly from:

- `apps/bot/src/commands.ts`
- `apps/bot/src/interactions.ts`
- `apps/bot/src/report-writer.ts`
- `apps/bot/src/brave-research.ts`
- `apps/bot/src/fireworks-client.ts`
- `apps/bot/src/types.ts`
- `docs/BOT_IMPLEMENTATION.md`
- `docs/BOT_API.md`

Prompt text is reproduced exactly, with runtime values represented by clear placeholders such as `${country}`, `${reportReason}`, or `${discordEvidenceJson}`. Illustrative output values are plainly marked as examples and are not represented as provider transcripts.

## Data and Field Ownership

The visual distinguishes three kinds of state:

- Reporter or application-owned values: any supplied country, category, and explanation.
- Planner-owned values: only omitted Auto fields, plus the two independent research decisions, sanitized queries, and provisional law reference.
- Synthesis-owned values: status, one optional follow-up search request, law reference, research summary, and final report.

Country, category, and reporter explanation never appear in the synthesis output. Fixed values are omitted from the planner output schema. The bot merges Auto selections with supplied values into immutable resolved state before synthesis.

## AI Pipeline

The AI route shows:

1. Normalize a literal `Auto` explanation to omitted.
2. Build flow-specific textual evidence with media processing disabled.
3. Request a strict JSON plan from Fireworks DeepSeek using high reasoning and an 8,192-token completion allowance.
4. Validate the plan and its conditional schema.
5. Run zero, one, or two initial Brave searches. Terminology uses Web Search; law research uses LLM Context. Both run concurrently when requested.
6. Synthesize the legal result and report. Research-backed synthesis uses high reasoning and a 12,288-token allowance; no-research synthesis disables reasoning and uses provider-enforced JSON Schema with a 4,096-token allowance.
7. Permit exactly one sanitized follow-up term or law search, followed by one more synthesis. A second request fails.
8. Repair malformed or overlength synthesis once without reasoning or search.
9. Validate and retain a final report of 1–512 characters.
10. Offer review actions: submit, edit, change country, refine, regenerate, or cancel as applicable.

Refinement reuses the retained compact conversation and research, performs no search, disables reasoning, and returns only `{ "report": string }`. Regeneration starts a fresh plan and research workflow. Changing country clears retained AI context first.

## Report-Type Evidence

Message reports show the message URL and, when resolved, message/channel/server identifiers and labels, author fields, content, timestamp, attachment names and content types, and embed titles/descriptions. Attachment and embed URLs are omitted while media processing is disabled.

Profile reports show the resolved user ID, username, global display name, and bot flag. Avatar and banner URLs are omitted even when the corresponding profile element is selected.

Server reports show the server or invite target and a resolved snapshot containing ID, name, description, approximate member and presence counts, and resolution time. Icon, banner, and splash URLs are omitted while media processing is disabled.

## Expected Outputs and Errors

Each AI node includes its exact conditional JSON Schema and a valid example for the selected state. The planner example changes to demonstrate fixed fields being absent. Synthesis examples cover both `completed` and `more_research_required`.

Visible failure routes include malformed JSON, unsupported Auto values, inconsistent query flags, missing provisional law reference, unsafe search query, Brave failure, provider refusal or exhaustion, invalid follow-up, missing synthesis fields, overlength report, failed repair, and the 90-second workflow deadline.

Transport requests retry once only for eligible network, rate-limit, or server failures within the shared deadline. There is no OpenRouter or cross-provider fallback.

## Verification

Before delivery:

- Compare every displayed prompt sentence and schema field with current source.
- Confirm all primary nodes are keyboard-selectable.
- Confirm report-type and drafting-mode controls update both the chart and detail content.
- Confirm the default Message/AI view is useful without interaction.
- Check layout and interactions at approximately 736 px and 360 px widths in both light and dark themes.
- Confirm the fragment has no external requests, undefined JavaScript identifiers, horizontal overflow, or sensitive example data.

