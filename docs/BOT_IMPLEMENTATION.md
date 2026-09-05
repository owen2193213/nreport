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
  `GET /v1/account`, encrypts it, and stores the stable account ID, immutable username, prefix, and
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
normal modal is the final action; there is no AI review/refine screen.

- AI is enabled by default. Country, category, and description may be hints or left for the API.
- Manual mode requires country, category, and final text of at most 512 characters.
- Quick Report immediately submits captured message evidence with `useAi: true`.
- The bot resolves only evidence available through Discord's supported bot interface.
- Images and media URLs are never sent to the AI/search services by the bot; those services exist
  only in the API.

Before calling create, the bot persists the account, stable idempotency key, encrypted request, and
local report/DM mapping. This ordering lets the webhook endpoint return `409` only during the narrow
linking race, which asks the API to retry. A timeout or lost create response is reconciled by
replaying the same body and key. Definite client errors abandon that pending operation.

The bot sends one private DM card and edits it as the API advances through queued, preparation,
verification, submission, and decision/appeal states. If Discord returns error `50007`, the bot
warns in the ephemeral interaction response that it could not DM the user; the API report continues.

## Notifications and recovery

The private `/internal/report-events` endpoint verifies the timestamped HMAC over the exact body,
rejects stale/replayed deliveries, and records each event idempotently. Payloads contain identifiers
and state type only; the notifier fetches authoritative details with the connected personal key.

The bot also polls each connected account's cursor-based event feed every 15 minutes. It does not
advance a cursor past an event that cannot yet be linked. Webhook and polling ingestion share the
same event inbox so duplicate delivery cannot create duplicate DMs. Pending create/retry calls are
replayed with their original idempotency key before normal feed reconciliation.

Notification preferences control lifecycle updates and daily/weekly digests. Digest summaries come
from the authenticated account's API endpoint and have local idempotent delivery records.

## History, retry, and analytics

Report history, status, eligible retry modes, personal analytics, action history, and digest
activity are fetched using the connected personal key. Community analytics uses the same key but
returns only protected aggregate data. The bot never relies on a Discord ID field inside an API
report for ownership; the local connection and report link are authoritative.

Retries require a user-selected `reuse` or `regenerate` mode and a stable operation key. The bot
displays only modes returned by the API and does not implement automatic report retries.

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
- a deduplicated lifecycle-event inbox and per-account feed cursor;
- notification preferences and digest delivery records.

It does not duplicate report evidence as readable columns, maintain credits, or become an
alternative source of report truth.

## Deployment

Use a new Discord application, bot database, and `BOT_DATA_ENCRYPTION_KEY`. Configure
`DSA_API_BASE_URL`, `DSA_ADMIN_API_KEY`, and optionally `REPORT_EVENT_WEBHOOK_SECRET`; see
`apps/bot/.env.example`. Register global commands after the new API and test account are ready.
Do not point the new bot at the historical API or database.

The health endpoint becomes ready only when PostgreSQL and the Discord gateway are ready. The bot
webhook is intended for Railway private networking and does not need a public domain.
