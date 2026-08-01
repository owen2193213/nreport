# Discord DSA Backend Design

## Understanding summary

- Build a small internal API around the existing typed Discord DSA client.
- Accept country, report flow, category, context, and flow-specific target fields.
- Optionally accept the submitting Discord user's snowflake as internal ownership metadata.
- Generate organization-controlled country-localized pseudonyms and unique catch-all addresses; callers cannot supply a legal name.
- Preserve one country-matched sticky proxy session across the entire report lifecycle.
- Receive Discord verification emails through a Cloudflare Email Worker and correlate them by the SMTP envelope recipient.
- Persist state in Railway PostgreSQL and return both the internal report ID and Discord report ID when available.
- Target authorized, low-to-moderate-volume reporting; a public dashboard and outbound email are non-goals for v1.

## Assumptions

- The API and PostgreSQL run in Railway EU West (Amsterdam) as one Node.js service plus one database.
- Cloudflare Email Routing owns the whole-domain catch-all and invokes one Email Worker.
- V1 supports all 27 EU member states. Localized Faker data is used where a suitable locale exists; Bulgaria, Estonia, Lithuania, and Malta deliberately use Faker's generic English name generator because Faker does not provide suitable country locales.
- Expected scale is tens of concurrent reports, not thousands per second.
- Reports may wait several minutes for email, and process restarts must not lose them.
- The organization controls the pseudonyms and catch-all domain and is authorized to submit the reports in scope.
- Raw emails, verification codes, tokens, cookies, proxy credentials, and complete submission payloads are never logged.

## Selected approach

Use one Fastify application with a PostgreSQL-backed job table and an in-process worker loop. This avoids Redis, a second worker deployment, and a separate queue service while retaining durable jobs and atomic state transitions. A Cloudflare Email Worker authenticates inbound delivery to the API using an HMAC signature.

Alternatives considered:

- `pg-boss`: capable, but adds an abstraction and schema lifecycle that v1 does not need.
- Redis/BullMQ: adds another paid service and operational dependency.
- One long-running process per report: makes restart recovery and concurrent email waits fragile.

## Components

- Fastify HTTP API: health, create-report, get-report, and Cloudflare inbound-email endpoints.
- PostgreSQL: reports, jobs, report events, and inbound-message deduplication.
- Job runner: requests an email code, verifies a received code, and submits the report.
- Country profiles: one versioned mapping controls pseudonym source, locale,
  `Accept-Language`, primary timezone, and proxy country for every EU member state.
  Discord's form payload language is the fixed supported value `en`.
- Pseudonym generator: locked localized Faker data where supported and Faker's generic
  English generator for uncovered countries. Unicode names are preserved in the report;
  only internal IDs and email local-parts are transliterated to readable ASCII.
- Proxy session builder: creates a unique sticky-session identifier and reuses it for all steps.
- Cloudflare Email Worker: receives catch-all messages and posts the raw RFC822 message plus signed envelope metadata to Railway.

## State flow

`queued -> requesting_verification -> awaiting_verification -> verifying -> submitting -> submitted`

Failures store a stable error code and redacted message. Retryable pre-submission operations use bounded backoff. Final submission is never automatically retried after an ambiguous network outcome.

Failed reports may be retried manually under the same internal report ID only when the
failure is confirmed to have happened before final submission. A lifecycle retry preserves
the pseudonym and ownership, increments a bounded attempt counter, and rotates both the
catch-all email alias and sticky proxy session. Rotating the email prevents a delayed code
from an older attempt from being accepted by the new lifecycle. Submission-time network
failures and restart ambiguity are never retryable.

After `submitted`, Discord may send lifecycle email updates. These are stored in a
separate `discord_status` field so they do not overwrite the API submission state:

- `received`: Discord acknowledged the report.
- `actioned`: Discord took action on the reported content.
- `closed_no_action`: Discord closed the original report without action.
- `review_not_approved`: Discord closed a subsequent review request without action.

Lifecycle updates are correlated using both the Discord report ID and the generated
envelope recipient. When an original `closed_no_action` email contains Discord's review link,
the API encrypts that opaque link and queues one durable `submit_review` job. The worker resolves
only Discord's trusted tracking host to `https://discord.com/report-review#token=...`, extracts
the fragment token, and submits `{ token }` to Discord's review endpoint through a fresh proxy
session in the report's selected country. It does not require the original report IP or Discord
session to remain valid. The token and link are never returned to the bot or written to logs.

Review progress is stored separately from `discord_status` as `queued`, `requested`, `received`,
`confirmation_timeout`, `request_failed`, `request_ambiguous`, `approved`, or `not_approved`.
A successful review POST is authoritative. The API waits up to 120 seconds for Discord's
review-confirmation
email, but a missing confirmation changes only the diagnostic review status and never causes a
second appeal submission. A transport failure after the review POST begins is ambiguous and is
also never automatically retried.

## Security and reliability

- Require an API key and `Idempotency-Key` on report creation.
- Verify Cloudflare webhook HMAC signatures and reject stale timestamps.
- Deduplicate inbound messages by provider message ID.
- Match verification messages by the exact SMTP envelope recipient, not the visible `To` header.
- Encrypt persisted Discord session state with AES-256-GCM.
- Use parameterized SQL and structured redacted logging.
- Use database uniqueness constraints for internal IDs, generated emails, and idempotency keys.
- Store submitter Discord IDs only in the authenticated backend; never include them in the
  external Discord report payload. Index the nullable ID and expose a bounded authenticated
  lookup of the latest 100 reports for a user.

## Decision log

- TypeScript/Fastify selected to reuse the existing client and share types.
- One Railway service selected to minimize operational complexity.
- PostgreSQL job table selected over Redis or another queue service.
- Cloudflare Email Routing selected because inbound routing is already available for the domain.
- Locked localized Faker datasets selected over manually maintaining names. Faker's
  generic English instance is the explicit fallback for countries without a suitable
  built-in locale; runtime downloading or scraping is forbidden.
- `@sindresorhus/transliterate` selected for deterministic Unicode-to-ASCII email and ID
  generation instead of maintaining incomplete Greek, Cyrillic, and diacritic mappings.
- One country profile controls proxy country, Discord locale, `Accept-Language`, and
  timezone. Belgium selects either its Dutch or French profile once per report. The
  Discord form payload uses the supported fixed value `en`; regional timezone exceptions
  are deferred until the API accepts a subregion.
- Email code query parameter `b` is generated locally from the exact generated email using
  Discord's observed unsigned DJB2-style hash and base-36 encoding; it is not a server token.
- Exact-recipient correlation selected so reports can wait for verification concurrently.
- Manual lifecycle retries are limited to three total attempts and require an idempotency
  key plus the original submitter Discord ID. The current report row holds active state and
  `report_events` remains the audit history; a separate attempts model is deferred.
- Runtime menu resolution and sticky proxy continuity remain mandatory.
- Discord lifecycle resolution is stored separately from submission status; overwriting
  `submitted` would make API delivery state and Discord's later decision ambiguous.
- Review submission is API-owned and automatic for eligible original no-action decisions.
  The bot never handles a review token, Discord user authorization, or the external POST.
- Review-link resolution failures may use bounded job retry because no appeal has been submitted.
  An ambiguous review POST is terminal for automation to prevent duplicate external actions.
- Report ownership is stored with the report instead of in a second bot database, avoiding
  cross-database drift. The field remains optional for compatibility, while bot callers are
  expected to always provide it. A users table and pagination are deferred until needed.
- Command-line status checks use the existing authenticated single-report endpoint. A
  one-shot dependency-free Python client was selected over polling or another API route;
  callers decide their own refresh interval.
- The Railway HTTP API is the canonical Discord bot boundary. Bot callers supply the
  authenticated interaction user's snowflake as ownership metadata and use interaction
  IDs as idempotency keys; they do not import the low-level Discord client or duplicate
  report state in a second database.
