# DeepSeek Throughput and ZDR Routing Design

## Goal

Use DeepSeek V4 Flash by default and route every AI request to the fastest compatible Zero Data Retention endpoint available at request time.

## Behavior

- Change the default OpenRouter model from `minimax/minimax-m2.7` to
  `deepseek/deepseek-v4-flash`.
- Keep `OPENROUTER_MODEL` as an operator override.
- Apply these provider preferences to research, report writing, refinement, and repair:
  - `zdr: true` so only Zero Data Retention endpoints are eligible.
  - `data_collection: "deny"` as an additional no-collection restriction.
  - `require_parameters: true` so providers cannot silently ignore reasoning, structured-output,
    tool, or token-limit parameters.
  - `sort: "throughput"` so OpenRouter tries eligible providers in current throughput order.
- Remove the fixed MiniMax-specific provider order. It becomes inaccurate as endpoint availability
  and performance change.
- Retain provider fallback behavior so another eligible ZDR endpoint can serve a request when the
  fastest endpoint fails.
- Keep `max_completion_tokens: 4096` on report-producing calls.

## Data flow

The bot sends the configured model and provider constraints to OpenRouter. OpenRouter first removes
endpoints that are not ZDR, collect data, or lack required parameter support. It then orders the
remaining endpoints by its current throughput measurements and tries them with fallbacks enabled.

## Failure behavior

If no endpoint satisfies all privacy and parameter requirements, the request fails through the
existing safe OpenRouter error handling. The bot must not relax ZDR, data-collection, or parameter
requirements to obtain a completion.

## Files and tests

- Update the default in `apps/bot/src/config.ts` and `apps/bot/.env.example`.
- Update provider preferences in `apps/bot/src/report-writer.ts`.
- Update configuration and report-writer tests before production code, verifying the new default,
  ZDR on every AI stage, throughput sorting, and removal of the fixed provider order.
- Update `docs/BOT_API.md` and `docs/BOT_IMPLEMENTATION.md` to describe the model and routing policy.
- Run the repository's required lint, workspace typecheck, tests, build, and high-severity audit.

## Non-goals

- No model fallback to MiniMax or another model.
- No hard-coded minimum TPS threshold or price ceiling.
- No changes to prompts, report length, reasoning settings, API boundaries, or report lifecycle.
