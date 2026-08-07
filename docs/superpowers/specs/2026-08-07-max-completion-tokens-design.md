# Max Completion Tokens Migration

## Goal

Use MiniMax's current completion-budget parameter for every report-producing OpenRouter request so mandatory reasoning and the final structured report share the intended 4,096-token budget.

## Scope

- Replace `max_tokens: 4_096` with `max_completion_tokens: 4_096` for initial writing, refinement, and repair requests.
- Leave legal-research requests uncapped.
- Preserve the 512-character report limit, mandatory reasoning configuration, structured JSON schema, provider routing, retry behavior, and timeouts.
- Update canonical bot documentation to name the new request parameter.

## Verification

- Request-shape tests must require `max_completion_tokens: 4_096` and reject the deprecated `max_tokens` field for report-producing calls.
- Run the bot report-writer tests first, then the repository-required lint, workspace typecheck, tests, build, and high-severity audit.

## Error Handling

No runtime error-handling changes are included. Existing JSON validation and one conversational repair attempt remain responsible for malformed provider output.
