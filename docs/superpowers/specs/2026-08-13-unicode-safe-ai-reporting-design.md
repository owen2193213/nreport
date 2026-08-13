# Unicode-Safe AI Reporting Design

## Outcome

Message evidence and reporter guidance can contain Unicode, including invisible characters, without breaking the AI workflow or report submission. AI-generated reporter explanations and final report text contain printable ASCII only, so copied Unicode cannot reach Discord's reporting form or PostgreSQL JSON storage through AI output.

## Scope

This change applies to the bot-owned AI report-writing workflow and to API validation of captured message evidence. It does not change the Discord message snapshot shown to the reporter, the bot's intentional UI characters (for example country flags and arrows), user or server metadata, or the low-level Discord transport contract.

## Design

### Preserve evidence for analysis

The bot passes captured message evidence to the planner and writer without stripping non-ASCII characters. This lets the model analyze obfuscated text containing zero-width characters and ordinary international text. Evidence remains data and is not treated as instructions.

PostgreSQL cannot represent `U+0000` in text or JSON values. The API therefore removes literal NUL characters from incoming free-form captured message text during request validation. All other well-formed Unicode evidence is preserved. This normalization happens at the API ownership boundary before the input is persisted.

### Prefer plain AI output

The planner and writer prompts explicitly require generated reporter explanations, reports, search queries, and legal prose to use printable ASCII characters only. They also tell the model to omit invisible or non-ASCII characters rather than spelling them as `\\uXXXX` escapes. The model may explain obfuscation in ordinary ASCII words when relevant, but it must not copy the character.

### Enforce the output contract

Prompting is advisory, so the bot enforces the contract after parsing model output. A focused sanitizer removes every character outside printable ASCII (`U+0020` through `U+007E`) and trims the result. It is applied to AI-produced textual plan fields and synthesis/refinement fields before their existing semantic and length validation.

Sanitization precedes validation so a model response made empty by removal is rejected through the existing repair path. Length checks apply to the actual sanitized text that could be saved or submitted. The sanitizer does not modify user-authored evidence or intentional bot UI copy.

### Failure and repair behavior

If sanitization leaves a required field empty or otherwise invalid, the existing one-repair workflow asks the model for corrected structured output. Repair prompts repeat the printable-ASCII requirement. If repair still fails, the current safe failure and manual-edit recovery behavior remains unchanged.

## Data flow

1. The bot captures the original Discord message text, including Unicode and zero-width characters.
2. The AI receives that evidence unchanged and analyzes it.
3. AI structured responses are parsed and their generated prose fields are reduced to printable ASCII.
4. Existing validation, repair, draft encryption, review, and submission operate on the sanitized AI text.
5. When a report request reaches the API, literal NUL characters are removed from captured free-form message text before PostgreSQL persistence; other Unicode evidence remains intact.

## Testing

Bot report-writer regression tests cover message evidence containing a zero-width space, emoji, accented text, and NUL. They verify that the full evidence reaches the model request while every returned AI-owned report/explanation field is printable ASCII and still passes the workflow.

API validation tests verify that captured evidence preserves ordinary Unicode and zero-width spaces while removing literal NUL characters before the validated request is stored. Existing malformed-input and length limits remain enforced.

After TypeScript changes, run the required repository checks: lint, workspace typecheck, tests, build, and the high-severity dependency audit. Update `docs/BOT_IMPLEMENTATION.md` because the AI workflow's operational behavior changes; the public bot-to-API shape does not change, so `docs/BOT_API.md` needs no contract update.

## Security and privacy

No sensitive evidence or generated text is added to logs. The change preserves the existing API/bot ownership boundary, does not add retries to final Discord submission, and does not expose raw message evidence beyond the existing authorized AI and API paths.
