# Discord DSA Monorepo Guide

This repository is an internal TypeScript npm-workspace monorepo for authorized EU Digital
Services Act reports involving Discord users, messages, and servers. It is composed of separate
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

The API is the source of truth for reports and report lifecycle. `main.ts` migrates PostgreSQL,
starts Fastify, the report `JobRunner`, and the durable API-to-bot `EventDeliveryWorker`.

- `server.ts` defines `/healthz`, authenticated `/v1` endpoints, the Cloudflare raw-email webhook,
  and API event feed.
- `database.ts` owns API schema, report/job/event/outbox state transitions, idempotency, retries,
  and verification deadlines.
- `job-runner.ts` owns the Discord lifecycle: request verification email, verify code, fetch the
  current report menu, submit, and close the client session.
- `email.ts` parses and classifies trusted Discord mail. It must never log raw mail, verification
  codes, or sensitive report context.
- `event-delivery.ts` posts signed lifecycle events to the bot and retries delivery durably.
- `pseudonyms.ts`, `security.ts`, and `validation.ts` own generated identity data, cryptography,
  and request validation.

Only the API imports `@discord-dsa/client`. The bot must call the API through
`@discord-dsa/contracts`'s `DsaApi` HTTP adapter.

### Bot: `apps/bot`

The bot owns Discord interactions, user access, credits, encrypted drafts, private report views,
and Discord DM delivery. It has its own PostgreSQL database and cannot access API tables.

- `main.ts` loads configuration, migrates the bot database, starts the private health/webhook
  server, logs in to Discord, and starts notification/reconciliation work.
- `commands.ts` and `command-registration.ts` define and register global user-installed commands.
- `interactions.ts` owns command/modal/select/button flows, ownership checks, credit reservation,
  API calls, and ephemeral responses.
- `database.ts` owns access keys, credit ledger, drafts, report tracking, lifecycle inbox, and
  notification outbox. Credit reservation is transactional; admins and
  `WHITELIST_ENABLED=false` intentionally bypass credits.
- `health.ts` serves `/healthz` and `/internal/report-events`. The latter verifies API HMAC
  signatures and is private-network only.
- `notifier.ts` ingests lifecycle events, reconciles the API event feed every 15 minutes, performs
  short active-creation polling, and sends lifecycle DMs. Submitted reports do not receive
  individual long-term polling; webhooks plus reconciliation handle their later updates.
- `ui.ts` is the shared private-embed and component layer. `profile-resolver.ts` and
  `server-resolver.ts` perform best-effort Discord enrichment.
- `crypto.ts`, `countries.ts`, `presence.ts`, and `observability.ts` hold cryptography, country
  display/autocomplete, online presence, and structured safe logging.

All interaction replies—including errors and administration—must be ephemeral. Lifecycle DMs are
ordinary private Discord messages because Discord does not support ephemeral DMs.

### Email Worker: `apps/email-worker`

The Cloudflare worker accepts only mail whose sender is exactly `noreply@discord.com` and whose
recipient matches a generated report alias. It signs and forwards untouched raw RFC 822 content to
the API. It must not parse report codes, keep mail, forward to a personal mailbox, or expose a
public HTTP handler unless separately needed.

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

1. The bot validates access and country, encrypts a 30-minute draft, shows an ephemeral review,
   then atomically reserves one normal-user credit and calls `POST /v1/reports` with
   `create:<interaction-id>`.
2. The API creates the report, generated pseudonym/email alias/proxy session, job, report event,
   and delivery-outbox record. The bot consumes a reserved credit only after creation succeeds.
3. The API requests a verification email through the low-level client. Cloudflare forwards only
   trusted Discord mail to the signed API webhook; the API correlates a code and enqueues
   verification/submission.
4. The API submits to Discord and stores report status/timeline/events. A final HTTP outcome with
   ambiguous submission state is never automatically retried.
5. The API signs lifecycle webhooks to the bot. The bot records them idempotently, sends the
   required private DM, and reconciles the paginated API event feed every 15 minutes. Tracking
   expires after 60 days; report history remains available from the API.
6. A retry is a new report lifecycle with a fresh report ID/session/email alias and does not spend
   another credit. It preserves the predecessor/successor relationship.

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
- Do not make the bot's private webhook endpoint public. Use Railway private networking for
  `BOT_EVENT_WEBHOOK_URL`.

## Configuration and deployment

Copy environment shapes from `apps/api/.env.example` and `apps/bot/.env.example`; never copy real
values into the repository.

- Railway API: [`apps/api/railway.json`](apps/api/railway.json), API PostgreSQL, proxy/email/API
  secrets, and optionally the bot private webhook URL/secret.
- Railway bot: [`apps/bot/railway.json`](apps/bot/railway.json), a separate bot PostgreSQL,
  Discord credentials, access/encryption secrets, and API URL/key. `/healthz` is healthy only
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
npm.cmd run register -w @discord-dsa/bot
npm.cmd test -w @discord-dsa/api
npm.cmd test -w @discord-dsa/bot
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
