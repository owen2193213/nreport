# Regression audit — 2026-09-09

Scope: all 29 existing test files at live main `1d79fef`, plus two new files. This is a test-only review and proposed operational work, not a production fix or deployment. No live Discord reports were submitted. SQL mocks are not database integration tests; payload strings are not visual readability tests.

## Incident evidence and confidence

- September 8, 21:52:07 China time: planning ended incomplete after 87.189 seconds (`finish_reason: length`), followed by generic preparation failure. A real writer → preparer → worker test reproduces loss of this error kind.
- September 8, 21:53:05: another generic preparation failure after nearby planning repair. Validation details are absent; the exact cause cannot be established.
- September 8, 21:56:37 and 21:59:43: preparation timeouts.
- September 9, 03:42:56 China time (September 8, 19:42:56 UTC): another generic worker failure. Nearby planning/synthesis requests completed in 9.003/3.942 seconds. Missing cross-layer correlation prevents attributing those requests to this failure.
- The current-deployment search from September 8, 14:15 UTC returned ten completed AI-request records, no `ai_request_failed` records, and one generic preparation-worker failure. This is not proof of fleet-wide health or absence of failures outside the retrieved window.

Code findings: the writer replaces typed provider/search errors with a wrapper that loses their kind. The worker then creates a fresh diagnostic error, losing stage and cause. Preparation only checks its abort signal before and after the writer; a stalled writer retains its worker slot. The lifecycle loop processes jobs serially, including an appeal delay, and performs maintenance between jobs. Queue length includes distinct reports with pending/running jobs, including appeals; it is not waiting position or expected wait time. Restart recovery is age-gated. Bot reconciliation runs at 15-minute intervals and cannot guarantee fresh queue counts when no report event occurs. These are plausible delay mechanisms, not measured attribution of every user's delay. Production preparation concurrency is configured but its value was not available through the connector.

## Existing-file review

Paths below are repository-relative. “Keep” means useful unit coverage, not complete coverage.

| Test file | Assessment and action |
| --- | --- |
| api/accounts | Keep auth/credit/config checks; SQL mocks cannot establish atomic reservations or rate-limit races. |
| api/ai-client | Removed duplicate endpoint getter test; retain HTTP retry, deadline and error classification tests. |
| api/analytics | Keep pure aggregation/privacy coverage; strengthen exact UTC bucket boundaries and empty intervals later. |
| api/api-report-preparer | Keep mapping/usage/rewrite tests; new pipeline file reproduces cancellation defect. |
| api/brave-research | Keep mocked HTTP privacy/retry/budget coverage; add abort propagation and logger allowlist tests. |
| api/event-delivery-v2 | Keep signatures/minimal envelope/409 retry; add 429, timeouts and poison-item isolation. |
| api/inbound-email-repository | Keep SQL parameter wiring; add actual duplicate/concurrent mail transactions. |
| api/lifecycle-runner-v2 | Keep submission-boundary and appeal tests; add serial starvation, maintenance deadlines and no-resubmission crash matrix. |
| api/preparation-worker | Added bounded concurrency and failed-slot release test. Existing fake typed error tests only prove worker mapping, not preservation through the writer. |
| api/report-recovery | Renamed tests to accurately describe SQL/schema assertions, not proven serialization/recovery. |
| api/report-repository | Keep ownership/idempotency/query mapping units; require real PostgreSQL rollback/locking tests. |
| api/report-validation | Keep actual input parsing and invalid-field cases; add API route rejection before repository calls. |
| api/report-writer | Removed prompt-heading/example wording assertions; retain routing/budgets/schema/output behavior. Fixed a vacuous privacy test by actually supplying the unwanted referenced content, with a positive control for retained target evidence. Added bounded follow-up call count. |
| api/server-v2 | Strengthened queue response test to require nonzero repository value (7), not fallback zero. Add request-shape and rate-window boundary integration cases. |
| api/webhook-destinations | Keep URL restrictions and encrypted-storage tests; add authenticated decrypt round-trip and update ownership coverage. |
| bot/account-overhaul | Renamed SQL mock tests that overclaimed multiworker exclusion/coalescing; retain reconciliation/idempotency wiring. |
| bot/message-resolver | Keep captured/unavailable/voice/referenced-context cases. |
| bot/presence | Keep small explicit online-presence product invariant; does not test gateway health. |
| bot/report-ui | Relabelled as payload/product contracts, not readability. Retry tests now check authorized modes and report-bound button IDs; compare submitted/accepted colors rather than a magic integer; verify hash changes for queue/failure updates. Retain user-requested message/link/history/status contracts. |
| bot/server-resolver | Keep happy path; add inaccessible/partial data fallbacks. |
| email-worker/index | Keep sender trust/raw forwarding tests; add real signature validation across API boundary, replay and recipient rejection. |
| client/client | Keep mocked transport/session/fingerprint/review behavior; not a live transport test. |
| client/menu | Keep captured-tree traversal and semantic selection. |
| client/payload | Keep actual validated payload/fixture coverage. |
| client/transport | Keep error sanitization units; add controlled local HTTP timeout/cookie/proxy behavior, not live reports. |
| contracts/account-api | Keep URL/header/idempotency/response privacy tests. |
| contracts/analytics | Keep API query/catalog compatibility coverage. |
| contracts/contracts | Replaced exact category counts with nonempty/Discord-select maximum constraints. |
| contracts/diagnostics | Keep redaction helper tests; insufficient because callers can bypass helpers with raw response logging. |

## New files and explicit limitations

- `apps/bot/test/account-notifier.test.ts`: original-card edit/reply ordering, safe failure text, unchanged-card handling, rejected edit/reply retries, concurrent card-claim refusal, empty outbox. These exercise the real notification worker with mocked API/Discord/database boundaries.
- `apps/api/test/preparation-pipeline.test.ts`: two `it.fails` reproductions for the desired behavior: preserve `preparation_incomplete` through real provider wrappers, and cancel an in-flight writer promptly. Expected failures intentionally remain visible. Remove `.fails` when implementing each fix; verify the original mismatch first. A green suite containing these is NOT a healthy production pipeline.
- Worker concurrency test proves the in-process worker limit and slot release only, not SQL claim uniqueness across instances.
- No automated string assertion establishes legibility, desktop/mobile layout, screen-reader quality or actual Discord component acceptance. Keep explicit product-format tests, and use a controlled Discord smoke review for rendering.

## Next tests, prioritized

1. P0: fix the two known-defect reproductions, then run them as ordinary passing tests. Add exhausted 429, provider 5xx, malformed output, invalid-country/category, refused/overlong output, database transition/commit failure, and search failures through the full preparation stack. Assert safe stage/code and no raw upstream content.
2. P0: disposable PostgreSQL with two independent clients: SKIP LOCKED claim uniqueness; atomic credit/idempotency rollback; stale-lock recovery; lease fencing against late old-worker writes; event order; duplicate email; retry lineage. Do not run destructive integration setup against production.
3. P0: ambiguous Discord final submission crash matrix (before request, request sent, response lost, response persisted). Assert no automatic duplicate final submission and explicit recoverable operator state.
4. P1: saturation test with preparation, manual and appeal jobs together. Fake slow providers, deadlines and DB outages; measure queue wait and verify other eligible work and maintenance progress. Check restart recovery and graceful shutdown with stalled tasks.
5. P1: API → durable event outbox → bot inbox → card update integration: missed webhook reconciliation, duplicates/out-of-order terminal events, failed edit, deleted card, concurrent creation, crash after reply before acknowledgement. Current delivery can duplicate a reply in that crash window; specify/deduplicate deliberately.
6. P1: API limits tested independently (create limit versus AI/account budget versus read limits), account isolation, window reset/Retry-After, queue endpoint values including delayed/running/appeal jobs, and stale bot display refresh.
7. P1: logging schema allowlist against real logger call sites, trace propagation, bounded cardinality, logger failures, committed-transition semantics, and secret/evidence canaries.

See `OBSERVABILITY_PLAN.md` for the proposed implementation sequence. Production behavior has not been changed by this audit.

## Verification result

At completion: lint, all-workspace typecheck and build passed. Full suite: 31 files, 233 passing tests and two explicitly expected failures. Both known-defect tests were temporarily run as normal tests and failed at their intended assertions: `preparation_failed` instead of `preparation_incomplete`, and `still-running` instead of `aborted`. Expected-failure markers were restored and the full suite rerun. No production fix is implied.

The network-enabled high-severity audit failed with four dependency findings: one high and three moderate, involving nodemailer/mailparser and Vitest/@vitest/mocker. Dependencies were not changed during this test-only review. Dependency remediation and lockfile verification are required before claiming all release gates pass.
