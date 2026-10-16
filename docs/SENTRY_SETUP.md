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
Fatal exception and unhandled-rejection handlers always write scrubbed local diagnostics and exit
nonzero, including when the DSN is absent or SDK initialization fails. External capture is optional;
credential redaction on these process-failure paths is not.

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

The later submission review distinguishes verification mail from report confirmation. A
`report_submitted` response waits for confirmation; `discord:received` acknowledges the later
report-confirmation email. The review removed the inconsistent 30-second manual-retry cooldown,
fixed pending-email batches that could regress a decision when a delayed receipt arrived, and
made worker outcomes respect lost database job ownership. Session snapshots now export cookies
after fingerprint setup. Offline guild payload and single-attempt final-submission tests cover
the server-report contract; these checks alone do not establish why an individual receipt is missing.

For a missing confirmation, use the authenticated administrator health projection at
`/v1/admin/discord/dsa/diagnostics?reportId=<UUID>`. Check the stored external report ID and job
history, then compare inbound confirmation groups and their external IDs. The projection excludes
mail, report contents, credentials, and detailed diagnostic ledger data. A timeout cannot by itself
prove whether Discord received the report, whether mail was delayed, or whether an unsupported
mail template was ignored. Do not resend an uncertain final submission to diagnose it.

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

The confirmation/retry review was subsequently deployed as
`nreport-confirmation-20261014-16acbb1afb0d`. API deployment
`7c55ae4d-018c-424a-b8e7-b0ce4e4d6aa7` and bot deployment
`b2c06b4f-4621-4b0d-bfcd-474b036aa686` both reached `SUCCESS`; the API health endpoint returned
`status=ok`. See
[`audits/2026-10-14-submission-review.md`](audits/2026-10-14-submission-review.md) for the findings
and the limits of offline submission checks.

A final API-only diagnostics correction preserves `submitted` as a failure stage. Release
`nreport-confirmation-20261014-78525a306af3`, deployment
`dffcc3ba-f551-4706-9338-d9edc7dd5a2a`, reached `SUCCESS`; API health returned `status=ok` and the
read-only diagnostic projection returned the corrected stage. The bot remains on the confirmation
release above. Revalidation passed root lint, workspace typecheck, build, 466 tests (four database
integration tests skipped), and the high-severity audit with zero vulnerabilities.

The deployment archive included only application source, workspace manifests/configuration, and
the guarded JavaScript SDK patcher. It excluded real environment files, protected Python
diagnostics, local tooling, and unrelated working-tree changes. No real Discord report was
submitted as a deployment test. The two-minute external receipt deadline remains unchanged.

## Report outcomes and bot delivery health

Committed verification/receipt/appeal-confirmation timeouts and restart-detected ambiguous
submissions are captured even when maintenance completes normally. Each capture includes safe
report and trace correlation and a stable failure category. Expiry transitions emit only once;
capturing a failure does not retry a final Discord submission. A later trusted confirmation can
still recover the report through the normal lifecycle.

Bot backlog warnings require work older than five minutes in two consecutive one-minute
samples. Each episode produces one capture, rearmed after two healthy samples; there is no
paired Discord failure/recovery alert. These checks supplement exception capture, not an uptime
guarantee or evidence that every business outcome reached Sentry.

Run `npm.cmd run test:coverage` for source coverage (text, HTML, and LCOV under `coverage/`).
Set `TEST_DATABASE_URL` to include the isolated PostgreSQL concurrency and cross-service
integration tests; CI supplies that database. Coverage percentages measure exercised code,
not correctness of every race or Discord's downstream processing.
