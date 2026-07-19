# IPOasis Dynamic Residential Proxy Notes

Source reviewed: 2026-07-18

- [Dynamic Residential User Guide](https://docs.ipoasis.com/document/user-guide)
- [Generate Residential Proxy API](https://docs.ipoasis.com/api-document)

## Product behavior

- IPOasis Dynamic Residential supports both rotating and sticky sessions.
- Rotating mode selects a new exit IP for each proxy request.
- Sticky mode keeps the same exit IP for a configured duration.
- `sess` is a random numeric session identifier. Requests with the same value are routed through the same exit IP while the session remains available.
- `sessTime` accepts 1–120 minutes and defaults to 10 minutes.
- Because the residential pool is dynamic, an exit can disappear before the requested duration. Start a new report session rather than silently changing IP midway through verification.
- The European gateway is `gate-eu.ipoasis.com`.
- The residential endpoint port documented by the user guide is `8668`.

## Direct sticky URL format

Use a fresh random numeric session ID for each report lifecycle and reuse the resulting URL for menu, email-code, verification, and submission calls:

```text
http://user-{SUBUSER}-region-DE-sess-{RANDOM_NUMERIC_ID}-sessTime-120:{PASSWORD}@gate-eu.ipoasis.com:8668
```

Example with placeholders only:

```text
http://user-example_1234-region-DE-sess-426207-sessTime-120:REDACTED@gate-eu.ipoasis.com:8668
```

Do not store the real sub-user credential or password in this repository. Supply the complete URL at runtime through `DSA_PROXY_URL` or a secret manager.

## Public API distinction

IPOasis also documents:

```http
GET https://api.ipoasis.com/v1/proxy/dynamic/{subUserId}
X-API-Key: <API_KEY>
```

Its relevant parameters include `country=DE`, `sessionType=sticky`, `sessTime=1..120`, `protocol=http`, and `count=1`. This API requires a separate dashboard API key and numeric `subUserId`; proxy username/password credentials alone are not sufficient.

## Client policy

- Use one `DiscordDsaClient` instance per report lifecycle.
- Never use rotating mode for a verified report lifecycle.
- Never automatically retry a final Discord submission after an ambiguous network failure.
- If the sticky exit disappears before verification or submission, discard the verification state and restart with a new session ID.
- Never print the proxy URL because it contains credentials.
