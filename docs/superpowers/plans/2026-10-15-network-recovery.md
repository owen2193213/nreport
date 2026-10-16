# Bounded network recovery implementation plan

**Goal:** Recover automatically from transient pre-submission connection failures without duplicate submissions, duplicate credit consumption, or duplicate status cards.

**Spec:** The user-approved retry policy in this chat: three safe attempts, at most one fresh-session restart, prepared-content reuse, durable scheduling, immediate progress cards, and no retry after an ambiguous final submission.

**Architecture:** The API owns retry scheduling and an atomic serial successor with a fresh identity/session. Shared contracts expose bounded progress metadata; the bot follows only an explicitly marked automatic successor and transfers the existing private card. Server-specific payload and confirmation work remains on hold.

## Constraints

- Preserve account → report → credit chain → job lock order and the existing signed event boundaries.
- Never automatically repeat final report/appeal submission or resend a submitted report because its receipt is missing.
- Retain a reserved/consumed chain atomically across automatic recovery; consume its entitlement only at the normal final-submission boundary.
- A manual operation gets one automatic-restart budget; its automatic successor inherits the used budget. A new manual retry resets it.
- Retry transient network/service failures with bounded backoff and jitter; honor `Retry-After`. Permanent credential, certificate, validation, and configuration failures stop.
- Do not wait automatically beyond five minutes: a longer `Retry-After` stops recovery and releases a reserved entitlement; never clamp it into an earlier retry or rotate sessions to bypass it.
- Do not silently rotate the proxy/cookie/fingerprint state within an existing lifecycle. Every fresh restart has a new report ID, identity, and session.
- Preserve unrelated README/local-tooling changes and protected Python diagnostics. Do not submit live Discord reports for validation.

## Tasks

- [x] API: reproduce and implement transient classification, durable retry progress, atomic one-time successor creation, ownership/credit gates, and clearing stale progress.
- [x] Bot: implement immediate recovery views and idempotent account-scoped card adoption for either event order, including repair/reconnect paths.
- [x] Contracts/docs: publish optional recovery metadata and document progress events, retry budget, credit behavior, and submission ambiguity.
- [x] Review combined behavior; run meaningful regressions and root lint/typecheck/tests/build/audit.

**Local validation:** 566 tests across 53 files passed, including isolated PostgreSQL regressions.
Lint, all-workspace typecheck, build, and the dependency audit passed (zero vulnerabilities).
Coverage: 71.38% lines and 58.18% branches.

**Integration gates:** Require green PR CI, deploy the compatible bot before the API, merge the
reviewed commit, and verify both deployments, readiness, and telemetry. Record those outcomes in
the PR and deployment history. Do not submit live Discord reports as a deployment probe.
