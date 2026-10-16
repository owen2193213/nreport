# Event ordering and recovery review

Server-report transport/confirmation changes are on hold. This work concerns event publication,
API transaction ownership, and bot delivery-state recovery.

## Reproduced transaction failures

The event-feed risk from the September 12 audit was reproduced against a temporary PostgreSQL
18.4 database with synthetic reports. A lower-ID transaction paused before the existing event
advisory trigger; a higher-ID event committed and was visible first. A client advancing to that
higher ID could skip the delayed event. The new regression asserts the required ordering rather
than treating the buggy ordering as a passing result.

A separate controlled suspension/submission race produced PostgreSQL `40P01` (deadlock):
suspension held account/report locks while submission held a job lock and requested the account.
Atomic rollback protected the credit ledger, but did not make both requested operations finish.

## Design constraints

Event allocation must occur after the publication lock is held through transaction completion.
Parent account/report foreign-key locks must be acquired before that lock. Moving it to the
start of an entire statement alone is insufficient: it can invert the existing account/report
lock order. PostgreSQL documents trigger timing and row processing in its
[trigger overview](https://www.postgresql.org/docs/18/trigger-definition.html).

Report mutations use a consistent account, report/credit-chain, then job order. Maintenance must
not publish an event while retaining the global publication lock and then acquire another
report's locks; per-report transactions keep those boundaries short.

Delivery recovery must preserve committed terminal state when a database acknowledgment is
lost. A subsequent attempt to record failure must not turn a durably sent notification or digest
back into pending/failed work. Discord's finite nonce-deduplication window is supplementary
protection, not a proof of unlimited exactly-once message delivery.

## Follow-up outside this change

API webhook delivery completion/retry writes could also use claim-generation fencing to reduce
redundant redelivery after a lost database acknowledgment. Delivery is already at least once:
a lost HTTP acknowledgment can require the same event to be sent again. Stable event IDs and
idempotent bot ingestion remain the correctness boundary. This optimization is separate from
preventing duplicate user-facing digest messages.

## Verification boundaries

The implementation uses a fresh uncached event sequence and a `BEFORE INSERT` trigger that
allocates the ID only after parent foreign-key locks and the publication lock. Migration advances
beyond existing rows and legacy reserved cache blocks without renumbering historical events or
resetting client cursors. Existing skipped historical events require a separate reconciliation
decision; this migration prevents future commit-order gaps.

Real database regressions cover suspension winning and losing the submission race, credit
conservation, stale preparation ownership, partial recovery failure after an earlier commit,
lost completion acknowledgments, stale digest/notification claims, and retry-card transfer.
Subprocess regressions additionally verify scrubbed fatal logs with configured, absent, and
invalid Sentry DSNs. Review found the disabled-SDK path previously delegated to Node's raw fatal
logger; process handlers now own the sanitized exit path independently of SDK availability.

Tests use isolated temporary PostgreSQL schemas and controlled lock barriers. No production
database is used for reproduction, and no Discord report is submitted. The production API/bot
ownership boundary, stable signed event shape, and prohibition on automatically retrying an
ambiguous final Discord submission remain requirements.

Local lint, all workspace typechecks, build, and the high-severity audit passed (zero dependency
vulnerabilities). The full coverage run passed 512 tests and hit the default five-second timeout
in three existing tests while other validation processes were running. Running those three files
sequentially with coverage and the same five-second timeout passed all 28 tests. A clean full CI
run with PostgreSQL is required before merge; the isolated run's coverage is not whole-suite coverage.
