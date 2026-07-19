# Header Test Results

## 2026-07-18: direct connection without EU proxy

The read-only header tester queried all three menu endpoints with these profiles:

- No explicit headers
- `accept` only
- Locale and timezone
- Browser transport headers without Discord session metadata

Every request returned HTTP `403`. The result is inconclusive for header necessity because the terminal connection did not use Chrome's Amsterdam VPN extension and no EU proxy was configured. The common failure across every profile is consistent with either geographic enforcement or a requirement shared by all omitted session fields.

## Next experiment

Repeat `npm.cmd run test:headers` with `DSA_PROXY_URL` set to the intended sticky EU proxy. First run without session metadata. If all minimal profiles still fail, supply current session values through temporary environment variables and use the generated one-field ablation profiles:

- `DSA_FINGERPRINT`
- `DSA_INSTALLATION_ID`
- `DSA_SUPER_PROPERTIES`

Do not place real values in `.env.example`, source control, command output, or application logs.

Menu GET success establishes only read-only endpoint requirements. POST endpoints must be tested through one controlled verification/report lifecycle, removing one header group at a time and avoiding duplicate final submissions.

## 2026-07-18: IPOasis German sticky proxy

The configured IPOasis credentials produced a German residential exit on Deutsche Telekom with the `Europe/Berlin` timezone. The exact exit IP is intentionally not recorded because the pool is dynamic.

### Observed results

- Requests without `x-fingerprint` returned HTTP `403`, including no-header, `Accept`-only, locale, and browser-transport profiles.
- A full captured-session profile returned valid `200` menus for message and guild; the user request timed out due to proxy instability.
- Removing `x-super-properties` returned valid `200` menus for all three flows.
- Removing `x-installation-id` returned valid `200` menus for message and guild. A later focused test showed both fingerprint-only and fingerprint-plus-installation profiles returned `200`, confirming installation ID was unnecessary for the tested menu GET.
- Removing `x-fingerprint` in the focused comparison returned HTTP `403`.
- `Accept: */*` plus `x-fingerprint` returned a valid menu.
- Testing `x-fingerprint` without explicit `Accept` timed out, so `Accept` is retained as a harmless baseline rather than claiming it is required.

### Current minimum for menu GET

```http
Accept: */*
X-Fingerprint: <fresh fingerprint from /api/v9/experiments>
```

These captured browser headers are unnecessary for the tested menu GETs:

- `accept-language`
- `priority`
- All `sec-ch-ua*` headers
- All `sec-fetch-*` headers
- `x-debug-options`
- `x-discord-locale`
- `x-discord-timezone`
- `x-installation-id`
- `x-super-properties`

### Automatic fingerprint bootstrap

The unauthenticated endpoint below returned a fresh fingerprint through the same IPOasis proxy:

```http
GET https://discord.com/api/v9/experiments?with_guild_experiments=true
```

The implemented client now acquires this fingerprint automatically and adds it to reporting calls. A live read-only smoke test successfully completed fingerprint bootstrap followed by fetching `message_urf` menu version `1.0`, variant `1`, root node `64`.

## 2026-07-18: code and verification POSTs

A controlled `message_urf` email-verification lifecycle completed through one German sticky proxy session. The client first bootstrapped a fresh fingerprint, sent one verification email, verified the supplied six-character code, and fetched the corresponding menu. It did not submit a report.

Both POST endpoints succeeded with the client's minimal application headers:

```http
Accept: */*
Content-Type: application/json
User-Agent: ProjectNebulon-DSA-Reporter/0.1
X-Fingerprint: <fresh fingerprint from /api/v9/experiments>
```

No captured browser metadata was supplied: no `x-installation-id`, `x-super-properties`, client hints, fetch metadata, debug options, locale, timezone, referrer, or browser cookies. The transport maintained a cookie jar, but Discord did not set a reporting cookie during the tested sequence.

The successful response sequence was:

1. `POST /reporting/unauthenticated/message_urf/code` - success
2. `POST /reporting/unauthenticated/message_urf/verify` - non-empty email token
3. `GET /reporting/unauthenticated/menu/message_urf` - menu version `1.0`, variant `1`, root node `64`

The verification code and returned email token are intentionally not recorded.

### Remaining limitation

This establishes the minimum observed headers for the fingerprint bootstrap, menu GET, `message_urf/code`, and `message_urf/verify` endpoints. The final report-submission POST has not undergone minimal-header testing. The other two verification flows use the same request shape but have not independently been retested with the minimal profile.

## 2026-07-19: complete production lifecycle

The backend subsequently completed a controlled `message_urf` lifecycle using the same
minimal application header policy: fingerprint bootstrap, menu fetch, code request, email
verification, final submission, Discord report ID persistence, and confirmation-email
processing all succeeded.

An earlier final submission returned HTTP 400 because the country-specific locale had
been used as the form payload `language`. Runtime menu configuration accepts the fixed
value `en`; the backend now keeps country-specific locale, timezone, `Accept-Language`,
pseudonym, and proxy selection while always submitting `language: "en"`.

This is end-to-end evidence that the implemented header policy works. It is not a claim
that every retained final-POST header was independently proven necessary: destructive
one-field ablation of final submissions remains intentionally out of scope.
