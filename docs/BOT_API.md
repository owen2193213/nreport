# NReport Discord DSA API

Status: canonical public and bot-facing contract
Service: `discord.dsa`
Version: v1

The API owns preparation, legal research, generated identity, email verification, Discord
submission, decisions, appeals, credits, and durable lifecycle history. Any authorized bot or
service can use it. A client submits evidence and preferences once and receives `202 Accepted`
with a report ID; no AI or Discord network call occurs in that HTTP request.

The Discord bot is only one client. It stores the relationship between a Discord user and an API
account locally. The API never accepts or stores the submitting Discord user's ID.

## Authentication

Account endpoints use a personal key:

```http
Authorization: Bearer dsa_live_<key-id>_<secret>
```

Keys are shown once, stored server-side only as a lookup prefix and peppered HMAC-SHA256 hash, and
may briefly overlap during rotation. A suspended account retains read-only access but receives
`403` for create and retry operations.

Administrator endpoints use the independent `NREPORT_ADMIN_KEY`. An ordinary key cannot call them.
Never put either credential in URLs, Discord command options, logs, or client-side code.

All JSON failures use:

```json
{
  "error": {
    "code": "stable_machine_code",
    "message": "Safe human-readable message",
    "requestId": "request-correlation-id"
  }
}
```

Expected statuses are `401` for authentication, `402` for exhausted credits, `403` for a
suspended-account write, deliberately indistinguishable `404` responses for missing or foreign
reports, `409` for state/idempotency conflicts, and `429` with `Retry-After` for throttling.

## Discovery and account

- `GET /openapi.json` is unauthenticated and publishes OpenAPI 3.1 from the exported route schemas.
- `GET /healthz` is unauthenticated.
- `GET /v1/discord/dsa/account` returns the authenticated account ID, immutable username, status, available
  and reserved credits, current key prefix, and cumulative AI request/token/search totals.
- `GET /v1/discord/dsa/catalog` returns `{ service: { category: "discord", type: "dsa", version: "v1" } }`
  with supported countries, semantic categories, and flow-specific elements.

Default account limits are five report mutations per minute, twenty AI preparations per hour, and
120 reads per minute. Limits are enforced at the API and are not reset by running more bot workers.

## Creating a report

```http
POST /v1/discord/dsa/reports
Authorization: Bearer <personal-api-key>
Content-Type: application/json
Idempotency-Key: create:<stable-client-operation-id>
```

`flow` is `message`, `profile`, or `server`. It maps internally to Discord's transport flow names.
The target is flow-specific:

```json
{
  "flow": "message",
  "useAi": true,
  "target": {
    "messageUrl": "https://discord.com/channels/123456789012345/234567890123456/345678901234567",
    "messageEvidence": { "source": "message_link", "status": "unavailable", "attemptedAt": "2026-09-04T12:00:00.000Z" }
  },
  "description": "Optional reporter hint"
}
```

```json
{
  "flow": "profile",
  "useAi": false,
  "country": "DE",
  "category": "sub_other_hate_speech",
  "description": "Optional supporting description",
  "finalText": "The profile name targets a protected group with a degrading slur.",
  "target": {
    "reportedUsername": "example",
    "reportedUserId": "123456789012345678",
    "reportedUserSnapshot": {
      "userId": "123456789012345678",
      "username": "example",
      "globalDisplayName": null,
      "avatarUrl": null,
      "bot": false,
      "resolvedAt": "2026-09-04T12:00:00.000Z"
    },
    "profileElements": ["name"]
  }
}
```

Server targets contain `guildIdOrInviteCode` and one or more `guildElements` from the catalog.
Message evidence must agree with the message URL. Snowflakes, URLs, Unicode text, element values,
and total evidence size are validated. Images and avatar, attachment, banner, and embed URLs are
stored only where needed as original evidence and are stripped from public report responses and
from all AI and Brave inputs.

When `useAi` is `true`, `finalText` is forbidden. Country, category, and description are immutable
hints; the preparation worker fills only omitted values. When `useAi` is `false`, country,
category, and a 1–512-character `finalText` are required, description defaults to `finalText`, and
the API does not instantiate or call an AI or search provider.

Caller-selected identities, models, providers, prompts, metadata, callback URLs, and submitting
Discord user IDs are rejected.

The idempotency key is scoped to the authenticated account. Replaying the same normalized request
returns the same report with `202`; changing the body while reusing the key returns `409`.

## Report lifecycle and response

Visible transport states are:

```text
queued -> planning -> researching -> writing
       -> requesting_verification -> awaiting_verification
       -> verification_received -> verifying -> submitting -> submitted
```

Manual and `reuse` preparation skip AI-only states. Any pre-submission stage may end in `failed`.
`discordStatus` and `reviewStatus` separately describe later Discord decisions and the automatic
appeal lifecycle.

`GET /v1/discord/dsa/reports/:reportId` returns the account ID, report ID, timestamps, flow, AI mode, status,
credit state, sanitized target/evidence, prepared country/category/description/final text, legal
reference, compact research summary, source annotations, Discord report/decision/appeal state,
safe failure details, retry modes, predecessor/successor IDs, and the durable timeline. Generated
identity, email alias, proxy/session details, provider payloads, prompts, and model conversation are
never returned. For AI reports, `finalText` is the AI-written text that was submitted to Discord;
clients do not need to reconstruct it from evidence or provider output.

`GET /v1/discord/dsa/reports?after=&limit=` returns account-owned summaries with an opaque cursor. A foreign
report ID produces the same `404` as a nonexistent one.

## Credits and retries

Creation reserves one account credit transactionally with the report, retry chain, preparation
job, and initial event. Just before the non-idempotent Discord submission call, the API atomically
marks the report `submitting`, consumes that entitlement, and emits the boundary event.

- Failures before the boundary release the reservation.
- Failures, crashes, or ambiguous outcomes after the boundary keep it consumed.
- An idempotent replay never reserves or consumes twice.
- Suspending an account fails eligible pre-boundary reports and releases their reservations.

```http
POST /v1/discord/dsa/reports/<report-id>/retries
Authorization: Bearer <personal-api-key>
Content-Type: application/json
Idempotency-Key: retry:<stable-client-operation-id>

{ "mode": "reuse" }
```

Only a terminal report may use a mode listed in `retryableModes`. `reuse` copies the immutable
prepared payload but creates a new identity and session; it is unavailable if preparation never
completed. `regenerate` reruns preparation from original evidence and supplied hints and is
unavailable for manual reports. Each report has at most one successor, retries are serial, and a
30-second cooldown applies. A consumed chain reuses its entitlement; a released chain must reserve
one currently available credit. Actioned and ambiguous-final-submission reports are not retryable.

After an appeal denial, the API may instead expose `rewrite_ai` and `edit_manual`. `rewrite_ai`
creates a new AI preparation from the same immutable target/evidence and directs the writer to
address likely weaknesses through clearer, more specific, better-categorized legal reasoning. It
must not invent evidence or assert a Discord denial rationale that Discord did not provide.
`edit_manual` requires `country`, `category`, `finalText`, and the applicable profile/server element
selection; it changes those prepared fields but not the captured target/evidence. Neither mode is a
resend-as-is operation.

An ineligible appeal, ambiguous final submission, or report/appeal confirmation timeout exposes no
retry mode. The confirmation deadline is two minutes. Clients must not automatically resubmit after
that deadline because the target message may have been deleted or become inaccessible. The API
reports original-report and appeal outcomes separately through `discordStatus`, `reviewStatus`, and
timeline events; clients must not collapse report denied with appeal denied, or report accepted with
appeal accepted.

## Events, webhooks, and recovery

`GET /v1/discord/dsa/events?after=&limit=` is the authoritative, replayable, account-scoped event feed. Events
contain only `eventId`, `accountId`, `reportId`, `type`, `occurredAt`, and `lifecycleAttempt`—never
evidence or report text. Clients should persist the cursor only after all items are linked and
processed, then recover state through report reads. This provides durable recovery; clients still
need idempotent local processing rather than assuming zero delivery loss.

Administrators may assign one destination to many accounts. Each event/destination delivery is
unique, signed over the timestamp, event ID, and exact body, and retried with capped exponential
backoff for seven days. The first `409` from the bot's narrow report-linking race is retried after a
short 500–1000 ms delay. With no destination, events remain available from the feed. Public
destinations require HTTPS; Railway private HTTP requires the explicit API configuration flag.

Webhook receivers must reject stale timestamps and replayed event IDs, verify the HMAC before JSON
parsing, and process the exact received bytes. A bot that cannot find the pre-created local mapping
returns `409`; other successful duplicates return `2xx`.

## Analytics

- `GET /v1/discord/dsa/analytics`
- `GET /v1/discord/dsa/action-history`
- `GET /v1/discord/dsa/digest-activity`
- `GET /v1/discord/dsa/analytics/community`

Personal scope always comes from the authenticated account. Community analytics remain anonymized
and retain insufficient-data protection.

## Administrator API

The `/v1/admin/discord/dsa` surface creates/lists/inspects accounts; suspends or reinstates them; issues,
rotates, lists, and revokes keys; adjusts credits with a signed integer delta and mandatory reason;
creates, updates, disables, and assigns webhook destinations; and exposes global usage plus legacy
operational diagnostics. Account usernames are immutable and case-insensitively unique. Plaintext
personal keys are returned only on issue or rotation.

## Client behavior

Use `DsaApi` from `@nreport/contracts` with a personal key and `DsaAdminApi` only for trusted
administration. Preserve idempotency keys across timeouts. Do not automatically retry the final
Discord submission, infer ownership from caller-provided data, or rely on webhooks as the only
recovery mechanism.
