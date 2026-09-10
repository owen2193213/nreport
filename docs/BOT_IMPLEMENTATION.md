# Discord bot implementation

Status: thin account client
API contract: [`BOT_API.md`](BOT_API.md)

The bot is a separately deployed Discord user-installed application. It owns Discord
interactions, encrypted personal API credentials, the local Discord-user/account mapping, pending
forms, report-to-DM links, notification preferences, and delivery deduplication. The API owns
reports, credits, AI/search, identities, verification, submission, decisions, appeals, analytics,
and history.

The services use independent PostgreSQL databases and encryption keys. The bot never imports API
database/job internals or `@discord-dsa/client`, and contains no AI-provider or Brave credential.

## Account access

- `/access connect` opens an ephemeral modal for a personal key. The bot validates it with
  `GET /v1/discord/dsa/account`, encrypts it, and stores the stable account ID, immutable username, prefix, and
  connection time.
- `/access status` displays the API username, key prefix, status, available/reserved credits, and
  cumulative usage.
- `/access disconnect` deletes the encrypted credential and pending forms. Existing API reports
  remain account-owned, but local background refreshes stop until reconnection.

The bot enforces one API account per local Discord user and one local Discord user per API account.
Connecting a rotated key for the same account updates the encrypted credential. It never sends the
Discord user's ID to the API. A revoked key pauses detailed refreshes and prompts the user privately
to reconnect.

## Reporting experience

Commands support message, profile, and server flows plus the message context-menu actions. The
normal modal is the final action; there is no target-preview, confirmation, or AI review/refine
screen. It uses Discord's current modal components: a radio group for AI/manual mode, select menus
for the report category and profile/server elements, and text inputs for details and country.

- AI is enabled by default. Country and category may be left blank as Auto; report details are an
  optional evidence/guidance hint. The API selects omitted values and returns its written report as
  `finalText`.
- Manual mode requires country, category, and final text of at most 512 characters.
- Quick Report immediately submits captured message evidence with `useAi: true`; it opens no
  modal or review step.
- The bot resolves only evidence available through Discord's supported bot interface.
- Referenced/replied-to messages are not captured, displayed as evidence, or supplied to AI.
- Images and media URLs are never sent to the AI/search services by the bot; those services exist
  only in the API.

Before calling create, the bot persists the account, stable idempotency key, encrypted request, and
local report/DM mapping. This ordering lets the webhook endpoint return `409` only during the narrow
linking race, which asks the API to retry. A timeout or lost create response is reconciled by
replaying the same body and key. Definite client errors abandon that pending operation.

The bot sends one private Components V2 DM card. Message cards keep the author mention with
`@username`, the plain message URL, and a bounded code-blocked excerpt in the same reported-message
block; account type, channel/location, posted time, and attachment counts are omitted. The fenced report
section contains only the API's `finalText`; target identity and example message content are never
concatenated into that code block.

The card deliberately groups fast internal events into stable visible states while keeping the
meaningful boundaries explicit: **Queued for Discord submission**, **Preparing report**,
**Requesting verification from Discord**, **Waiting for Discord verification email**, and
**Submitting report to Discord**. Queued cards show the API's current queue length. History uses
relative Discord timestamps and concise chronological actions. When applicable, report denial and
appeal submission are collapsed into **Report denied; appeal submitted**. Nonterminal updates wait two seconds, retain only the latest pending state,
are spaced at least five seconds apart, and skip identical visible-payload hashes. Terminal updates
bypass the spacing. This prevents pairs such as “Submitting report” followed immediately by
“Awaiting verification email” from producing rapid Discord edits. If Discord returns error `50007`,
the bot warns in the ephemeral interaction response that it could not DM the user; the API report
continues.

After Discord closes a report without action, `reviewStatus=queued` displays **Preparing appeal —
Not submitted yet**. Only `reviewStatus=requested` or `received` displays **Appeal submitted —
Awaiting Discord's decision**; the UI never uses an ambiguous generic “Appeal pending” label.

## Notifications and recovery

The private `/internal/report-events` endpoint verifies the timestamped HMAC over the exact body,
rejects stale/replayed deliveries, and records each event idempotently. Payloads contain identifiers
and state type plus a required API-generated UUID `traceId`; the notifier fetches authoritative
details with the connected personal key. The inbox persists the trace for operational correlation,
but the bot never renders it. The bot migration adds the nullable column before validation is
tightened so existing inbox rows remain readable; every newly accepted event has a valid trace.

The bot also polls each connected account's cursor-based event feed every 15 minutes. It does not
advance a cursor past an event that cannot yet be linked. Webhook and polling ingestion share the
same event inbox so duplicate delivery cannot create duplicate DMs. Pending create/retry calls are
replayed with their original idempotency key before normal feed reconciliation.

Notification and reconciliation operational events retain their stable event names and emit a
bounded `stage`, `outcome`, and `durationMs`; failures also emit a safe error category. Where a
lifecycle event supplies a trace, it is the only report-level correlation value in these logs. Raw
report, account, event, message, and Discord user identifiers are never logged.

The status card is always maintained while the account is connected. Decision/problem messages reply
to that card so the affected report remains clear. Terminal replies use an enforced, deterministic
Discord nonce derived only from the durable lifecycle event ID, allowing Discord to deduplicate a
retry when the original message-create response was lost. The inbox item is completed only after
Discord accepts the reply. These replies are sent
only for decisions or actionable problems: original-report accepted, appeal accepted, appeal
denied, report/appeal confirmation timeout, ineligible appeal, and failure. The original
report-denied DM is off by default because the automatic appeal continues; its preference is
independent from appeal-denied and accepted-decision notifications. Progress events do not create
separate DMs. Daily/weekly digest summaries come from the authenticated account's API endpoint and
have local idempotent delivery records.

## History, retry, and analytics

Report history, status, eligible retry modes, personal analytics, action history, and digest
activity are fetched using the connected personal key. Community analytics uses the same key but
returns only protected aggregate data. The bot never relies on a Discord ID field inside an API
report for ownership; the local connection and report link are authoritative.

Pre-submission failures display the API's safe stage-specific reason and expose API-authorized
**Retry submission** (`reuse`) or **Retry with fresh report** (`regenerate`) controls. An appeal denial
instead exposes exactly two actions on the existing status card: **Rewrite with AI** and **Edit
manually**. Rewrite is autonomous and opens no modal; it asks the API to improve clarity, legal
relevance, specificity, and category fit using only immutable evidence, without inventing facts or
claiming to know Discord's denial reason. Manual editing uses a category dropdown and exact final
text. There is no “resend as is” action after an appeal denial.

Discord outcomes are presented distinctly as report accepted, report denied, appeal accepted, or
appeal denied. Appeal-ineligible and two-minute report/appeal confirmation timeouts are terminal and
offer no retry. A timed-out report may refer to a deleted or inaccessible message, so the bot never
automatically resubmits it. Every permitted retry still uses a stable operation key and a fresh API
eligibility read; the API remains authoritative for lifecycle and retry eligibility.

## Administration

Discord administrator commands are restricted to configured Discord IDs and use `DsaAdminApi` for
account creation, one-time key issuance, rotation, credit adjustments, suspension, and
reinstatement. All interaction replies, including administration, are ephemeral. The administrator
credential is never used for ordinary reports.

Bot-local redeemable access keys, credit balances, provider usage, experimental batches, shadowban
simulation, and surveillance webhooks have been removed.

## Local database

The bot database contains:

- encrypted API connections and the one-to-one ownership constraints;
- short-lived encrypted pending forms;
- pre-created report/idempotency/DM links used for reconciliation;
- encrypted target-display context and visible-card hashes beside those links;
- a coalescing, deduplicated lifecycle-event inbox and per-account feed cursor;
- notification preferences and digest delivery records.

It does not duplicate report evidence as readable columns, maintain credits, or become an
alternative source of report truth.

## Deployment

Use a new Discord application, bot database, and `BOT_DATA_ENCRYPTION_KEY`. Configure
`NREPORT_API_URL`, `NREPORT_ADMIN_KEY`, and optionally `REPORT_EVENT_WEBHOOK_SECRET`; see
`apps/bot/.env.example`. Register global commands after the new API and test account are ready.
Do not point the new bot at the historical API or database.

The API runs `LIFECYCLE_CONCURRENCY` independent lifecycle job loops (default `2`, valid range
`1..16`) plus an independently scheduled recovery/deadline-maintenance loop. A delayed appeal or
other stalled lifecycle request therefore occupies only its own slot and does not pause maintenance.
Each running lifecycle job renews its database lease every 30 seconds so recovery cannot reclaim a
live job, including one that has crossed the irreversible submission boundary. The claimed attempt
number is also the execution token: heartbeats and all lifecycle status, completion, retry, failure,
submission, and review transitions require the same running job and token, so a recovered stale
worker cannot mutate its replacement claim. A worker that loses heartbeat ownership abandons further
progress and closes its Discord client where possible. Shutdown stops new claims, cancels idle
cadence timers, and waits for in-flight lifecycle work.
Lifecycle logs contain only the report trace, job kind, attempt count, duration, outcome, and a safe error category;
they must never include report, job, account, or Discord identifiers, evidence, verification codes,
URLs, provider responses, or arbitrary error messages.
Bot notification logs similarly contain only the report trace, lifecycle event type, attempt count,
duration, outcome, and safe error category. Reconciliation event logs use the trace and bounded event
type/outcome fields; connection summaries contain only duration, outcome, and safe error category;
failures are isolated per connection so one unavailable account does not stop later accounts.

The health endpoint becomes ready only when PostgreSQL and the Discord gateway are ready. The bot
webhook is intended for Railway private networking and does not need a public domain.
