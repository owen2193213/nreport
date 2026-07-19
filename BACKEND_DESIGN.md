# Discord DSA Backend Design

## Understanding summary

- Build a small internal API around the existing typed Discord DSA client.
- Accept country, report flow, category, context, and flow-specific target fields.
- Generate organization-controlled country-localized pseudonyms and unique catch-all addresses; callers cannot supply a legal name.
- Preserve one country-matched sticky proxy session across the entire report lifecycle.
- Receive Discord verification emails through a Cloudflare Email Worker and correlate them by the SMTP envelope recipient.
- Persist state in Railway PostgreSQL and return both the internal report ID and Discord report ID when available.
- Target authorized, low-to-moderate-volume reporting; a public dashboard and outbound email are non-goals for v1.

## Assumptions

- The API and PostgreSQL run in Railway EU West (Amsterdam) as one Node.js service plus one database.
- Cloudflare Email Routing owns the whole-domain catch-all and invokes one Email Worker.
- V1 ships with a reviewed German (`DE`) pseudonym catalog. More countries are added as explicit, reviewed catalog files; there is no silent locale fallback.
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
- Pseudonym catalog: separate given/family name lists per supported country.
- Proxy session builder: creates a unique sticky-session identifier and reuses it for all steps.
- Cloudflare Email Worker: receives catch-all messages and posts the raw RFC822 message plus signed envelope metadata to Railway.

## State flow

`queued -> requesting_verification -> awaiting_verification -> verifying -> submitting -> submitted`

Failures store a stable error code and redacted message. Retryable pre-submission operations use bounded backoff. Final submission is never automatically retried after an ambiguous network outcome.

## Security and reliability

- Require an API key and `Idempotency-Key` on report creation.
- Verify Cloudflare webhook HMAC signatures and reject stale timestamps.
- Deduplicate inbound messages by provider message ID.
- Match verification messages by the exact SMTP envelope recipient, not the visible `To` header.
- Encrypt persisted Discord session state with AES-256-GCM.
- Use parameterized SQL and structured redacted logging.
- Use database uniqueness constraints for internal IDs, generated emails, and idempotency keys.

## Decision log

- TypeScript/Fastify selected to reuse the existing client and share types.
- One Railway service selected to minimize operational complexity.
- PostgreSQL job table selected over Redis or another queue service.
- Cloudflare Email Routing selected because inbound routing is already available for the domain.
- Versioned reviewed pseudonym lists selected over unbounded generated identities.
- Exact-recipient correlation selected so reports can wait for verification concurrently.
- Runtime menu resolution and sticky proxy continuity remain mandatory.

