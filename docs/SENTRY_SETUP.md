# NReport Sentry operations

The API and bot report to separate Node.js projects in the `civility` Sentry organization:

- [nreport-api](https://civility.sentry.io/issues/?project=4512255810076672)
- [nreport-bot](https://civility.sentry.io/issues/?project=4512255810273280)

Keep each project's DSN in the matching service's Railway variables or local environment. Never
commit real environment values. The Cloudflare email worker does not load the Node.js SDK; its
existing signed diagnostic forwarding remains the email-worker boundary.

## Configuration

Use the Sentry settings in `apps/api/.env.example` and `apps/bot/.env.example`. Initialization is
loaded before application imports so SDK instrumentation can observe startup failures and HTTP
and database operations. An unset DSN disables external telemetry while local diagnostics continue.
Use distinct project DSNs for the two services, `production` for the deployed environment, and the
deployment commit for release identification. For a CLI source upload, set `SENTRY_RELEASE` to a
version derived from the uploaded source instead of attributing local changes to an older commit.

The Railway build definitions build the shared observability workspace before each application.
Its source files are watch paths for both services. Use the npm start scripts so the telemetry
preload and Node.js source-map support are applied consistently.

## Investigating a failed report

1. Select the API project and search with `report_id:<report UUID>` or
   `report_trace_id:<report trace UUID>`. The report trace is an application correlation ID,
   distinct from Sentry's distributed trace ID.
2. Inspect the workflow stage, job kind, attempt, error category, HTTP status, and exception cause.
   AI provider rejections include bounded, redacted provider error details so a `402` is actionable.
3. For notification or interaction failures, select the bot project and use the same report/trace
   references where available. An API failure and a Discord DM delivery failure are separate events.
4. Consult Railway logs and the existing 30-day SQL diagnostic ledger for surrounding workflow
   history. Routine progress and notification lock contention should not generate Sentry issues.
5. Preserve the original idempotency key and check the report's stored status before any recovery.
   An ambiguous final Discord submission must never be automatically resubmitted.

Credentials, cookies, verification codes, raw RFC822 mail, request bodies, and secret URL components
must not be sent to Sentry. Error messages, causes, stack traces, and structured diagnostic fields
are scrubbed before transmission. The testing diagnostic policy still requires review before public
deployment; Sentry is an additional external diagnostic destination.

## Initial investigation: 2026-10-14

Read-only Railway inspection of the NReport services in `alluring-cooperation` found:

- Repeated Cerebras AI planning requests rejected with HTTP `402`, including the most recent
  observed failure at 10:21 a.m. America/Los_Angeles on October 14. The old log contains only a
  response size of 153 bytes, not the provider's explanation. A billing or entitlement problem is
  a hypothesis until the provider's error details are available.
- API native heap exhaustion on October 12 and 13, with V8 reporting approximately 472 MB used
  near its heap limit. Investigation found idle lifecycle waits attaching callbacks to a stop
  Promise that remained pending for the entire process lifetime. Repeated polling retained those
  callbacks. The runner now removes each interrupt listener when its wait settles; the regression
  checks that 100 timed-out waits retain zero listeners. Runtime memory samples support checking
  the deployed memory trend; a short regression does not prove every source of growth is gone.
  A native out-of-memory abort
  may terminate the process before the JavaScript SDK can send an event; retain Railway crash logs.
- Bot uncaught `TypeError` on October 12 at approximately 11:25 p.m. America/Los_Angeles, inside
  Discord.js `Poll.js:21` while building a message context-menu interaction. It occurs before the
  application's interaction handler; SDK process-level exception handling is needed to capture it.

The Discord.js null-channel case is covered by a regression using the actual SDK constructor and
a narrow installation patch, pinned to the affected SDK version. See upstream
[issue 11645](https://github.com/discordjs/discord.js/issues/11645) and
[proposed fix 11646](https://github.com/discordjs/discord.js/pull/11646).

Minimal generic AI probes returned one `402`, followed by two successful `200` responses. This
does not establish a persistent outage or repair provider billing. Cerebras documents `402` for
Team organizations without an active subscription or credit balance, and advises checking that
the API key belongs to the intended organization after adding credits. See its
[PayGo billing FAQ](https://support.cerebras.net/articles/5041581099-cerebras-self-serve-paygo-faq).
The application classifies this separately as payment required, retains bounded redacted provider
details for operators, and does not retry a payment rejection automatically. The operator must
check the provider's account and key if it recurs; report credits in NReport are separate.

The redundant Discord operations-warning webhook is retired. The API continues collecting worker
health and current alert state for administrator diagnostics, without enqueueing warning-webhook
deliveries. The signed private report lifecycle webhook is retained for prompt status-card updates.

## Verification and rollout

Run the repository's required lint, workspace typecheck, tests, build, and high-severity audit.
Do not use the live Discord transport diagnostic scripts as verification.

For end-to-end verification, run each application's normal start script with its Sentry DSN and
a dedicated verification environment, deliberately omitting a required configuration value.
The actual startup validation must fail before any database connection or Discord operation.
Find the resulting startup issue in the matching Sentry project and inspect its source frames.
Transport acceptance alone is not proof that Sentry stored an event.

Verified on October 14, 2026, through both normal npm start scripts in the
`verification-20261014` environment and `local-observability-20261014` release:

- [NREPORT-API-1](https://civility.sentry.io/issues/NREPORT-API-1):
  `Error: NREPORT_ADMIN_KEY is required.` Sentry retains the TypeScript function names and
  line/column references through `main`, `loadConfig`, `secret`, and `required`.
- [NREPORT-BOT-1](https://civility.sentry.io/issues/NREPORT-BOT-1):
  `Error: DISCORD_ADMIN_USER_IDS is required.` Sentry retains the TypeScript frames through
  `main`, `loadBotConfig`, and `required`.

Both events were read back through the connected Sentry tools. They are intentional local
verification failures, not production incidents. Their frames omit source snippets and local
variables by design; source maps preserve the original TypeScript locations.

Final local checks passed: root lint, workspace typecheck, root build, and the high-severity
dependency audit (zero vulnerabilities). The complete test run passed 452 tests; four PostgreSQL
integration tests were skipped because `TEST_DATABASE_URL` was not configured. The Windows test
run used a temporary directory inside the workspace to avoid an `EPERM` error in the default
Vitest temporary cache; those temporary files were removed after validation.

Production rollout on October 14, 2026 applied matching Sentry variables and deployed the tested
source snapshot as release `nreport-20261014-da35334c6b87`:

- API deployment [`8e3abde0-eb3e-4733-a5b9-87d919a38168`](https://railway.com/project/c1581d42-1d4c-4250-a215-e2d3ee9170e4/service/1c2b2ea9-4a39-49b7-958e-674dc1c3f72f?id=8e3abde0-eb3e-4733-a5b9-87d919a38168)
  reached `SUCCESS`; its public health endpoint returned `200` with `status=ok`.
- Bot deployment [`66a02580-7cd3-4cef-a5b7-42e6682b949c`](https://railway.com/project/c1581d42-1d4c-4250-a215-e2d3ee9170e4/service/a3ae24fe-671d-4c7f-b0b2-46f913d97728?id=66a02580-7cd3-4cef-a5b7-42e6682b949c)
  reached `SUCCESS`; readiness requires its database and Discord gateway. Startup logs confirm
  Discord readiness and completed account reconciliation.

A read-only production `GET /openapi.json` was read back from Sentry with its HTTP server and
Fastify handler spans in
[trace dcdfa4e9d9e84853a8c50f8dd9100fd2](https://civility.sentry.io/explore/traces/trace/dcdfa4e9d9e84853a8c50f8dd9100fd2).
Health-check spans were observed as server-filtered traffic. This verifies deployed API telemetry;
bot error capture was verified through its real startup path in the separate verification
environment rather than causing a production crash.

The deployment archive included only application source, workspace manifests/configuration, and
the guarded JavaScript SDK patcher. It excluded real environment files, protected Python
diagnostics, local tooling, and unrelated working-tree changes. No real Discord report was
submitted as a deployment test. The two-minute external receipt deadline remains unchanged.
