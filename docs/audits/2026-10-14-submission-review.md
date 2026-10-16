# Submission and confirmation review

Reviewed the API report lifecycle, durable jobs and credit boundary, inbound email correlation,
bot status cards and event delivery, and the low-level guild submission/session path. The review
used synthetic regressions; it did not submit a new Discord
report or resend an uncertain submission.

## Reproduced defects

| Defect | Resulting behavior | Correction |
| --- | --- | --- |
| A valid terminal retry was advertised but rejected for 30 seconds using `updated_at`. | Clicking an eligible retry could return `retry_cooldown`. | Removed that additional cooldown while retaining serial successors, credit accounting, idempotency and account rate limits. |
| A queued email batch reused one stale post-submission report row. | A delayed receipt could overwrite an earlier action decision. | Reload the locked current report before each email application so status precedence remains monotonic. |
| The runner ignored ownership checks returned by persistence methods. | It could report success or waiting for mail even though its database transition was rejected. | Return `ownership_lost` when the durable transition fails; never repeat an uncertain final POST. |
| Session cookies were exported before fingerprint bootstrap completed. | Cookies set by the fingerprint response could be missing from resumable state. | Bootstrap first, then export cookies. This edge case does not explain server-only failures in the normal already-bootstrapped lifecycle. |

## Confirmation semantics

The code-verification email and the later report-confirmation email have different meanings.
`verification_received` remains verification progress. `report_submitted` now displays
**Awaiting confirmation**. The authenticated report receipt sets `discordStatus=received`, emits
`discord:received`, displays **Confirmation received**, and adds its timestamp to history. These
events bypass notification coalescing and edit spacing while keeping per-report serialization.
Neither the transport response nor a receipt means Discord took enforcement action.

## Server-report investigation

The offline guild payload matches the documented successful `guild_urf` request in
`DISCORD_DSA_API_HANDOFF.md`, including its breadcrumb path and selected elements. The client
regression also proves that a network failure from the final guild POST is attempted once.
These are contract checks, not proof that a particular live server report was accepted.

The administrator diagnostics endpoint accepts a UUID to inspect bounded lifecycle/job metadata,
mail-correlation groups, and delivery counts. It uses the existing administrator authentication
and returns no mail, reporter alias, report contents, job payloads, credentials, or detailed SQL
diagnostic ledger. It can distinguish no recorded receipt from a stored receipt whose external ID
does not match the submission ID.

The old Discord operations-warning webhook remains retired. Its failure threshold previously
reset on a five-minute counter window, which could produce closely spaced alert/recovery pairs.

## Verification

Root lint, workspace typecheck, build and high-severity dependency audit passed. The complete test
run passed 466 tests; four PostgreSQL integration tests were skipped without `TEST_DATABASE_URL`.
This review fixes the reproduced defects above; it is not a guarantee that every possible failure
in the report workflow has been eliminated.
