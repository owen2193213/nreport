# Fireworks DeepSeek Agentic Workflow Design

## Goal

Replace Groq with Fireworks-hosted DeepSeek V4 Flash while preserving the newer conditional Brave
research workflow. Straightforward rewriting should stay fast, while planning and legal synthesis
retain enough reasoning capacity to make reliable decisions.

## Provider and configuration

The bot calls Fireworks directly through its OpenAI-compatible chat-completions endpoint. It does
not use Groq or fall back to OpenRouter.

The bot configuration uses:

```text
FIREWORKS_API_KEY=
FIREWORKS_MODEL=accounts/fireworks/models/deepseek-v4-flash
BRAVE_SEARCH_API_KEY=
```

`FIREWORKS_API_KEY` and `BRAVE_SEARCH_API_KEY` are required. `FIREWORKS_MODEL` defaults to the
DeepSeek V4 Flash model above. Groq settings are removed from current code, examples, tests, and
operator documentation.

## Workflow

The existing application-controlled planner, Brave research, and synthesis sequence is retained:

1. DeepSeek plans the country, report category, reporter explanation, and whether terminology or
   country-specific legal research is required.
2. The application performs only the requested Brave searches. Independent terminology and legal
   searches run concurrently.
3. DeepSeek combines the validated plan and any Brave material into the final structured decision
   and report.
4. One targeted follow-up search remains available when the first synthesis says the supplied
   research is insufficient.
5. User-requested refinements reuse existing research and never start a new search.

The existing query sanitization, supported-country and category validation, legal-reference
requirements, one-follow-up limit, 512-character application validation, safe errors, usage
recording, and bot/API ownership boundary remain unchanged.

## Reasoning and speed

Reasoning is selected by task rather than enabled everywhere:

- Planning uses `reasoning_effort: "high"` because it makes substantive classification and
  research-routing decisions.
- Synthesis uses `high` when Brave supplied research material because the model must interpret
  sources and select an applicable legal reference.
- Synthesis uses `none` when no research was needed because the planner already settled the
  substantive choices.
- Refinement and repair use `none` because they rewrite an established decision.

DeepSeek V4 on Fireworks does not provide a genuinely lower reasoning tier: `low` and `medium` are
promoted to `high`. Using `none` on mechanical stages is therefore the useful speed optimization.

## Structured JSON and token budgets

Reasoning-enabled calls place the complete JSON schema in the prompt and request raw JSON. This
keeps DeepSeek reasoning available while the application performs strict parsing and semantic
validation. Calls with reasoning disabled use Fireworks' enforced JSON Schema response format for
more reliable and faster mechanical output.

Completion limits include both hidden reasoning and visible JSON. Planning receives 8,192
completion tokens. Research-backed synthesis receives 12,288 completion tokens. Non-reasoning
synthesis, refinement, and repair receive 4,096 completion tokens. A response ending because of
the token limit is rejected as incomplete instead of being parsed as a valid decision.

The provider client records Fireworks prompt and completion usage. It also records reasoning usage
when Fireworks supplies a distinct reasoning token count; otherwise the completion total remains
the authoritative billed output count and the separate reasoning count is zero.

## Prompt behavior

Planner and writer prompts explicitly require raw JSON matching the supplied schema. The writing
instructions say to produce a naturally concise report that comfortably fits Discord's
512-character field, but not to count characters step by step or spend reasoning optimizing the
exact character count. The application remains responsible for enforcing the actual limit.

If an otherwise useful report exceeds the limit or the mechanical writer returns malformed JSON,
the existing single repair path receives the validation problem and rewrites the result with
reasoning disabled. There is no unbounded model retry loop.

## Provider failures and retries

The Fireworks client keeps one bounded retry for network failures, HTTP 429, and HTTP 5xx while the
workflow deadline still has time remaining. It does not retry refusals, malformed provider
payloads, semantic validation failures, or token-limit completions. Logs remain structured and do
not include prompts, completions, research text, report context, or provider error bodies.

## Testing

Tests will verify:

- Fireworks endpoint, authorization, default model, and removal of Groq configuration.
- High reasoning and prompt-embedded schemas for planning and research-backed synthesis.
- No reasoning and enforced schemas for no-research synthesis, refinement, and repair.
- The completion budgets for each stage and rejection of `finish_reason: "length"`.
- Fireworks response parsing, usage accounting, safe retry behavior, and safe errors.
- Existing conditional Brave searches, one follow-up search, strict semantic validation, and
  report/refinement behavior.
- Prompts discourage exact character counting while application validation still enforces 512
  characters.

After TypeScript changes, the full repository lint, typecheck, tests, build, and high-severity
dependency audit must pass.
