# NReport Discord DSA Monorepo Guide

This repository is the NReport TypeScript npm-workspace monorepo. Discord is a service category and
DSA reporting is the `discord.dsa` service type for authorized reports involving Discord users,
messages, and servers. It is composed of separate
deployments that communicate over authenticated HTTP; do not collapse their boundaries by importing
one application's database or job internals into another.

## Read first

- [`README.md`](README.md) is the operator-facing entry point: repository purpose, Railway,
  Cloudflare, and local commands.
- [`docs/BOT_API.md`](docs/BOT_API.md) is the canonical bot-to-API contract. Update it whenever a
  public API shape, lifecycle event, or bot-visible behavior changes.
- [`docs/BOT_IMPLEMENTATION.md`](docs/BOT_IMPLEMENTATION.md) records the implemented Discord UI,
  credit, notification, polling, and operational decisions.
- [`BACKEND_DESIGN.md`](BACKEND_DESIGN.md) and [`CLIENT_DESIGN.md`](CLIENT_DESIGN.md) explain
  backend and low-level transport design choices. `DISCORD_DSA_API_HANDOFF.md`,
  `HEADER_TEST_RESULTS.md`, and `IPOASIS_PROXY_NOTES.md` are retained as historical protocol,
  experiment, and proxy reference material.

## Workspace layout

```text
apps/
  api/                 Fastify report API and background worker; Railway service.
  bot/                 Discord user-installed application; separate Railway service and database.
  email-worker/        Cloudflare Email Worker that forwards trusted raw Discord mail.
packages/
  discord-dsa-client/  Low-level Discord reporting transport; API-only dependency.
  report-contracts/    Shared DTOs, semantic catalogs, and typed HTTP client.
scripts/               Read-only transport diagnostics. Python diagnostics are protected.
docs/                  Canonical bot contract and implementation decisions.
```

The root `package.json` owns npm workspaces and the only lockfile. Build from the repository root
so workspace dependencies resolve from the same committed `package-lock.json`.

## Architecture and ownership

### API: `apps/api`

The API is the source of truth for accounts, credits, reports, preparation, and report lifecycle.
`main.ts` migrates PostgreSQL and starts Fastify plus separate preparation, Discord lifecycle, and
durable event-delivery workers.

- `server-v2.ts` defines `/healthz`, authenticated `/v1/discord/dsa` and
  `/v1/admin/discord/dsa` endpoints, the Cloudflare raw-email webhook,
  and API event feed.
- `accounts.ts`, `report-repository.ts`, `analytics-repository.ts`, and
  `webhook-destinations.ts` own focused persistence concerns.
- `preparation-worker.ts` and `preparation/` own AI planning, bounded Brave research, writing, and
  usage. `lifecycle-runner-v2.ts` owns verification, submission, and automatic appeals.
- `email.ts` parses and classifies trusted Discord mail. It must never log raw mail, verification
  codes, or sensitive report context.
- `event-delivery-v2.ts` posts minimal signed lifecycle events to assigned destinations and retries
  each event/destination pair durably.
- `pseudonyms.ts`, `security.ts`, and `validation.ts` own generated identity data, cryptography,
  and request validation.

Only the API imports `@discord-dsa/client`. The bot must call the API through
`@nreport/contracts`'s `DsaApi` HTTP adapter.

### Bot: `apps/bot`

The bot owns Discord interactions, encrypted personal API keys, the local Discord-user/account
mapping, pending operations, private report views, and Discord DM delivery. It has its own
PostgreSQL database and cannot access API tables.

- `main.ts` loads configuration, migrates the bot database, starts the private health/webhook
  server, logs in to Discord, and starts notification/reconciliation work.
- `commands.ts` and `command-registration.ts` define and register global user-installed commands.
- `account-interactions.ts` owns account, report, retry, analytics, and administration flows.
- `account-database.ts` owns encrypted connections, pending idempotent operations, report links,
  lifecycle inbox, cursors, preferences, and digest-delivery state. Credits live only in the API.
- `health.ts` serves `/healthz` and `/internal/report-events`. The latter verifies API HMAC
  signatures and is private-network only.
- `account-notifier.ts` ingests lifecycle events, replays uncertain creates/retries, reconciles
  each account feed every 15 minutes, and edits one private DM card per report.
- `profile-resolver.ts` and `message-resolver.ts` perform best-effort Discord enrichment.
- `crypto.ts`, `presence.ts`, and `observability.ts` hold cryptography, online presence, and safe logging.

All interaction replies—including errors and administration—must be ephemeral. Lifecycle DMs are
ordinary private Discord messages because Discord does not support ephemeral DMs.

### Email Worker: `apps/email-worker`

The Cloudflare worker accepts SMTP envelope senders only when their domain is exactly `discord.com`
or a true subdomain such as `mail.discord.com`, and only when the recipient matches a generated
report alias. It signs and forwards untouched raw RFC 822 content to the API. The API independently
requires the parsed message sender to be exactly `noreply@discord.com`. The worker must not parse
report codes, keep mail, forward to a personal mailbox, or expose a public HTTP handler unless
separately needed.

### Low-level client: `packages/discord-dsa-client`

`DiscordDsaClient` preserves one proxy/cookie/fingerprint session across a single report lifecycle.
It requests and verifies email codes, resolves live semantic menus, prepares payloads, and submits
reports. It owns no persistent data and must not automatically retry an ambiguous final submission.

Key modules:

- `transport.ts`: Undici proxy transport, cookie jar, request/response safety.
- `client.ts`: high-level lifecycle operations and session snapshots.
- `menu.ts`: live semantic menu traversal.
- `payload.ts`: flow-specific validated Discord payload creation.
- `errors.ts` and `types.ts`: stable error and model boundary.

### Shared contracts: `packages/report-contracts`

`types.ts` defines report and timeline DTOs. `catalog.ts` defines semantic report reasons/elements.
`api.ts` provides the typed authenticated HTTP client used by the bot. Keep this package free of
Discord SDK, PostgreSQL, Fastify, or worker-runtime dependencies.

## Report lifecycle

1. A client authenticates with a personal key and submits immutable evidence plus AI/manual
   preferences using a stable idempotency key.
2. The API transactionally reserves an account credit and creates the report, retry chain,
   preparation job, event, and applicable deliveries, then returns `202` before external work.
3. Preparation resolves omitted fields, optionally researches/writes, persists the result, and
   only then creates the country-specific identity and session.
4. The API requests a verification email through the low-level client. Cloudflare forwards only
   trusted Discord mail to the signed API webhook; the API correlates a code and enqueues
   verification/submission.
5. The API consumes the chain entitlement at the final submission boundary, submits to Discord,
   and stores status/timeline/events. A final HTTP outcome with
   ambiguous submission state is never automatically retried.
6. The API signs lifecycle webhooks to assigned destinations. The bot records them idempotently,
   edits one private DM card, and reconciles the paginated account event feed every 15 minutes.
7. Retries form a serial chain. Consumed chains reuse their entitlement; released chains reserve a
   current credit. Each retry has a fresh report ID, identity, and session.

## Security and privacy rules

- Never commit, print, or send secrets: Discord token, API keys, encryption keys, proxy URLs or
  credentials, HMAC secrets, cookies, email tokens, verification codes, raw email, or report
  context.
- Use signed API-to-bot events and signed Cloudflare-to-API mail. Reject replayed, malformed,
  expired, and untrusted input at the owning boundary.
- Callers never provide reporter identity. The API generates identity, address, locale, timezone,
  and sticky proxy session from the selected country.
- Treat Discord report IDs, internal report IDs, generated aliases, and full report context as
  sensitive operational data. Structured logs use safe diagnostics only.
- Preserve idempotency keys. Do not replace an ambiguous network failure with an automatic final
  Discord resubmission.
- Do not make the bot's private webhook endpoint public. Assign its destination through the admin
  API and use Railway private networking when available.

## Configuration and deployment

Copy environment shapes from `apps/api/.env.example` and `apps/bot/.env.example`; never copy real
values into the repository.

- Railway API: [`apps/api/railway.json`](apps/api/railway.json), API PostgreSQL, personal-key
  pepper, administrator/provider/proxy/email secrets, and administrator-managed destinations.
- Railway bot: [`apps/bot/railway.json`](apps/bot/railway.json), a separate bot PostgreSQL,
  Discord credentials, bot encryption secret, API URL, and administrator key. `/healthz` is healthy only
  after the database and Discord gateway are ready.
- Cloudflare: deploy `apps/email-worker` independently with Wrangler and set
  `INGEST_SHARED_SECRET` to the API email webhook secret. The worker's `INGEST_URL` targets the
  API public email-ingest endpoint.
- Railway watch paths are service-specific. Contract changes deploy both services; API client
  changes deploy the API only; worker/docs-only changes do not redeploy Railway.

## Development and validation

Use `npm.cmd` in PowerShell if the unsigned `npm.ps1` wrapper is blocked.

```powershell
npm.cmd ci
npm.cmd run lint
npm.cmd run typecheck
npm.cmd test
npm.cmd run build
npm.cmd run audit:high
```

Focused commands:

```powershell
npm.cmd run dev:api
npm.cmd run dev:bot
npm.cmd run register -w @nreport/discord-dsa-bot
npm.cmd test -w @nreport/api
npm.cmd test -w @nreport/discord-dsa-bot
npm.cmd run test:headers
npm.cmd run test:client-readonly
```

`test:headers`, `test:client-readonly`, and `test:post-headers` touch Discord's reporting
transport. Use only authorized, controlled diagnostics with a properly configured EU proxy; do
not run them as normal CI tests.

After every TypeScript change, run lint, workspace typecheck, tests, build, and the high-severity
audit. The GitHub workflow repeats these checks on pull requests and `main`.

## Change rules

- Preserve the API/bot ownership boundary and use `packages/report-contracts` for shared types.
- Update `docs/BOT_API.md` with API or lifecycle contract changes, and update
  `docs/BOT_IMPLEMENTATION.md` when operational behavior changes.
- Do not remove the historical protocol, proxy, or test-evidence Markdown files without replacing
  their distinct knowledge. `docs/COMMAND_UI_DESIGN.md` was removed because it duplicated the
  implementation guide and contradicted current lifecycle behavior.
- The Python scripts in `scripts/` are protected diagnostic tools. Never edit, stage, commit, or
  upload them unless the user explicitly asks for that exact script.
- Stage explicitly scoped files. Do not use broad Git reset/checkout operations in a dirty tree.

## Decision log

- Chosen: one root guide that maps ownership and operational rules, while canonical detailed
  specifications remain in their existing documents.
- Chosen: preserve distinct historical and experimental documentation because it records evidence
  that is not duplicated by the current implementation guides.
- Chosen: remove only the stale command UI design document because its decisions are incorporated
  in `docs/BOT_IMPLEMENTATION.md` and its submitted-report polling statement is no longer true.
