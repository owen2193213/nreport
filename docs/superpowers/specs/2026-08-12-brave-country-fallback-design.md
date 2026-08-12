# Brave Search Country Fallback Design

## Goal

Prevent legal and terminology research from failing when a valid Discord DSA report country is not a supported Brave Search country target.

## Evidence

Brave's LLM Context API accepts only a fixed country-code allowlist. Its production response rejected Ireland (`IE`) with HTTP 422. The API's documented supported set includes `AT`, `BE`, `DK`, `FI`, `FR`, `DE`, `GR`, `IT`, `NL`, `PL`, `PT`, `ES`, and `SE` among the bot's EU report countries. The remaining bot-supported countries—`BG`, `HR`, `CY`, `CZ`, `HU`, `IE`, `LV`, `LT`, `LU`, `MT`, `RO`, `SK`, and `SI`—must use Brave's `ALL` target.

## Design

`brave-research.ts` will own a small immutable allowlist for Brave country targets and an exported `braveSearchCountry(country)` helper. It normalizes case, returns the recognized target unchanged, and returns `ALL` for any other country. This automatically protects both today's non-Brave EU countries and any valid report country added later.

Both the Web Search and LLM Context requests will use the helper. The application-owned report country and the planner's country-specific legal query remain unchanged; only Brave's result-targeting parameter falls back to `ALL`.

## Error Handling

The fallback is deterministic and makes no extra request. Existing provider, rate-limit, network, malformed-response, and empty-result behavior remains unchanged.

## Testing

Regression tests will assert the full known difference between the API's supported countries and Brave's allowlist maps to `ALL`, and that supported values remain intact. An integration-level report-writer test will verify that a legal request for `IE` sends `country: "ALL"`.
