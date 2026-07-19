# Reusable Discord DSA Client Design

## Understanding summary

- Build one reusable client for `user_urf`, `message_urf`, and `guild_urf`.
- Use an EU proxy with one sticky proxy identity for an entire report lifecycle.
- Keep email-code verification human-mediated and verification tokens ephemeral.
- Fetch Discord's current menu and resolve breadcrumbs from the live graph.
- Require an explicit final submission call and prevent automatic ambiguous retries.
- Keep browser/session metadata configurable instead of hardcoding captured values.
- Target low-volume, authorized reporting with strict logging and duplicate controls in the calling bot.

## Assumptions

- Node.js and TypeScript are appropriate for integration with the Discord bot.
- The proxy will be supplied later as an HTTP(S) proxy URL with any sticky-session credentials embedded by the proxy provider.
- The caller owns persistence, user confirmation, rate limiting, and duplicate-report policy.
- This package owns HTTP transport, cookies, menu traversal, validation, and payload construction.

## Architecture

- `DiscordDsaClient`: code, verify, menu, prepare, and submit operations.
- Automatic fingerprint bootstrap from Discord's unauthenticated experiments endpoint through the same proxy session.
- `UndiciTransport`: optional proxy, cookie jar, header policy, and JSON requests.
- `MenuGraphResolver`: resolves semantic `report_type` values into current numeric paths.
- `PayloadBuilder`: creates and validates flow-specific element maps.
- Header ablation script: compares read-only menu responses with progressively smaller header sets.

## Safety and reliability

- Never log verification codes, cookies, proxy credentials, or `email_token`.
- Treat tokens as opaque and flow-specific.
- Do not automatically retry a final POST after an ambiguous network outcome.
- Use a new client instance per report lifecycle to preserve cookie/proxy continuity.
- Resolve numeric node IDs at runtime; do not use captured breadcrumbs as permanent configuration.

## Decision log

- Chose a separate typed library over browser automation for testability and maintainability.
- Chose semantic `report_type` identifiers over hardcoded node numbers.
- Chose `undici` plus `tough-cookie` for explicit proxy and cookie control.
- Chose read-only menu requests for header ablation to avoid sending verification emails or duplicate reports.
- Measured `x-fingerprint` as necessary for menu GET, implemented automatic acquisition,
  and confirmed `x-installation-id`/`x-super-properties` are unnecessary for menu GET.
  The minimal application header profile has completed a production report lifecycle.
  A formal one-header-group-at-a-time ablation of the final POST remains deliberately
  unperformed to avoid duplicate reports.
