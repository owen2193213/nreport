# SDD ledger — plan: docs/superpowers/plans/2026-09-09-queue-observability-reliability.md

Preflight interface scan:

| Tasks | Shared file/interface | Finding |
| --- | --- | --- |
| 1 / 2 | PreparationWorker iteration diagnostic consumed by main logger | Task 1 defines safe error detail; Task 2 reuses the same logging vocabulary. No conflict. |
| 2 / 4 | main lifecycle start/stop and queue sampler | Task 2 owns lifecycle loops; Task 4 adds an independent sampler around their lifecycle. No conflict. |
| 2 / 3 | API events consumed by bot reconciliation | Both remain additive and preserve API/bot ownership. No conflict. |
| 3 / 4 | Bot notification lag versus API queue summary | Separate metrics and services; no shared file. No conflict. |
| 1 / 5 | package lock may change after implementation | Task 5 runs last. No conflict. |
| 1 | Tests demand stable kinds and prompt cancellation; production steps provide both. | Self-consistent. |
| 2 | Tests demand concurrent progress and maintenance; bounded loops provide both. | Self-consistent. |
| 3 | Tests demand terminal reply idempotency; durable claim state supplies it. | Self-consistent; schema migration must be additive. |
| 4 | Tests demand aggregate snapshots and nonthrowing logging; repository sampler supplies both. | Self-consistent. |
| 5 | Audit zero is a release gate; dependencies remain subject to full suite. | Self-consistent. |

Baseline: 41fb772 (audit/test review committed; 233 pass, 2 expected fail).

Ruling: Task 3 will use Discord's deterministic `nonce` plus `enforceNonce: true` for terminal replies instead of adding a bot database reply-state claim. Discord provides the only atomic deduplication boundary around its own create-message side effect; a local “sent” flag necessarily leaves either a duplicate-after-crash or lost-before-send window. Cost if wrong: Discord's documented recent-nonce window could expire before an unusually delayed retry, so the bot will also retain normal outbox retry bounds and log the delivery outcome.

Ruling: Task 4 will implement persisted pseudonymous trace IDs and additive API-to-bot propagation as well as aggregate queue snapshots. Without a common trace, the central user complaint—fractured logs—remains unfixed. Cost if wrong: this adds an API/bot contract migration and requires both Railway services to deploy from the same commit.

Task 1: fix round 1/5 (4 addressed, 0 open — safe provider cause, closed finish-reason category, active cancellation coverage, accurate provider-neutral user errors; commits 2adbd47..9929e56).
Task 1: complete (commits 41fb772..9929e56, review clean).

Task 2: fix round 1/5 (3 addressed, 1 open — live-job ABA ownership not fenced; commits 545320d..f6b1710).
Task 2: fix round 2/5 (heartbeat/finalizers fenced, 1 open — setStatus remained unfenced; commits f6b1710..0f95f32).
Task 2: fix round 3/5 (setStatus transactional ownership fence addressed, 0 open; commits 0f95f32..a3b50f9).
Task 2: complete (commits 9929e56..a3b50f9, review clean).

Task 3: minor fix (typed notification attempts and repository retry-state coverage; commits da0739f..c506358, scoped review clean).
Task 3: complete (commits a3b50f9..c506358, review clean).
Task 4: fix round 1/5 (3 addressed, 0 open — provider trace propagation, bounded outcome fields,
single-flight draining sampler; commits db88ce9..ebc6c89).
Task 4: fix round 2/5 (2 addressed, 0 open — traced heartbeat failures and per-event traced ingest
failures with cursor-preserving retry; from ebc6c89, scoped commit recorded in the task result).
Task 4: complete (from c506358 through the scoped fix commit, re-review pending).
Task 5: blocked before changes — `npm.cmd audit --json` registry access was rejected because
private dependency metadata egress requires explicit user authorization. No dependency versions
were guessed or changed.
