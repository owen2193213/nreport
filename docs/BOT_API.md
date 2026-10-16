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
    "requestId": "request-correlation-id",
    "supportReference": "opaque-reference-present-on-500-only"
  }
}
```

Expected statuses are `401` for authentication, `402` for exhausted credits, `403` for a
suspended-account write, deliberately indistinguishable `404` responses for missing or foreign
reports, `409` for state/idempotency conflicts, and `429` with `Retry-After` for throttling.
An upstream AI-provider `402` is separate from exhausted NReport report credits: after the
asynchronous create was accepted, it produces a report failure with
`failure.code=preparation_payment_required` and a safe support message. The provider rejection is
not automatically retried; operators receive its bounded, redacted details in diagnostics.
Unexpected `500` responses intentionally contain no internal cause. They include a stable opaque
`supportReference` so an operator can correlate the failure with safe server diagnostics.

## Operational diagnostics

API and bot failures are captured in their separate Sentry projects with report and trace
correlation. Worker samples and aggregate health remain available through administrator
diagnostics. The separate Discord operations-warning webhook is retired; it is not required for
startup. The signed private API-to-bot lifecycle webhook remains the immediate delivery path for
report status cards. See [`SENTRY_SETUP.md`](SENTRY_SETUP.md).

Verification, report-receipt, and appeal-confirmation deadlines and worker-restart ambiguity
also create Sentry failure signals after the corresponding database transaction commits.
These signals include report/trace IDs and failure category; ordinary Discord decisions are
not application failures. Signal capture does not resubmit a report or change the deadline.

`GET /v1/admin/discord/dsa/keys?page=1` returns five keys per page with `items`, `page`,
`pageSize`, and `total`. Each item contains safe key metadata (ID, prefix, creation/last-use,
rotation expiry/revocation), API account ID, username, and account status. Page numbers must be
integers between 1 and 1,000,000; invalid input returns `400 invalid_key_page`. The API never
returns an existing key's secret or hash and does not know the submitting Discord user's ID.

Administrators may pass `reportId=<UUID>` to `GET /v1/admin/discord/dsa/diagnostics` for a bounded
report-health projection alongside the existing aggregates. An unknown ID returns `report: null`;
an invalid ID returns `400 invalid_report_id`. The view includes lifecycle state/timestamps,
external report ID, safe failure details, the latest 100 events and 50 jobs, inbound-mail counts
and up to 50 correlation groups, and delivery-state counts. Counts indicate when lists are
truncated. Inbound groups expose whether their external report ID matches the stored submission,
so unmatched confirmation mail is distinguishable from no recorded confirmation. It does not
return reporter aliases, report evidence/text, job payloads, mail contents, verification codes,
cookies, credentials, delivery destinations, or the detailed SQL diagnostic ledger.

## Discovery and account

- `GET /openapi.json` is unauthenticated and publishes OpenAPI 3.1 from the exported route schemas.
- `GET /healthz` is unauthenticated.
- `GET /v1/discord/dsa/account` returns the authenticated account ID, immutable username, status, available
  and reserved credits, current key prefix, and cumulative AI request/token/search totals.
- `GET /v1/discord/dsa/catalog` returns `{ service: { category: "discord", type: "dsa", version: "v1" } }`
  with supported countries, semantic categories, and flow-specific elements.

Default account limits are sixty report mutations per minute and 300 reads per minute. AI report
preparation has no separate per-account quota. Limits are enforced at the API and are not reset by
running more bot workers.

Report-list cursors are opaque and retain PostgreSQL timestamp precision. Event and
action-history cursors are decimal strings within PostgreSQL's nonnegative signed-bigint range;
clients must preserve them as strings without numeric conversion. Invalid cursors are rejected
before querying the database.

Lifecycle event IDs are allocated under a transaction-scoped publication lock after the parent
account/report locks are acquired. An event visible above a feed cursor cannot be followed by a
newly committed event below that cursor. IDs may have gaps after rollback and are not timestamps.
The migration preserves existing event IDs and starts a fresh uncached sequence above existing
IDs and the legacy sequence's reserved range. Existing cursors remain valid; historical events
are not renumbered or automatically replayed.

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
safe failure details, retry modes, predecessor/successor IDs, current durable `queueLength`, and the durable timeline. Generated
identity details other than the generated `reporterEmail` alias, proxy/session details, provider
payloads, prompts, and model conversation are never returned. `reporterEmail` is returned only on
the account-owned report detail (including create and retry responses), is `null` until identity
generation completes, and is never included in report lists or lifecycle events. For AI reports,
`finalText` is the AI-written text that was submitted to Discord;
clients do not need to reconstruct it from evidence or provider output.

Report creation and retry routes allow 60 mutations per authenticated account per minute. The same
60/minute ceiling is enforced at both the HTTP route and durable account-ledger layers.

`GET /v1/discord/dsa/reports?after=&limit=` returns account-owned summaries with an opaque cursor. A foreign
report ID produces the same `404` as a nonexistent one.

## Credits and retries

Creation reserves one account credit transactionally with the report, retry chain, preparation
job, and initial event. Just before the non-idempotent Discord submission call, the API atomically
marks the report `submitting`, consumes that entitlement, and emits the boundary event.

- Terminal failures before the boundary release the reservation.
- Failures, crashes, or ambiguous outcomes after the boundary keep it consumed.
- An idempotent replay never reserves or consumes twice.
- Suspending an account fails eligible pre-boundary reports and releases their reservations.

Transient connection failures before final submission use up to three attempts on the existing
sticky session, with capped backoff and jitter. The limit also applies after worker restarts;
recovering exhausted work does not start a fourth network attempt. Rate-limited requests honor `Retry-After` and do
not change sessions to bypass a limit. If the required wait exceeds five minutes, automatic
recovery stops without retrying early; a reserved entitlement is released rather than held
indefinitely. Invalid credentials, certificate validation, configuration,
validation, and permanent DNS failures stop rather than retrying indefinitely.

After safe connection attempts are exhausted, the API may create one automatic `reuse` successor
with a fresh report ID, trace, identity, and proxy session. Prepared content is reused without
another AI generation. The predecessor, successor, job, event, and credit-chain transfer commit
atomically; a reserved entitlement stays reserved, and a consumed entitlement is not consumed
again. Only final pre-boundary failure releases a reserved entitlement. Each manual operation
gets at most one automatic restart; its automatic successor inherits the used budget. A new
manual retry resets that budget. No final report/appeal submission, ambiguous outcome, or missing
confirmation is automatically resubmitted by this mechanism.

Report summary/detail responses may include `connectionRecovery` with `state` (`retrying` or
`restarting`), `attempt`, `maxAttempts`, nullable `retryAt`, and nullable `successorReportId`.
For a scheduled retry, `attempt` is the next connection attempt within that lifecycle job;
it is separate from the report's `lifecycleAttempt`.
`automaticNetworkRetry=true` identifies an API-created automatic successor. These optional
metadata fields contain no proxy credentials, cookies, verification codes, or transport state.
An automatically replaced predecessor is terminal as an individual report, with
`connectionRecovery.state=restarting` and its successor ID. Clients should follow that marked
successor to display current progress. The predecessor's marker is retained for delayed delivery
and adoption; it records the replacement, not whether the successor is still running.

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
unavailable for manual reports. Each report has at most one successor, retries are serial, and
there is no additional per-report retry cooldown. The normal account mutation-rate limit still
applies. A consumed chain reuses its entitlement; a released chain must reserve one currently
available credit. Actioned and ambiguous-final-submission reports are not retryable.

After an appeal denial, the API may instead expose `rewrite_ai` and `edit_manual`. `rewrite_ai`
creates a new AI preparation from the same immutable target/evidence and directs the writer to
address likely weaknesses through clearer, more specific, better-categorized legal reasoning. It
must not invent evidence or assert a Discord denial rationale that Discord did not provide.
`edit_manual` requires `country`, `category`, `finalText`, and the applicable profile/server element
selection; it changes those prepared fields but not the captured target/evidence. Neither mode is a
resend-as-is operation.

An ineligible appeal, ambiguous final submission, or report/appeal confirmation timeout exposes no
retry mode. The confirmation deadline is two minutes. Clients must not automatically resubmit after
that deadline because the final outcome remains uncertain. The API
reports original-report and appeal outcomes separately through `discordStatus`, `reviewStatus`, and
timeline events; clients must not collapse report denied with appeal denied, or report accepted with
appeal accepted.

`status=submitted` with no `discordStatus` means **Awaiting confirmation**: the submission request
returned an ID, but Discord's acknowledgement email has not been correlated. Only the authenticated
report-receipt email sets `discordStatus=received` and emits `discord:received`; clients show
**Confirmation received** and retain its timestamp in history. This email is separate from the
earlier verification-code email and `verification_received` event. Neither receipt nor the returned
submission ID means Discord took enforcement action.

## Events, webhooks, and recovery

`report_connection_retry` and `report_connection_restarting` are immediate progress events.
Their signed envelopes retain the minimal lifecycle-event shape; clients fetch the report's
recovery metadata using their personal key. An automatic successor may be observed before its
predecessor's restarting event, so consumers must support either event order idempotently.

`GET /v1/discord/dsa/events?after=&limit=` is the authoritative, replayable, account-scoped event feed. Events
contain only `eventId`, `accountId`, `reportId`, the API-generated UUID `traceId`, `type`, `occurredAt`,
and `lifecycleAttempt`—never
evidence or report text. Clients should persist the cursor only after all items are linked and
processed, then recover state through report reads. This provides durable recovery; clients still
need idempotent local processing rather than assuming zero delivery loss.

`traceId` is required on feed responses and webhook envelopes. It is operational correlation
metadata generated separately for every report lifecycle, including retries; callers cannot supply
it and clients must not render it to users. API and bot releases that introduce this field must be
deployed together. When the bot is deployed first, envelopes from an older API are rejected and
remain in the API's durable delivery retry queue until the API deployment completes.

Report create, retry, list, and detail responses also include the required API-generated `traceId`.
The trusted Cloudflare email-ingest response may include `reportId` and `traceId` only after the API
has matched the accepted or duplicate mail to a report. These values are restricted operational
correlation metadata and must never be rendered to Discord users.

Administrators may assign one destination to many accounts. In a single-bot deployment,
`BOT_EVENT_WEBHOOK_URL` and `BOT_EVENT_WEBHOOK_SECRET` configure a managed default destination:
on API startup it is refreshed, attached to active accounts with no destination, and used for new
accounts. Explicit administrator assignments take precedence. Each event/destination delivery is
unique, signed over the timestamp, event ID, and exact body, and retried with capped exponential
backoff for seven days. The bot stages webhook events even while its local create mapping is
pending, and the account feed remains a reconciliation backstop. With no destination, events remain available from the feed. Public
destinations require HTTPS; Railway private HTTP requires the explicit API configuration flag.

Webhook receivers must reject stale timestamps and replayed event IDs, verify the HMAC before JSON
parsing, and process the exact received bytes. The bot records unmatched valid events for later link
reconciliation and returns `2xx` for successful staging and duplicates.

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

The administrator diagnostics response additionally includes `pendingInboundMessages`,
`pendingInboundOlderThanTwoMinutes`, and `oldestPendingInboundAgeMs`. These aggregate fields expose
the durable inbound-email correlation backlog without including recipients, message content, or
verification values.

During private testing, API diagnostic ledger rows are retained for 30 days and are available only to
operators through SQL. They may contain report context and external failure details, but never raw
mail, credentials, cookies, proxy credentials, or verification codes.

## Client behavior

Use `DsaApi` from `@nreport/contracts` with a personal key and `DsaAdminApi` only for trusted
administration. Preserve idempotency keys across timeouts. Do not automatically retry the final
Discord submission, infer ownership from caller-provided data, or rely on webhooks as the only
recovery mechanism. Operational and diagnostic logging by clients and the bot may record Discord
identifiers, message URLs, external report IDs, and HTTP failure payloads for troubleshooting; credentials
and auth tokens must never be logged.
