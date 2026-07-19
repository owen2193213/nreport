# Discord DSA API Capture Handoff

Last updated: 2026-07-19

> **Historical protocol record.** This file preserves the browser-captured Discord
> workflow and breadcrumb research. Discord bot implementations must use the hosted API
> contract in [`docs/BOT_API.md`](docs/BOT_API.md), not the endpoints, tokens, or numeric
> breadcrumbs documented here.

## Objective

Map Discord's EU DSA report workflow so an authorized nonprofit bot can submit changeable user-profile, message, and server reports. The supplied IDs and links are dummy/whitelisted data.

## Dummy profile-report data

- Reported user ID: `1057381507204915281`
- Reporter legal name: `Jason McDonell`
- Reporter email: `projectnebulon@gmail.com`
- Country: Germany (`DE`)
- Profile elements: `name` and `descriptors`
- Category path: `Other` -> `Cybercrime`
- Context used: fraudulent impersonation/calling scam content intended to obtain money or account access
- Attestation: `validation`

## Confirmed authentication flow

### 1. Send email code

```http
POST https://discord.com/api/v9/reporting/unauthenticated/user_urf/code?b=js30bq
Content-Type: application/json
```

```json
{
  "name": "user_urf",
  "email": "projectnebulon@gmail.com"
}
```

The `b` query value is a deterministic, unsigned 32-bit DJB2-style hash of the
exact email string, encoded in base 36. Discord's web client currently computes
it as follows:

```js
function emailToCodeQueryB(email) {
  let hash = 5381;
  for (let index = 0; index < email.length; index += 1) {
    hash = ((hash << 5) + hash + email.charCodeAt(index)) | 0;
  }
  return (hash >>> 0).toString(36);
}
```

Known test vector: `emailToCodeQueryB("projectnebulon@gmail.com")` returns
`"js30bq"`. The hash function itself does not lowercase or trim its input, so
case and whitespace change the result. Treat `b` as email-derived request data,
not as a global constant, random session value, verification code, token, or
fingerprint. Its server-side purpose is not confirmed.

### 2. Verify email code

```http
POST https://discord.com/api/v9/reporting/unauthenticated/user_urf/verify
Content-Type: application/json
```

```json
{
  "name": "user_urf",
  "email": "projectnebulon@gmail.com",
  "code": "<ONE_TIME_CODE>"
}
```

Successful response shape:

```json
{
  "token": "<EPHEMERAL_USER_URF_TOKEN>"
}
```

The real one-time code and token are intentionally not stored here. The observed token encodes the email and `menu_type: user_urf`; assume it expires and is specific to this flow.

## Confirmed menu/configuration request

```http
GET https://discord.com/api/v9/reporting/unauthenticated/menu/user_urf
```

Important response metadata:

- `name`: `user_urf`
- `variant`: `1`
- `version`: `1.0`
- `postback_url`: `/api/reporting/user_urf`
- `root_node_id`: `63`
- `success_node_id`: `70`
- `fail_node_id`: `74`

The menu response must be fetched at runtime rather than assuming node IDs are permanent.

## Relevant profile-report menu mapping

| Step | Node | Key | Submitted value |
|---|---:|---|---|
| Reporter/profile details | 63 | `URF_USER_WELCOME` | `reporter_legal_name`, `reporter_country`, `reported_username`; optional reporter/server fields |
| Profile elements | 23 | `URF_USER_PROFILE_SELECT_ELEMENTS` | `user_profile_select` values: `photos`, `name`, `descriptors` |
| Main category | 20 | `URF_USER_PROFILE_SELECT_REPORT_TYPE` | `Other` targets node 186 |
| Other subcategory | 186 | `URF_USER_OTHER` | `Cybercrime` targets node 183 |
| Cybercrime details | 183 | `URF_USER_CYBERCRIME` | optional `dsa_free_text`; `report_type` is `sub_other_cybercrime` |
| Attestation | 78 | `URF_CONFIRMATION_SELECT` | `confirmation_select`: `validation` |
| Summary/submit | 77 | `URF_SUBMIT` | submit action |

Germany's dropdown value is `DE`. The schema marks these profile fields with `should_submit_data: true`:

- `reporter_legal_name`
- `reporter_country`
- `reported_username`
- `user_profile_select`
- `confirmation_select`

The optional `dsa_free_text` field is marked `should_submit_data: false` in the menu response, so the final observed payload is needed to determine whether the client nevertheless includes it.

## Browser/session observations

- The captured browser requests included `credentials: include`; preserve cookies across the initial page/menu/code/verify/submission sequence.
- `x-fingerprint`, `x-installation-id`, and `x-super-properties` are session/client values and must not be hardcoded.
- Browser-generated `sec-*` headers are not assumed to be required.
- `x-discord-locale`, `x-discord-timezone`, and the current `b` query value should be tested rather than assumed mandatory.
- The capture used an EU VPN endpoint. Production will use an EU proxy.

## Confirmed profile final submission

```http
POST https://discord.com/api/v9/reporting/unauthenticated/user_urf
Content-Type: application/json
```

Captured successful payload shape:

```json
{
  "version": "1.0",
  "variant": "1",
  "language": "en",
  "breadcrumbs": [63, 23, 20, 173, 78, 77],
  "elements": {
    "reporter_country": "DE",
    "reporter_legal_name": "Jason McDonell",
    "reporter_username": "ampro232",
    "reported_username": "username51",
    "reported_user_server_id": "1273300509318578227",
    "user_profile_select": ["name", "descriptors"],
    "dsa_free_text": "<REPORT_CONTEXT>",
    "confirmation_select": ["validation"]
  },
  "email_token": "<EPHEMERAL_USER_URF_TOKEN>",
  "name": "user_urf"
}
```

Successful response shape:

```json
{
  "report_id": "1527685899742220478"
}
```

The captured category was `Celebrating or glorifying acts of violence`, which maps to node `173` and report type `sub_glorifying_violence`. Its ordered path is:

```text
63 -> 23 -> 20 -> 173 -> 78 -> 77
```

Important conclusions:

- The verification token is sent in the JSON body as `email_token`, not as an authorization header.
- Submission uses `/api/v9/reporting/unauthenticated/user_urf`, whereas the menu's `postback_url` is the more general `/api/reporting/user_urf` path.
- `breadcrumbs` contains every traversed node, including the root, category, attestation, and submit nodes.
- The client includes populated optional fields such as `reporter_username`, `reported_user_server_id`, and `dsa_free_text` even when the schema marks them `should_submit_data: false`.
- The menu `version`, `variant`, and `name` are echoed into the final payload.
- A successful submission returns a Discord report snowflake in `report_id`.
- The live verification token is intentionally omitted from this file.

## Later flows to capture

### Message report

- Message URL: `https://discord.com/channels/1273300509318578227/1526327580456779797/1527300404998832138`
- Reason: spreading malware

Confirmed email-code request:

```http
POST https://discord.com/api/v9/reporting/unauthenticated/message_urf/code?b=js30bq
Content-Type: application/json
```

```json
{
  "name": "message_urf",
  "email": "projectnebulon@gmail.com"
}
```

This confirms that the authentication route is menu-specific. The observed
`js30bq` value is the base-36 email hash documented above and must be recomputed
from the exact reporter email.

Confirmed verification request:

```http
POST https://discord.com/api/v9/reporting/unauthenticated/message_urf/verify
Content-Type: application/json
```

```json
{
  "name": "message_urf",
  "email": "projectnebulon@gmail.com",
  "code": "<ONE_TIME_CODE>"
}
```

The response again contains an ephemeral token. Treat it as specific to `message_urf` and submit it later as `email_token`, subject to confirmation by the final captured payload.

Confirmed menu request:

```http
GET https://discord.com/api/v9/reporting/unauthenticated/menu/message_urf
```

Menu metadata:

- `name`: `message_urf`
- `variant`: `1`
- `version`: `1.0`
- `postback_url`: `/api/reporting/message_urf`
- `root_node_id`: `64`
- `success_node_id`: `70`
- `fail_node_id`: `74`

The root node `64` collects `reporter_legal_name`, `reporter_country`, optional `reporter_username`, and required `reported_message_url`. The URL must match a Discord message link containing guild/DM, channel, and message IDs.

All direct message paths begin `64 -> 60`, then use the selected category node, and end `78 -> 77`:

| Report option | Breadcrumbs | Report type |
|---|---|---|
| Sexualizing a minor | `[64,60,134,78,77]` | `sub_general_scrm_icwm` |
| Sexual contact with a minor | `[64,60,135,78,77]` | `sub_icwm` |
| Minor posting sexual content | `[64,60,136,78,77]` | `sub_icaam` |
| Child sexual abuse material | `[64,60,137,78,77]` | `sub_csam` |
| Threat of physical harm | `[64,60,138,78,77]` | `threatening_behavior` |
| Glorifying violence | `[64,60,139,78,77]` | `sub_glorifying_violence` |
| Hate based on identity/vulnerability | `[64,60,140,78,77]` | `sub_racist_or_discriminatory_language_or_imagery` |
| Underage user | `[64,60,141,78,77]` | `sub_coppa` |
| Encouraging self-harm | `[64,60,142,78,77]` | `sub_self_harm_encouragement` |
| Stolen accounts or credit cards | `[64,60,143,78,77]` | `sub_cracked_accounts` |
| Drugs or illegal goods | `[64,60,144,78,77]` | `sub_illicit_goods` |
| Non-consensual intimate content | `[64,60,145,78,77]` | `sub_ncp` |
| Unwanted adult sexual images | `[64,60,146,78,77]` | `sub_unsolicited_porn` |

The `Other` branch adds node `147`:

| Other option | Breadcrumbs | Report type |
|---|---|---|
| Child Safety | `[64,60,147,148,78,77]` | `sub_other_child_safety` |
| Threats or Harassment | `[64,60,147,149,78,77]` | `sub_other_threats` |
| Cybercrime | `[64,60,147,150,78,77]` | `sub_other_cybercrime` |
| Hate Speech | `[64,60,147,151,78,77]` | `sub_other_hate_speech` |
| Unwanted Sexual Content | `[64,60,147,152,78,77]` | `sub_other_unwanted_sexual_content` |

Confirmed final message submission:

```http
POST https://discord.com/api/v9/reporting/unauthenticated/message_urf
Content-Type: application/json
```

```json
{
  "version": "1.0",
  "variant": "1",
  "language": "en",
  "breadcrumbs": [64, 60, 147, 150, 78, 77],
  "elements": {
    "reporter_country": "DE",
    "reported_message_url": "https://discord.com/channels/1273300509318578227/1526327580456779797/1527300404998832138",
    "reporter_username": "user3212",
    "reporter_legal_name": "Jason McDonell",
    "dsa_free_text": "This person is spreading malware and sending a keylogger.",
    "confirmation_select": ["validation"]
  },
  "email_token": "<EPHEMERAL_MESSAGE_URF_TOKEN>",
  "name": "message_urf"
}
```

Successful response:

```json
{
  "report_id": "1527692773673668798"
}
```

This validates the `Other -> Cybercrime` path `[64,60,147,150,78,77]`, confirms that the message link is sent intact as `reported_message_url`, and confirms that the verified token is passed as the body field `email_token` just like the profile flow.

## Category and menu quirks

- In all three current menus, every terminal category presents the same optional `dsa_free_text` field and then routes through attestation node `78` to submit node `77`.
- No captured category introduces an additional category-specific input field. Some sensitive categories display extra safety information, but their submitted shape is otherwise the same.
- The `report_type` string exists on the selected menu node but is **not** included directly in any captured final payload. Discord appears to derive it from the ordered `breadcrumbs` path.
- Direct and `Other` category labels/report types mostly match between profile and message menus, but their node IDs differ. Never reuse profile breadcrumbs for a message report.
- Node `17` (`GENERIC_SUBMIT`) is present in both schemas but is not on either observed URF path. The active flows use node `77` (`URF_SUBMIT`).
- Success node `70` and failure node `74` describe client result screens; they are not included in submitted breadcrumbs.
- Profile node `23` supports multiple selected profile elements and requires at least one selection. Values are `photos`, `name`, and `descriptors`.
- Populated optional inputs are included even when their schema says `should_submit_data: false`. This was confirmed for `reporter_username`, `reported_user_server_id`, and `dsa_free_text`.
- Unpopulated optional-field behavior has not been exhaustively tested. Prefer omitting empty optional keys rather than sending invented values.
- The menu's declared `postback_url` omits the observed `/v9/reporting/unauthenticated` prefix. Use the endpoint captured from the actual client, not the declared path alone.
- Verification tokens are menu-specific: never reuse a token across `user_urf`, `message_urf`, and `guild_urf`.

## Reproducibility status

### Confirmed and reproducible

- Profile, message, and guild email-code endpoints and request bodies
- Profile, message, and guild verification endpoints and token response shape
- Runtime menu endpoints and complete version `1.0`, variant `1` schemas
- Every current profile, message, and guild category breadcrumb path
- Successful profile, message, and guild final submission endpoints, JSON payload shapes, token placement, and report-ID response shape
- Germany country value (`DE`), profile-element values, message-link field, guild target/element fields, free-text field, and attestation value

### Must remain dynamic

- Email address, one-time verification code, and short-lived `email_token`
- Reporter identity, country, usernames, server ID, message URL, selected elements, category, and report context
- Menu `version`, `variant`, root/child node IDs, terminal node IDs, and breadcrumb paths
- Cookies and Discord client/session metadata
- EU proxy endpoint and its health
- `b` query parameter, deterministically recomputed from the exact email string

### Not yet confirmed

- Minimum required request headers and cookies outside Chrome
- Server-side purpose of the email-derived `b` query value
- Verification-code/token expiry times, resend behavior, reuse behavior, and invalid-code responses
- Error behavior for expired tokens, malformed links, invalid menu paths, non-EU IPs, and unavailable content
- Rate limits and `429` retry headers
- Whether Discord requires a browser-derived fingerprint or installation ID for non-browser clients
- Clean-session repeatability through the intended production proxy

### Readiness assessment

All three flows were sufficiently mapped to implement the typed client, and the hosted
backend has since completed a controlled production lifecycle through report confirmation.
The service now includes runtime menu resolution, sticky proxy validation, secret handling,
bounded retries, rate limits, durable jobs, and idempotent duplicate protection. This
capture remains useful for protocol archaeology, but readiness and bot behavior are defined
by [`docs/BOT_API.md`](docs/BOT_API.md) and the current source code.

### Server report

- Server ID: `1273300509318578227`
- Reason: spreading malware and cheats

Confirmed flow/menu name: `guild_urf`.

Email-code request:

```http
POST https://discord.com/api/v9/reporting/unauthenticated/guild_urf/code?b=js30bq
Content-Type: application/json
```

```json
{
  "name": "guild_urf",
  "email": "projectnebulon@gmail.com"
}
```

Verification request:

```http
POST https://discord.com/api/v9/reporting/unauthenticated/guild_urf/verify
Content-Type: application/json
```

```json
{
  "name": "guild_urf",
  "email": "projectnebulon@gmail.com",
  "code": "<ONE_TIME_CODE>"
}
```

The successful verification response again returns a menu-specific token. Its decoded payload contains:

```json
{
  "email": "projectnebulon@gmail.com",
  "menu_type": "guild_urf"
}
```

The token has three dot-separated URL-safe Base64 segments resembling a timed signed serializer:

```text
<base64url-json-payload>.<base64url-timestamp>.<base64url-signature>
```

Only the first segment is readable JSON. The second segment encodes timestamp bytes and the third is a binary cryptographic signature, so nonsensical text after naive Base64 decoding is expected. The complete token must be treated as opaque and must not be altered or recreated client-side.

Confirmed menu request:

```http
GET https://discord.com/api/v9/reporting/unauthenticated/menu/guild_urf
```

Menu metadata:

- `name`: `guild_urf`
- `variant`: `1`
- `version`: `1.0`
- `postback_url`: `/api/reporting/guild_urf`
- `root_node_id`: `67`
- `success_node_id`: `70`
- `fail_node_id`: `74`

Root node `67` collects:

- `reporter_legal_name` (required)
- `reporter_country` (required)
- `reporter_username` (optional)
- `reported_guild_id_or_invite_code` (required; accepts a server ID or invite code)

Node `66` requires one or more `guild_select` values describing where the illegal content appears:

| Value | UI label |
|---|---|
| `name` | Server Name |
| `icon` | Icon |
| `banner` | Banner |
| `invite_splash` | Invite Splash |
| `discovery_splash` | Discovery Splash |
| `welcome_screen_description` | Welcome Screen Description |
| `channel_names` | Channel Names |
| `other` | Other |

All server category paths begin `67 -> 66 -> 65` and end `78 -> 77`:

| Report option | Breadcrumbs | Report type |
|---|---|---|
| Child safety | `[67,66,65,153,78,77]` | `sub_other_child_safety` |
| Threats or harassment | `[67,66,65,154,78,77]` | `sub_other_threats` |
| Cybercrime | `[67,66,65,155,78,77]` | `sub_other_cybercrime` |
| Hate speech | `[67,66,65,156,78,77]` | `sub_other_hate_speech` |
| Sharing unwanted sexual content | `[67,66,65,157,78,77]` | `sub_other_unwanted_sexual_content` |

The guild menu is simpler than the profile/message menus: it exposes only these five top-level categories and has no separate `Other` branch. For spreading malware or cheats, the current category is `Cybercrime`, with breadcrumbs `[67,66,65,155,78,77]`.

Confirmed final guild submission:

```http
POST https://discord.com/api/v9/reporting/unauthenticated/guild_urf
Content-Type: application/json
```

```json
{
  "version": "1.0",
  "variant": "1",
  "language": "en",
  "breadcrumbs": [67, 66, 65, 155, 78, 77],
  "elements": {
    "reporter_country": "DE",
    "reporter_legal_name": "Jason McDonell",
    "reporter_username": "",
    "reported_guild_id_or_invite_code": "1273300509318578227",
    "guild_select": ["other", "welcome_screen_description", "channel_names"],
    "dsa_free_text": "The server spreads malware in the form of cheat exploits in .exe files -- they are python key-loggers.",
    "confirmation_select": ["validation"]
  },
  "email_token": "<EPHEMERAL_GUILD_URF_TOKEN>",
  "name": "guild_urf"
}
```

Successful response:

```json
{
  "report_id": "1527695430949798110"
}
```

This validates the `Cybercrime` path `[67,66,65,155,78,77]`, confirms that multiple `guild_select` values are submitted as an array, confirms that the target is sent in `reported_guild_id_or_invite_code`, and confirms `email_token` placement for the guild flow.

## Capture hygiene

- Keep DevTools Network **Preserve log** enabled.
- Filter with `reporting` and use Fetch/XHR.
- Ignore unrelated requests such as `capabilities`, `science`, `experiments`, `promotions`, and `linked-users`.
- Do not store live verification codes or tokens in source control.
- Do not retry a final submission if Discord returns success; avoid duplicate reports.
