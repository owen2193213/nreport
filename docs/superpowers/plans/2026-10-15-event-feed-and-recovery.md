# Event feed and recovery implementation plan

> **For agentic workers:** Use subagent-driven development for the independent API publication, API lock ordering, and bot recovery tasks, then integrate and review.

**Goal:** Prevent skipped feed events, verify suspension/submission atomicity, strengthen recovery tests, and merge the reviewed PR. Server-report flow changes are on hold.

**Architecture:** Preserve separate API/bot databases and stable signed event identifiers. Reproduce transaction ordering against isolated PostgreSQL schemas before changing event ID allocation or lock ordering. Keep notification retries idempotent.

**Tech stack:** TypeScript, PostgreSQL 18, Fastify, discord.js, Vitest/V8.

**Spec:** The user's approved next steps and the B20/B21 findings in `docs/audits/2026-09-12-report-flow-audit.md`.

## Constraints and review focus

- No live Discord reports, raw mail, credentials, or ambiguous final resubmission.
- Preserve unrelated README/local-tooling changes and protected Python diagnostics.
- Test cross-account event commits, rollback gaps, concurrent suspension/submission, stale ownership, and persistence failure after Discord success.

## Tasks

- [x] Reproduce event sequence/commit inversion with controlled PostgreSQL barriers; implement commit-safe allocation while preserving foreign-key lock order and existing cursors.
- [x] Reproduce suspension/lifecycle lock inversion; establish a shared lock order and verify credit conservation and final submission ownership.
- [x] Exercise bot notification/digest failure persistence and stale-claim recovery; fix demonstrated bugs with focused regressions.
- [x] Review combined changes and update canonical API/bot documentation, including the additional no-DSN fatal-log redaction finding.
- [x] Run root lint, workspace typecheck, coverage tests including PostgreSQL, build, and high-severity audit; investigate local timing failures with unchanged test deadlines.
- [ ] Push to PR #2, verify CI, review the complete PR, and merge its exact verified head.
- [ ] Verify resulting deployments and API readiness without sending a report.
