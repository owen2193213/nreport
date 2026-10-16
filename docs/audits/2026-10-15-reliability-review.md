# Reliability and administration review

This review covers report creation/retry accounting, lifecycle maintenance, HTTP transport,
event cursors, bot notification recovery, and personal-key administration. It is not an
exhaustive security or load audit, and no live Discord report is submitted as a check.

## Reproduced corrections

- Report-list pagination used JavaScript millisecond timestamps against PostgreSQL microsecond
  ordering. A page boundary could skip reports created in the same millisecond. Cursors now
  preserve the database timestamp's full precision.
- Report cursors accepted invalid UUIDs and calendar dates, while numeric event/action-history
  cursors accepted values outside PostgreSQL's signed bigint range. Invalid input is rejected at
  the HTTP boundary instead of reaching a failing SQL cast.
- A response interrupted after HTTP headers escaped the transport's network-error wrapper.
  Safe work before submission could therefore fail without its normal network retry. Body-read
  failures now retain their cause in `DiscordDsaNetworkError`. The transport still performs one
  request; final submission ambiguity is never retried automatically.

## Remaining concurrency concern

The historical September 12 audit's event-publication concern remains relevant: the event
sequence is allocated before an `AFTER INSERT` trigger obtains the global advisory lock.
Sequence order is not itself a proof of transaction commit order. A real PostgreSQL reproduction
and a design accounting for foreign-key/account/report lock order are needed before changing
this mechanism. Moving the lock to a statement's start alone can introduce lock inversions.
The webhook remains a second delivery path, but does not establish correctness of the feed.

The subsequent [event-ordering and recovery review](2026-10-15-event-ordering-and-recovery.md)
reproduced this gap in PostgreSQL and implemented allocation under the publication lock, alongside
the required parent-lock ordering and per-report maintenance transactions. The paragraph above
records the concern before that follow-up; historical IDs and client cursors are preserved.

## Verification scope

Use the root lint, workspace typecheck, tests, build, and high-severity dependency audit. Database
integration tests require `TEST_DATABASE_URL` and create isolated temporary schemas; CI provides
PostgreSQL. Transport fault tests use a localhost-only HTTP server, never Discord.
Coverage reports measure exercised source lines and branches; they do not prove race freedom,
correct external mail delivery, or successful downstream handling of a server report.

The local coverage run passed 486 tests and skipped 10 database integration cases because no
local PostgreSQL was configured. It measured 68.80% lines, 55.38% branches, 65.71% statements,
and 68.86% functions across application/package source. Startup subprocess tests are outside
the parent process coverage collector, so an uncovered bootstrap line is not proof that its
startup test did not run. CI additionally exercises the PostgreSQL cases and reports its own
coverage summary. Root lint, all workspace typechecks, build, and the high-severity audit passed;
the audit reported zero vulnerabilities.

The first CI run with PostgreSQL passed all 496 tests across 51 files, including the ten database
cases. It measured 69.53% lines, 55.90% branches, 66.43% statements, and 70.31% functions.
Both the coverage summary and the required checks are recorded in
[CI run 38803024465](https://github.com/owen2193213/nreport/actions/runs/38803024465).
