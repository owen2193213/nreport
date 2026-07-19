# Discord DSA API Client

Typed Node.js client for the authorized Discord DSA profile, message, and server report workflows captured in `DISCORD_DSA_API_HANDOFF.md`.

## Install and validate

```powershell
npm.cmd install
npm.cmd run lint
npm.cmd run typecheck
npm.cmd test
npm.cmd run build
```

## Usage

Create one client instance per pending report so the proxy identity and cookies stay consistent:

```ts
import { DiscordDsaClient } from "discord-dsa-api-client";

const client = new DiscordDsaClient({
  codeQueryB: "js30bq",
  proxyUrl: process.env.DSA_PROXY_URL,
  locale: "en-US",
  timezone: "Europe/Berlin"
});

const flow = "message_urf";
const email = "reporter@example.com";

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
