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
`Accept-Language`, and IANA timezone. Discord's verification-email request and current form payload
both explicitly use the supported fixed language value `en`; it is intentionally not derived from
the country.

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
BOT_EVENT_WEBHOOK_URL=http://${{Discord-Bot.RAILWAY_PRIVATE_DOMAIN}}:3000/internal/report-events
BOT_EVENT_WEBHOOK_SECRET=<at least 32 random characters>
```

Generate independent secrets locally and never commit them:

```powershell
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
```

Use the Base64 value only for `SESSION_ENCRYPTION_KEY`. Use separate hexadecimal values
for `API_KEY`, `CLOUDFLARE_EMAIL_WEBHOOK_SECRET`, and `BOT_EVENT_WEBHOOK_SECRET`.

[`apps/api/railway.json`](apps/api/railway.json) defines the build, start, `/healthz`
health check, and restart policy. The
application creates or updates its database schema idempotently during startup.

### Bot service

Use [`apps/bot/.env.example`](apps/bot/.env.example) as the variable checklist. The bot
uses its own PostgreSQL service, stores access keys only as HMAC hashes, encrypts temporary
report drafts, and calls the API through `DSA_API_BASE_URL`. Production startup synchronizes
the global commands automatically. Set `OPENROUTER_API_KEY` for the bot-side report writer;
`OPENROUTER_MODEL` defaults to `google/gemma-4-31b-it`.
One adaptive research completion resolves only omitted Auto fields and researches the law. Fixed
values remain application-owned and are not included in model output schemas. OpenRouter's web
plugin performs one Parallel search with at most two results. The model uses that search to clarify
unfamiliar or coded evidence terminology only when materially necessary and to confirm the
country-specific law; with explicit evidence it focuses directly on the law.
OpenRouter selects a compatible provider that supports the requested strict JSON schema and plugin
parameters. If research returns malformed structured data, the bot starts the research once
more from the original evidence; a second failure is returned to the reporter. Missing server-tool
usage metadata is retained as telemetry and does not invalidate plugin-backed research. The final writer receives a compact
resolved context rather than the country list, category catalog, tool instructions, failed response,
or raw research transcript. HTTPS source annotations remain optional.
The bot records per-user request/token/reasoning/search/cost totals and operational workflow metadata
such as flow, category, country mode, selected elements, counts, lengths, latency, and validation
failures. Logs are intended to support development diagnostics and may include report and lifecycle
identifiers, state transitions, and error codes. Do not log credentials, verification codes, or raw
email. To synchronize commands manually, set only the
Discord token and application ID and run:

AI media processing is temporarily disabled for every report category. The bot never attaches
images, GIFs, videos, avatars, banners, server art, or attachment/embed media URLs to OpenRouter.
Attachment names and content types may remain as text metadata.

Every `/report` subcommand also accepts optional `dont-use-ai:true`. It defaults to AI when
omitted. Manual mode sends nothing to OpenRouter, limits the reporter's final text to 512
characters, and requires a saved or explicit country because Auto normally depends on AI.

```powershell
npm.cmd run register -w @discord-dsa/bot
```

In the Discord Developer Portal, enable **User Install** and disable **Guild Install** for
this application. The bot health endpoint becomes ready only after both PostgreSQL and the
Discord Gateway connection are available.

Set `REPORT_EVENT_WEBHOOK_SECRET` on the bot to the same value as the API's
`BOT_EVENT_WEBHOOK_SECRET`. The API pushes events to the bot's Railway private domain, so
the bot needs no public domain. Failed webhook deliveries retry durably, and a 15-minute
event-feed reconciliation provides an additional recovery path.

## Cloudflare Email Worker

Deploy [`apps/email-worker/src/index.ts`](apps/email-worker/src/index.ts) and
configure:

```text
INGEST_URL=https://discord-dsa-production.up.railway.app/webhooks/cloudflare-email
INGEST_SHARED_SECRET=<same value as CLOUDFLARE_EMAIL_WEBHOOK_SECRET>
```

Store `INGEST_SHARED_SECRET` as an encrypted Worker secret. Route the domain catch-all to
the Worker. It accepts SMTP envelope senders only when their domain is exactly `discord.com` or a
true subdomain of it, then requires the generated recipient format. The API independently requires
the parsed message sender to be exactly `noreply@discord.com`. Accepted mail is signed and posted
to Railway; it does not forward report mail to a personal inbox. HTTP requests receive a normal
`404` response because this deployment exposes no public HTTP endpoint.

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
- Automatically appeal an original no-action decision through the API-owned encrypted review-link
  flow. Retry Discord's first explicit ineligibility response once after 10 seconds, then allow
  owner-triggered retries with idempotency and cooldown protection. Never expose or log the link or
  token, and never repeat an ambiguous review POST.
- Keep credentials, verification codes, and raw mail out of logs and source control.
- Discord lifecycle email updates change `discordStatus`; they do not replace the successful
  API status `submitted`.
