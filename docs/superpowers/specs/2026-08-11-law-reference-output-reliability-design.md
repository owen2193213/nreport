# Law Reference Output Reliability Design

## Goal

Reduce AI drafting failures caused by missing legal references while keeping the existing legal-reporting validation safeguards intact.

## Scope

The change is limited to the bot's Fireworks prompts, synthesis repair eligibility, and report-writer regression tests. It does not change the API contract, persistence format, provider configuration, or report lifecycle.

## Design

The planning prompt will define the two valid legal-planning outcomes explicitly: either set `lawResearchRequired` to `true`, provide a non-empty sanitized `lawSearchQuery`, and set `provisionalLawReference` to `null`; or set it to `false`, set `lawSearchQuery` to `null`, and provide a non-empty provisional country-specific reference with the law title and provision.

The synthesis prompt will define the two valid completion outcomes explicitly: a completed response must include non-empty `lawReference`, `researchSummary`, and `report` fields; when the available evidence cannot support those fields, it must return the existing single follow-up-research shape instead.

The existing one-pass synthesis repair will also cover missing `lawReference` and missing `researchSummary`. The repair prompt already asks for the complete synthesis object, so it can correct these model-owned omissions without changing evidence or legal conclusions. Planning remains fail-closed because no safe repair context exists before a legal route is chosen.

## Error Handling

The existing local validators remain authoritative. A planning response missing a provisional reference still fails immediately. A synthesis response that omits a required law field receives one repair request; a second invalid response preserves the existing safe failure behavior.

## Testing

Add tests that inspect the outbound planner and synthesis prompts for the explicit field requirements. Add a report-writer regression test where the initial completed synthesis lacks a law reference and the repair response supplies it, asserting generation succeeds and exactly one repair request is made.
