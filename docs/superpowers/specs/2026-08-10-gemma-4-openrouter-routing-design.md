# Gemma 4 OpenRouter Routing Design

## Goal

Make `google/gemma-4-31b-it` the bot's default OpenRouter model while preserving `OPENROUTER_MODEL` as an operator override. Remove the MiniMax-specific provider ordering so OpenRouter can choose any compatible provider.

## Scope

- Update the configured default and operator-facing configuration examples and documentation.
- Keep the existing OpenRouter privacy and compatibility constraints: `zdr` for report-writing requests, `data_collection: "deny"`, and `require_parameters: true`.
- Omit `provider.order` from both research and report-writing requests.
- Update focused configuration and request-payload tests.

## Non-goals

- No change to report prompts, JSON schemas, web research behavior, timeouts, or retry behavior.
- No provider is pinned or preferred by application code.
- No API, lifecycle, or bot-visible behavior changes beyond the default model and provider-neutral routing.

## Verification

Focused tests will demonstrate the new default, preserved environment override, and provider payloads without an order. The full repository validation suite will then run.
