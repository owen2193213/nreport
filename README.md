# Discord DSA Reporting Monorepo

An internal TypeScript monorepo for authorized EU Digital Services Act reports involving
Discord users, messages, and servers. A user-installed Discord app calls an independently
deployed authenticated Railway API;
the backend owns reporter pseudonyms, catch-all email addresses, country-matched sticky
proxy sessions, verification email processing, live menu resolution, submission, retries,
and status history.

The production lifecycle has been verified end to end: create report, receive and verify
the email code, submit to Discord, persist the Discord report ID, and process the received
confirmation email.

## Start here

- **Bot developers:** [`docs/BOT_API.md`](docs/BOT_API.md) is the canonical API contract,
  with request schemas, status handling, errors, report types, and a TypeScript adapter.
- **Bot operators:** [`docs/BOT_IMPLEMENTATION.md`](docs/BOT_IMPLEMENTATION.md) documents
  commands, access credits, lifecycle DMs, and deployment.
- **Service operators:** use the deployment configuration below.
- **Backend maintainers:** see [`BACKEND_DESIGN.md`](BACKEND_DESIGN.md).
- **Low-level client maintainers:** see [`CLIENT_DESIGN.md`](CLIENT_DESIGN.md) and
  [`HEADER_TEST_RESULTS.md`](HEADER_TEST_RESULTS.md).
- **Protocol history:** [`DISCORD_DSA_API_HANDOFF.md`](DISCORD_DSA_API_HANDOFF.md) preserves
  the original workflow capture. It is not the bot-facing contract.

## Architecture

- `apps/api`: Railway Fastify service, authenticated report API, signed email webhook, and jobs.
- `apps/bot`: separate Railway Discord service, access credits, report UI, and lifecycle DMs.
- `packages/discord-dsa-client`: low-level Discord reporting client used only by the API.
- `packages/report-contracts`: shared API DTOs, semantic catalogs, and typed HTTP adapter.
- Two PostgreSQL services: one for authoritative reports and one for bot access/notification state.
- Cloudflare Email Routing: whole-domain catch-all delivered to an Email Worker.
- IPOasis: one country-specific sticky residential proxy session per lifecycle attempt.

All 27 EU member states are supported. Localized, version-locked Faker data generates
organization-controlled pseudonyms where available; Bulgaria, Estonia, Lithuania, and
Malta use Faker's generic fallback. Names stay in Unicode in reports and are transliterated
only for readable internal IDs and email local-parts. Nothing is scraped at runtime.

The selected country controls the pseudonym profile, proxy country, locale,
`Accept-Language`, and IANA timezone. Discord's current form payload language is the
supported fixed value `en`; it is intentionally not derived from the country.

## Railway configuration

Connect the same GitHub repository to two Railway services and leave each service root at
the repository root so npm workspaces and the root lockfile remain available.

| Service | Railway config path |
|---|---|
| DSA API | `/apps/api/railway.json` |
| Discord bot | `/apps/bot/railway.json` |

The config files define independent build/start commands, health checks, and watch paths.
API-only commits do not rebuild the bot, and bot-only commits do not rebuild the API.

### API service

Connect this repository and a PostgreSQL service in the same Railway EU environment. Set:

```text
NODE_ENV=production
DATABASE_URL=${{Postgres.DATABASE_URL}}
API_KEY=<at least 32 random characters>
SESSION_ENCRYPTION_KEY=<Base64-encoded 32-byte key>
CLOUDFLARE_EMAIL_WEBHOOK_SECRET=<at least 32 random characters>
REPORT_EMAIL_DOMAIN=<Cloudflare Email Routing domain>
DSA_PROXY_URL_TEMPLATE=<sticky proxy URL containing {country} and {session}>
WORKER_ENABLED=true
```

Generate independent secrets locally and never commit them:

```powershell
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
```

Use the Base64 value only for `SESSION_ENCRYPTION_KEY`. Use separate hexadecimal values
for `API_KEY` and `CLOUDFLARE_EMAIL_WEBHOOK_SECRET`.

[`apps/api/railway.json`](apps/api/railway.json) defines the build, start, `/healthz`
health check, and restart policy. The
application creates or updates its database schema idempotently during startup.

### Bot service

Use [`apps/bot/.env.example`](apps/bot/.env.example) as the variable checklist. The bot
uses its own PostgreSQL service, stores access keys only as HMAC hashes, encrypts temporary
report drafts, and calls the API through `DSA_API_BASE_URL`. Register global commands once
with:

```powershell
npm.cmd run register -w @discord-dsa/bot
```

In the Discord Developer Portal, enable **User Install** and disable **Guild Install** for
this application. The bot health endpoint becomes ready only after both PostgreSQL and the
Discord Gateway connection are available.

## Cloudflare Email Worker

Deploy [`apps/email-worker/src/index.ts`](apps/email-worker/src/index.ts) and
configure:

```text
INGEST_URL=https://discord-dsa-production.up.railway.app/webhooks/cloudflare-email
INGEST_SHARED_SECRET=<same value as CLOUDFLARE_EMAIL_WEBHOOK_SECRET>
```

Store `INGEST_SHARED_SECRET` as an encrypted Worker secret. Route the domain catch-all to
the Worker. It accepts only generated address formats, signs the raw message, and posts it
to Railway; it does not forward report mail to a personal inbox.

## Local development and validation

```powershell
npm.cmd install
npm.cmd run lint
npm.cmd run typecheck
npm.cmd test
npm.cmd run build
npm.cmd audit --audit-level=high
```

The read-only header and client diagnostics are:

```powershell
npm.cmd run test:headers
npm.cmd run test:client-readonly
```

They require a correctly configured EU proxy for meaningful results. Do not put proxy
credentials, fingerprints, verification tokens, or API keys in source control or logs.

## Operational rules

- Callers never supply a reporter name or email address.
- Bots always set `submitterDiscordUserId` from the authenticated interaction user.
- Use a stable `Idempotency-Key` for every create or retry request.
- Resolve semantic report types through the live Discord menu; never persist breadcrumbs.
- Do not automatically retry an ambiguous final submission.
- Treat generated email addresses, tokens, raw mail, and report context as sensitive.
- Discord lifecycle email updates change `discordStatus`; they do not replace the successful
  API status `submitted`.
