# NReport

NReport is an internal TypeScript platform for authorized reporting workflows. Discord is a service
category and DSA reporting is the first service type, identified as `discord.dsa`. Its account-owned
HTTP API performs the entire durable workflow; the Discord user-installed app is one thin client.

## Start here

- [`docs/BOT_API.md`](docs/BOT_API.md): public account/admin contract, credits, retries, events,
  errors, and client behavior.
- [`docs/BOT_IMPLEMENTATION.md`](docs/BOT_IMPLEMENTATION.md): Discord commands, encrypted account
  connection, DM updates, and reconciliation.
- [`docs/AI_REPORTING_FLOW.md`](docs/AI_REPORTING_FLOW.md): API-side preparation and research.
- [`BACKEND_DESIGN.md`](BACKEND_DESIGN.md) and [`CLIENT_DESIGN.md`](CLIENT_DESIGN.md): backend and
  low-level Discord transport design.
- Historical protocol and transport evidence remain in `DISCORD_DSA_API_HANDOFF.md`,
  `HEADER_TEST_RESULTS.md`, and `IPOASIS_PROXY_NOTES.md`.

## Architecture

- `apps/api`: Fastify account/admin API, PostgreSQL preparation and Discord lifecycle workers,
  signed email ingest, durable events, and per-destination delivery.
- `apps/bot`: Discord UI, encrypted personal-key mapping, pending operation reconciliation, and one
  evolving private status card per report.
- `apps/email-worker`: Cloudflare worker forwarding trusted raw Discord mail to the new API.
- `packages/report-contracts`: shared DTOs, schemas, catalogs, `DsaApi`, and `DsaAdminApi`.
- `packages/discord-dsa-client`: low-level Discord transport used only by the API.

The API and bot have separate PostgreSQL databases and encryption keys. The API never accepts the
submitting Discord user's ID. It can serve other bots because ownership derives solely from each
personal API key. The bot alone maps a Discord user to the stable API account ID.

## Report lifecycle

A client calls `POST /v1/discord/dsa/reports` with a personal key and stable idempotency key. The API
transactionally reserves a credit, stores the immutable input, creates the retry chain, job, and
event, and returns `202` before external network work. The preparation worker optionally plans,
researches, and writes; then the API creates the localized identity/session, completes Discord
email verification, consumes the credit immediately before final submission, tracks decisions,
and automatically handles eligible appeals.

Clients recover every visible state through account-scoped report reads and the cursor event feed.
Administrator-assigned signed webhooks reduce latency but are optional. Ambiguous final Discord
submissions are never retried automatically.

## New deployment

This generation must coexist with the historical Railway system. Create all of the following new:

- API and bot Railway services;
- independent API and bot PostgreSQL databases;
- session and bot-data encryption keys, API-key pepper, and administrator key;
- Discord application and bot token;
- report email domain, Cloudflare email route/worker destination, and ingest secret;
- AI/Brave credentials and webhook signing secret.

Do not mutate or redeploy the historical services or share their databases, Discord application,
or report email route.

Both Railway services use the repository root so npm workspaces and the root lockfile are present:

| Service | Railway configuration |
|---|---|
| API | `apps/api/railway.json` |
| Bot | `apps/bot/railway.json` |

Use `apps/api/.env.example` and `apps/bot/.env.example` as variable checklists. AI and Brave
secrets exist only on the API. The bot carries the administrator key only for commands restricted
to configured Discord administrators; all normal work uses a connected personal key.

Deploy safely in this order:

1. Create the new databases, Discord application, email domain/worker route, and independent secrets.
2. Deploy and migrate the new API with `WORKER_ENABLED=false`; verify `/healthz` and
   `/openapi.json`.
3. Create a webhook destination and test account through the admin API; assign the destination.
4. Deploy the new bot, register its user-install commands, connect the test account, and validate
   mocked flows plus only explicitly authorized live flows.
5. Enable the API workers and verify event-feed recovery as well as webhook delivery.

Public webhook destinations require HTTPS. Railway private HTTP destinations require
`ALLOW_RAILWAY_PRIVATE_HTTP_WEBHOOKS=true`. The event feed remains authoritative when no destination
is assigned or all deliveries fail.

## Cloudflare email worker

Deploy the new Worker as `nreport-discord-dsa-email` and configure both values as Cloudflare
secrets so no deployment-specific API hostname is committed:

```text
INGEST_URL=https://<new-api-domain>/webhooks/cloudflare-email
INGEST_SHARED_SECRET=<same value as CLOUDFLARE_EMAIL_WEBHOOK_SECRET>
```

Route only the new report domain to it. The Worker accepts only the exact envelope sender
`noreply@discord.com` and forwards raw RFC 822 data without storing or parsing report codes; the API
validates the message and correlates generated aliases.

## Development and validation

Run from the repository root:

```powershell
npm.cmd ci
npm.cmd run lint
npm.cmd run typecheck
npm.cmd test
npm.cmd run build
npm.cmd run audit:high
```

Do not run `test:headers`, `test:client-readonly`, or `test:post-headers` as normal verification.
Those scripts touch Discord's reporting transport and require an explicitly authorized controlled
environment and EU proxy.

## Security rules

- Never commit or log personal/admin keys, provider credentials, signing/encryption secrets,
  cookies, proxy details, verification codes, raw mail, prompts, or report evidence.
- Callers never supply reporter identity or the submitting Discord user's identity.
- Keep original evidence immutable and exclude media content/URLs from AI and search.
- Preserve idempotency keys across uncertain responses.
- Treat ownership/nonexistence identically and derive personal analytics only from authentication.
- Consume credit at the final Discord-attempt boundary; never refund or automatically repeat an
  ambiguous attempt.
