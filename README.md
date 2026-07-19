# Discord DSA Reporting Service

Typed Node.js client and Railway backend for the authorized Discord DSA profile, message, and server report workflows captured in `DISCORD_DSA_API_HANDOFF.md`.

## Hosted architecture

- Railway Fastify service: authenticated report API, email webhook, and durable job runner.
- Railway PostgreSQL: reports, idempotency, status events, encrypted session state, and jobs.
- Cloudflare Email Routing: whole-domain catch-all delivered to `dsa-inbound-email`.
- IPOasis: one country-specific sticky residential proxy session per report.

The current reviewed pseudonym catalog supports Germany (`DE`). Add another explicit catalog before accepting another country; the service never falls back to an unrelated locale.

## Railway setup

Connect the repository to the Railway service and add a PostgreSQL service in the same EU West environment. Configure these variables on the application service:

```text
NODE_ENV=production
DATABASE_URL=${{Postgres.DATABASE_URL}}
API_KEY=<at least 32 random characters>
SESSION_ENCRYPTION_KEY=<Base64-encoded 32-byte key>
CLOUDFLARE_EMAIL_WEBHOOK_SECRET=<at least 32 random characters>
REPORT_EMAIL_DOMAIN=<the Cloudflare Email Routing domain>
DSA_PROXY_URL_TEMPLATE=<sticky proxy URL containing {country} and {session}>
WORKER_ENABLED=true
```

Generate independent secrets locally; never paste them into source files:

```powershell
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
```

Use the Base64 result only for `SESSION_ENCRYPTION_KEY`. Generate separate hexadecimal values for `API_KEY` and `CLOUDFLARE_EMAIL_WEBHOOK_SECRET`.

`railway.json` supplies the build command, start command, `/healthz` health check, and restart policy. The database schema is created idempotently during service startup.

## Cloudflare Email Worker

The source to paste or deploy is in `cloudflare-email-worker/src/index.ts`. Configure:

```text
INGEST_URL=https://discord-dsa-production.up.railway.app/webhooks/cloudflare-email
INGEST_SHARED_SECRET=<same value as CLOUDFLARE_EMAIL_WEBHOOK_SECRET>
```

Store `INGEST_SHARED_SECRET` as an encrypted Worker secret. Route the domain catch-all to the `dsa-inbound-email` Worker. The Worker rejects addresses that do not match the generated-address format, signs the raw message, and sends it to Railway without forwarding it to a personal inbox.

## API

Create reports with a unique `Idempotency-Key` and the API bearer token. Reporter names and email addresses are deliberately not accepted.

```http
POST /v1/reports
Authorization: Bearer <API_KEY>
Idempotency-Key: bot-job-018f6f04
Content-Type: application/json
```

```json
{
  "country": "DE",
  "flow": "message_urf",
  "reportType": "sub_other_cybercrime",
  "messageUrl": "https://discord.com/channels/1273300509318578227/1526327580456779797/1527300404998832138",
  "context": "The message distributes malware."
}
```

The response is `202 Accepted` for a new report and includes its internal ID, generated pseudonym/address, status, and nullable Discord report ID. Retrieve its current state with:

```http
GET /v1/reports/<internal-report-id>
Authorization: Bearer <API_KEY>
```

Supported flow-specific fields:

- `message_urf`: `messageUrl`
- `user_urf`: `reportedUsername`, `profileElements`, optional `reportedUserServerId`
- `guild_urf`: `guildIdOrInviteCode`, `guildElements`

Final submissions are never automatically retried after an ambiguous network result. Such a report transitions to `failed` for manual review.

## Install and validate

```powershell
npm.cmd install
npm.cmd run lint
npm.cmd run typecheck
npm.cmd test
npm.cmd run build
npm.cmd audit --audit-level=high
```

## Usage

Create one client instance per pending report so the proxy identity and cookies stay consistent:

```ts
import { DiscordDsaClient } from "discord-dsa-api-client";

const flow = "message_urf";
const email = "reporter@example.com";

const client = new DiscordDsaClient({
  proxyUrl: process.env.DSA_PROXY_URL,
  locale: "en-US",
  timezone: "Europe/Berlin"
});

await client.sendEmailCode(flow, email);
const token = await client.verifyEmailCode(flow, email, userSuppliedCode);
const menu = await client.getMenu(flow);

const payload = client.prepareSubmission(
  menu,
  {
    flow,
    reporter: {
      country: "DE",
      legalName: "Example Reporter",
      username: "example"
    },
    messageUrl:
      "https://discord.com/channels/1273300509318578227/1526327580456779797/1527300404998832138",
    reportType: "sub_other_cybercrime",
    context: "Report context supplied by the reporter."
  },
  token
);

// Present `payload` as a redacted summary and require explicit confirmation.
const result = await client.submitPrepared(payload);
await client.close();
```

Do not log `token`, cookies, proxy credentials, verification codes, or unredacted payloads.

The client automatically requests a fresh fingerprint from Discord's unauthenticated experiments endpoint through the same proxy and reuses it for the report lifecycle. A known fingerprint may be supplied explicitly through the `fingerprint` constructor option for controlled testing.

When sending an email code, the client automatically derives Discord's `b`
query value from the exact email string using the unsigned 32-bit DJB2-style
algorithm used by Discord's web client and encodes the result in base 36. The
calculation is case- and whitespace-sensitive. For example,
`projectnebulon@gmail.com` produces `js30bq`.

## Proxy behavior

Pass an HTTP(S) proxy URL through `proxyUrl`. The same client instance uses the same `ProxyAgent` and cookie jar for menu, code, verification, and submission calls. If the provider rotates exits, embed its sticky-session identifier in the proxy credentials.

For the configured IPOasis dynamic residential plan, use the documented sticky username parameters and European gateway:

```text
http://user-{SUBUSER}-region-DE-sess-{RANDOM_NUMERIC_ID}-sessTime-120:{PASSWORD}@gate-eu.ipoasis.com:8668
```

Generate one random numeric `sess` value for each new report, then reuse the same URL/client instance for that entire report. See `IPOASIS_PROXY_NOTES.md` for the source-backed details. Never commit the completed URL.

## Header test

The header experiment performs only read-only menu GETs:

```powershell
npm.cmd run test:headers
```

To exercise the real client bootstrap and menu path without sending email or submitting a report:

```powershell
$env:DSA_PROXY_URL = "http://..."
npm.cmd run test:client-readonly
```

With a proxy:

```powershell
$env:DSA_PROXY_URL = "http://username:password@host:port"
npm.cmd run test:headers
```

Success on menu GET does not prove that the same header set is sufficient for code, verification, or submission POSTs. Those must be tested in a controlled report lifecycle.

Optional `DSA_FINGERPRINT`, `DSA_INSTALLATION_ID`, and `DSA_SUPER_PROPERTIES` environment variables enable full-versus-ablated session-header comparisons. The script reports only whether they were supplied and never prints their values.

Use `DSA_TEST_FLOW` and comma-separated `DSA_TEST_PROFILES` to run a smaller diagnostic subset when proxy routes are slow.
