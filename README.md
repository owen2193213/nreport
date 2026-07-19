# Discord DSA Reporting Service

An internal TypeScript service for authorized EU Digital Services Act reports involving
Discord users, messages, and servers. A Discord bot calls the authenticated Railway API;
the backend owns reporter pseudonyms, catch-all email addresses, country-matched sticky
proxy sessions, verification email processing, live menu resolution, submission, retries,
and status history.

The production lifecycle has been verified end to end: create report, receive and verify
the email code, submit to Discord, persist the Discord report ID, and process the received
confirmation email.

## Start here

- **Bot developers:** [`docs/BOT_API.md`](docs/BOT_API.md) is the canonical API contract,
  with request schemas, status handling, errors, report types, and a TypeScript adapter.
- **Service operators:** use the deployment configuration below.
- **Backend maintainers:** see [`BACKEND_DESIGN.md`](BACKEND_DESIGN.md).
- **Low-level client maintainers:** see [`CLIENT_DESIGN.md`](CLIENT_DESIGN.md) and
  [`HEADER_TEST_RESULTS.md`](HEADER_TEST_RESULTS.md).
- **Protocol history:** [`DISCORD_DSA_API_HANDOFF.md`](DISCORD_DSA_API_HANDOFF.md) preserves
  the original workflow capture. It is not the bot-facing contract.

## Architecture

- Railway Fastify service: authenticated report API, signed email webhook, and durable jobs.
- Railway PostgreSQL: reports, idempotency, events, encrypted session state, and job leases.
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

`railway.json` defines the build, start, `/healthz` health check, and restart policy. The
application creates or updates its database schema idempotently during startup.

## Cloudflare Email Worker

Deploy [`cloudflare-email-worker/src/index.ts`](cloudflare-email-worker/src/index.ts) and
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
