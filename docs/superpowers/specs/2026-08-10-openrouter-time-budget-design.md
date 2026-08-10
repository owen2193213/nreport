# OpenRouter Time Budget Design

## Goal

Allow the legal-research and report-writing workflow to complete under normal provider routing, search, reasoning, and structured-output latency without an arbitrary 45-second cutoff.

## Design

The bot will use a five-minute workflow deadline. Each OpenRouter operation may use up to 150 seconds, but never beyond the remaining workflow deadline. This reserves time for the report-writing operation after research while keeping the interaction bounded.

The same abort signal applies while reading the non-streaming response body. If that signal aborts during JSON parsing, the bot will classify and present the failure as a timeout rather than a malformed response. Non-timeout JSON parsing failures remain malformed-response failures.

The existing `require_parameters: true`, strict JSON schema, and router-metadata header remain unchanged. OpenRouter can choose and fall back among compatible providers before it returns a non-streaming response; the bot will not pin a provider or alter routing policy.

## Error Handling and Privacy

No raw prompt, completion, router body, or credentials will be logged. The existing safe stage and latency fields remain the only operational diagnostics.

## Verification

Add focused tests for the new user-facing workflow limit and for an abort during response JSON parsing. Run the bot test suite followed by repository lint, typecheck, build, and high-severity audit.
