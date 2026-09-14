# Report-flow reliability audit — 12 September 2026

Status: diagnosis only. **No application fixes, database mutations, commits, deployments, live reports, provider requests, or Discord messages were made by this audit.** The added files contain documentation and synthetic reproductions.

Reviewed source: commit `03147be`, matching the API and bot deployments inspected. Coverage includes interactions, evidence capture, HTTP contracts, credits, preparation, queue claims, verification, submission, receipts, appeals, retries, webhook delivery, reconciliation, DM cards, digests, and operations alerts.

## What production evidence says

The previous API deployment, running from 11 September 15:59 UTC until 12 September 03:58 UTC, logged:

- 41 successful preparations; duration range 5.632–13.575 seconds, median 7.162 seconds.
- 40 successful original submissions. One email-code request exhausted three attempts with a network error.
- 13 successful appeal requests and seven appeals classified as ineligible by Discord. Ineligibility alone is not evidence of an implementation bug.
- For 40 submission traces, the first subsequent bot notification completion ranged from 3.091 to 906.093 seconds later; median 716.776 seconds, with 24 over five minutes. This measures subsequent notification completion, not the exact first card edit: later decision events may supply that completion.

These samples support a historical notification-delay problem rather than generally slow preparation. They are not a complete success-rate or queue-latency census.

At 12 September 03:58:55 UTC / 11:58:55 Shanghai time, the current API logged successful managed-webhook configuration and assignment to seven accounts. That fix was already deployed before this audit. The inspected current-deployment preparation logs contained no completed preparations, so this audit cannot confirm live delivery for a new report after that configuration change.

Queue samples inspected around 12:46 and 12:56 Shanghai time were empty. The earlier investigation's operations-alert retry defect remains a strong explanation for the alternating alerts; the affected production outbox rows were not accessible through the connector.

## Evidence and severity

- **P1:** prioritize in the next reliability patch; can mislead users into duplicate submissions or block report updates.
- **P2:** concrete failure path, missing notification, or retry/recovery defect worth fixing.
- **Reproduced:** executed actual application methods with synthetic dependencies. SQL adapters model selected predicates and ordering, not PostgreSQL itself.
- **Static:** verified in source, but not reproduced against a real PostgreSQL database or live service. Production frequency remains unknown.

All findings below describe current behavior, not fixes applied by this audit.

## Confirmed failure paths

### B01 — P1: Internal API errors become HTTP 429, losing uncertain-create recovery

**Locations:** `apps/api/src/server-v2.ts:606`, `:302`, `:397`; `apps/bot/src/account-interactions.ts:283`, `:328`, `:404`.

The global error handler considers the presence of `x-ratelimit-limit` evidence that a limit was exceeded. The installed rate-limit plugin puts that header on ordinary allowed requests too. An unrelated database exception therefore becomes `429 rate_limited` rather than `500`, and loses the intended internal-error diagnostics/support reference.

The create/retry routes query queue length after the report transaction commits. If that query fails, the API returns the false 429 after creating the report. The bot treats it as a definite client rejection and deletes the pending operation. The report continues, but the user sees failure and the stable replay record is gone. Later event-feed ingestion may relink the report; another user submission can nevertheless create an additional report and consume another entitlement.

**Evidence:** Real Fastify injection reproduced both an ordinary read failure returning 429 and the combined create-commit → queue-query failure → 429 → bot pending-link deletion path.

**Suggested fix:** Classify rate limiting from explicit error/status information, preserve genuine 500 responses, and prevent optional post-commit queue telemetry from making a successful mutation look rejected. Test the combined API/bot path.

### B02 — P1: Uncertain creates tell users to submit again while automatic replay remains active

**Locations:** `apps/bot/src/account-interactions.ts:283`, `:498`; `apps/bot/src/account-notifier.ts:205`.

A network failure after create leaves the pending operation available for replay, correctly retaining its idempotency key. The interaction then says “The request failed. Please try again.” A second interaction uses a new key, so both requests can become independent reports.

**Evidence:** Injected lost-response exception retained the recovery record and produced exactly that user message.

**Suggested fix:** Return an explicit uncertain/reconciling state and retain the original operation identity. Do not invite a new submission while the first outcome is unresolved.

### B03 — P2: Unreadable HTTP 202 responses are treated as definite rejection

**Locations:** `packages/report-contracts/src/api.ts:75`; `apps/bot/src/account-interactions.ts:283`, `:328`, `:404`.

The HTTP adapter raises `DsaApiError` with status 202 when a successful response contains invalid JSON. The interaction's `status < 500` predicate deletes its pending operation, even though the server explicitly accepted the request.

**Evidence:** Mocked HTTP 202 with malformed JSON caused pending-link deletion.

**Suggested fix:** Distinguish transport/decoding uncertainty from definite 4xx rejection. Preserve the original request/key for replay after a malformed success response.

### B04 — P1: Deleting a DM status card permanently blocks later notifications for that report

**Locations:** `apps/bot/src/account-notifier.ts:95`; `apps/bot/src/account-database.ts:365`.

When Discord returns Unknown Message, the notifier converts the fetch failure to `null` and tries to claim a new card. The claim requires the persisted `dm_message_id` to already be null. The stale ID is never cleared, so every attempt reports card creation in progress and retries. Decision replies are blocked behind card creation too.

**Evidence:** Two consecutive actual notifier runs with a deleted persisted card produced retries, zero replacement sends, and zero completed notifications.

**Suggested fix:** On confirmed deletion, atomically invalidate only the matching stale mapping and create a replacement. Keep the mapping on transient fetch errors.

### B05 — P2: Replacement transfers the card, then repair resurrects the predecessor

**Locations:** `apps/bot/src/account-database.ts:293`, `:383`; `apps/bot/src/account-notifier.ts:247`.

`completeReplacementLink()` transfers the old card to the successor and nulls the predecessor's mapping. The predecessor now satisfies the generic missing-card repair predicate. Recovery can send an obsolete card for the old report. Pending old-report notifications can also attempt card creation because the link has no superseded marker.

**Evidence:** Actual replacement/repair methods with a predicate-aware SQL substitute returned the predecessor as repair-eligible immediately after transfer.

**Suggested fix:** Persist supersession and exclude superseded links from card repair/creation. Handle predecessor events intentionally rather than treating the missing mapping as accidental loss.

### B06 — P2: Lost card-send responses create duplicate DM cards

**Locations:** `apps/bot/src/account-notifier.ts:109`, `:284`; `apps/bot/src/account-interactions.ts:292`.

If Discord accepts a card but its response or mapping write fails, the next attempt creates another card. Card creation has no stable enforced nonce, although terminal replies already do.

**Evidence:** Accepted-but-response-lost simulation produced two card sends without nonce protection.

**Suggested fix:** Use a stable operation nonce for card creation and explicitly reconcile uncertain sends/mapping writes. Account for the limits of Discord's nonce deduplication window.

### B07 — P1: Failed or ambiguous appeals are displayed as ongoing and suppress problem notifications

**Locations:** `apps/bot/src/report-ui.ts:58`, `:117`; `apps/bot/src/account-notifier.ts:125`.

`request_failed` and `request_ambiguous` lack explicit view states. With `discordStatus=closed_no_action`, both fall through to nonterminal “Report denied” with an appeal-not-submitted description. Their lifecycle events do not qualify for a problem reply, and the notifier marks the event complete.

**Evidence:** Actual notifier runs for both event types, with all preferences enabled, completed the events with zero replies and a nonterminal view.

**Suggested fix:** Add explicit failed/uncertain appeal views and problem-event handling. Preserve the ban on automatic resubmission of ambiguous outcomes.

### B08 — P1: A receipt/submission race strands an email that was actually received

**Locations:** `apps/api/src/report-repository.ts:1838`, `:1556`.

Interleaving: the email lookup finds no committed Discord report ID; `markSubmitted()` commits and finishes its pending-mail scan; the email then inserts `pending_report`. No scheduled recovery revisits that message. A duplicate delivery returns `duplicate` without applying it. The report can consequently reach its receipt timeout despite the receipt having arrived. Decision emails and appeal links can be affected too.

**Evidence:** Actual repository methods executed under a controlled lookup/commit/insert interleaving. Follow-up calls to recovery/deadline methods never queried the inbound-mail table. This is an interleaving simulation, not a PostgreSQL MVCC test.

**Suggested fix:** Coordinate correlation through the report's known recipient and add durable reconciliation for unresolved inbound messages. Deduplication must not prevent an unresolved message from being applied later.

### B09 — P2: Delayed closure emails schedule appeals after a successful decision

**Locations:** `apps/api/src/report-repository.ts:1863`, `:1573`.

An older `closed_no_action` email with an appeal link can arrive after `actioned`. Status ordering prevents regression of `discord_status`, but appeal scheduling runs outside that guard, setting `review_status=queued` and creating an appeal job anyway.

**Evidence:** Actual-method simulation retained `actioned` while creating an appeal job and queued review state.

**Suggested fix:** Gate appeal scheduling on the effective eligible decision, using shared logic for immediate mail and pending replay.

### B10 — P2: Pending email replay omits recipient correlation

**Location:** `apps/api/src/report-repository.ts:1558`.

Immediate email handling requires both external report ID and recipient. Pending replay matches only the external ID. A pending message with another recipient is accepted and applied. This is correlation inconsistency; it does not bypass the webhook's sender/signature validation.

**Evidence:** Synthetic mismatched-recipient message was consumed by the actual replay method.

**Suggested fix:** Apply the same external-ID-plus-recipient rule on both paths.

### B11 — P2: Preparation commit uncertainty can turn successful preparation into failure

**Locations:** `apps/api/src/preparation-worker.ts:113`; `apps/api/src/report-repository.ts:1183`.

If preparation commits but its acknowledgement is lost, the worker catches the rejection and runs `failPreparation()`. That method has no matching running-claim/attempt guard. It can release the entitlement and overwrite the already-completed preparation job/report before submission begins.

**Evidence:** Fault injection modeled durable preparation completion followed by a rejected store call; the real worker catch path and repository failure method released the reservation and marked the completed work failed. No claim is made that an actual database socket failure was reproduced.

**Suggested fix:** Fence preparation mutations with claim ownership/attempt, and reconcile uncertain persistence before converting it to a report failure. A six-minute recovery lease alone is not a substitute for ownership checks.

### B12 — P2: One bad connection stops fast recovery for later accounts

**Location:** `apps/bot/src/account-notifier.ts:197`.

`recoverOnce()` has no per-connection exception isolation. A corrupt encrypted credential or an authorization failure propagated from recovery stops the sweep. Subsequent accounts are skipped again on the next five-second sweep and depend on the slower reconciliation path.

**Evidence:** Actual recovery simulations with two accounts and with repeated credential-decryption failure skipped later accounts.

**Suggested fix:** Catch/log safely per connection and continue, as the separate reconciliation loop already does.

### B13 — P2: An unrelated pending create blocks the account event cursor

**Locations:** `apps/bot/src/account-database.ts:430`; `apps/bot/src/account-notifier.ts:189`.

An untracked report event is classified as a linking race if any create is pending for that account. Reconciliation immediately returns without processing later events or advancing the cursor. A repeatedly failing unrelated create therefore delays other reports.

**Evidence:** Real ingestion/reconciliation methods with a synthetic unrelated pending operation stopped after the first event and made zero cursor advances.

**Suggested fix:** Durably stage unmatched events, or correlate the pending operation specifically, so unrelated uncertainty does not stop the entire account feed.

### B14 — P2: Rate-limit retries ignore the server's requested wait

**Locations:** `apps/api/src/preparation/ai-client.ts:179`; `apps/api/src/lifecycle-runner-v2.ts:361`, `:607`.

The AI client immediately repeats 429/5xx calls without delay. Lifecycle retry scheduling ignores the parsed Discord `retryAfterSeconds`, using fixed 10/20-second delays for the first two failed attempts instead. A legitimate longer rate limit can exhaust retries before recovery is possible.

**Evidence:** AI HTTP 429 with Retry-After 60 seconds produced three calls in milliseconds. A synthetic Discord 429 carrying 60 seconds scheduled the retry after 10 seconds.

**Suggested fix:** Honor bounded Retry-After, add appropriate backoff/jitter, and keep waits within the workflow deadline. Apply consistent semantics to the search provider as well.

### B15 — P2: Socket failures while reading a response body skip safe transport retries

**Location:** `packages/discord-dsa-client/src/transport.ts:216`; also `:166`.

Only the initial Undici request is inside the network-error wrapper. Body consumption happens outside it. A connection that closes after headers produces an unwrapped `SocketError`, which the lifecycle runner does not recognize as `DiscordDsaNetworkError`. Safe pre-submission retries are therefore skipped and the user receives a generic failure.

**Evidence:** Loopback HTTP server sent headers and a partial body, then closed the connection. The real transport emitted `SocketError`, not the retryable network-error type.

**Suggested fix:** Classify request and body-read network failures consistently. Preserve the distinct no-automatic-retry rule after the final submission boundary.

### B16 — P2: Operations alerts retry forever after successful delivery

**Locations:** `apps/api/src/report-repository.ts:226`, `:431`; `apps/api/src/operations-alert-worker.ts:54`.

The unique `(alert_key, kind, state)` constraint permits only one historical sent row per alert kind. A subsequent alert reaches Discord but cannot become `sent`. The catch block labels the database failure as network failure and reschedules it, eventually every five minutes. Recovery messages have the same problem.

**Evidence:** Actual sender plus an in-memory SQL table enforcing the identical simple uniqueness triple reproduced successful webhook responses followed by repeated 300-second retries. SQLite was used only for this constraint, not PostgreSQL concurrency.

**Suggested fix:** Deduplicate only active deliveries or introduce episode identity; permit multiple historical sends and separate persistence failures from HTTP failures. A future migration must handle existing retrying rows deliberately.

### B17 — P2: Fresh jobs after idle periods trigger false no-progress alarms

**Location:** `apps/api/src/operational-alerts.ts:48`.

The predicate checks the age of the worker's last success, not how long the current ready work has waited. A 100-millisecond-old job can trigger a critical alarm after a quiet period. Emptying the ready queue closes it, making flapping likely.

**Evidence:** The actual evaluator raised the alert for that synthetic case.

**Suggested fix:** Base stalling on sustained ready-work age and actual worker activity, with suitable recovery hysteresis.

### B18 — P2: Digest retries are lost when the reporting period changes

**Locations:** `apps/bot/src/digest-worker.ts:36`; `apps/bot/src/account-database.ts:561`.

The scheduler only selects yesterday's daily period or last week's period on Monday. A failure crossing midnight, or Monday into Tuesday, leaves the old delivery record unselected despite being retryable.

**Evidence:** A simulated late-Monday weekly failure was recorded but never reclaimed by Tuesday's scheduler call.

**Suggested fix:** Select incomplete persisted deliveries independently from creating new current-period digests.

## Source-confirmed defects needing additional database tests

### B19 — P2: Coalescing discards decision notifications users explicitly enabled

**Location:** `apps/bot/src/account-database.ts:458`.

Ingestion marks every older pending event for the report ignored, without preserving decision/problem delivery. An opted-in original denial followed quickly by appeal progress loses the denial event; the progress event does not send that requested reply. Older events arriving out of order are also ignored solely because a newer event exists.

**Evidence:** Static SQL and notifier predicate analysis. Existing tests check coalescing query shape rather than distinct decision delivery.

**Suggested fix:** Separate coalesced card refreshes from durable decision/problem notifications.

### B20 — P2: Suspension and submission acquire locks in conflicting orders

**Locations:** `apps/api/src/accounts.ts:535`, `:584`; `apps/api/src/report-repository.ts:1255`, `:2015`.

Suspension locks the account then reports/chains/jobs. Lifecycle mutations first lock their job and then request report/chain/account locks. Concurrent transactions can wait on each other's locks; PostgreSQL would abort a deadlock victim. Rollback protects atomic credit changes but does not make the requested suspension/submission operation succeed.

**Evidence:** Static lock-order analysis; no concurrent PostgreSQL execution was available.

**Suggested fix:** Establish and test a shared lock order, with bounded retries for retryable database transaction errors.

### B21 — P1 risk: Event ID order can differ from commit order and skip feed events

**Locations:** `apps/api/src/report-repository.ts:117`, `:847`; `apps/api/test/report-recovery.test.ts:8`.

The global advisory lock is acquired in an AFTER INSERT trigger, after a sequence ID was allocated. A lower-ID transaction can pause before taking that lock while a higher-ID transaction takes it and commits. A reader can advance its cursor past the higher ID, permanently missing the lower event when it commits later.

**Evidence:** Static sequence/trigger/cursor analysis. The existing test explicitly asserts AFTER INSERT to keep foreign-key locking ahead of the advisory lock; it does not test publication order. This risk requires a real PostgreSQL concurrency reproduction before choosing a fix.

**Suggested fix:** Design commit-safe event publication/cursors together with consistent lock ordering. Do not blindly move the trigger to BEFORE INSERT: that can reintroduce the lock inversion the current test addresses.

## Inefficiencies and visibility gaps

These are source observations and targeted improvements, not measured production bottlenecks or additional reproduced incidents.

- **Serial notification/webhook work:** one slow recipient/destination occupies the sole corresponding sender. API webhooks allow ten seconds per request; repeated failures across several destinations delay otherwise healthy deliveries. Consider bounded concurrency with per-report/per-destination ordering.
- **Expensive queue reporting:** `queueSnapshot()` aggregates the whole job table; queue length is also read on individual report reads and after mutations. Retained historical jobs increase this work. Measure plans/data size before choosing indexes, cached aggregate counts, or retention.
- **Frequent empty polling:** each preparation slot opens a transaction approximately every 500 ms while idle; lifecycle slots poll every 750 ms, plus telemetry and bot recovery. Per-connection recovery also repeats global expired-form cleanup. Query round trips can dominate small jobs.
- **No demonstrated overload/fairness policy:** FIFO queues and per-minute admission limits allow one account's burst to occupy shared capacity. Queue length is a global count including running/delayed work, not the user's position or an ETA. Run a synthetic multi-account load test before changing limits/concurrency.
- **Worker health can be misleading:** the operations sampler writes worker heartbeats itself; maintenance completion also counts as lifecycle progress. A healthy sampler/maintenance loop can mask job-loop trouble. The no-progress check excludes an entirely running queue with no ready jobs. Track worker-owned heartbeats and stage/lease ages.
- **Transport lacks a hard total wall-clock deadline:** header/body inactivity timeouts do not bound a response that continually trickles data; the lifecycle lease can continue being renewed. Consider an overall abort deadline and bounded shutdown/close behavior. This was source-reviewed, not load-tested here.
- **AI milestone labels are premature:** the writer emits research progress before running the planner, even if the plan ultimately performs no research (`report-writer.ts:758`). This disagrees with the documented stage sequence and can make planning look completed prematurely.
- **Evidence availability is poorly surfaced:** unavailable linked-message evidence can proceed into AI preparation with no reporter hint; server enrichment code is not called by the reporting modal path. No synthetic test establishes generated-report quality. Make missing evidence visible and test report quality on representative authorized fixtures without sending live reports.
- **Email forwarding has no explicit fetch deadline:** a stalled API can hold the email handler open. Its failure diagnostics read the entire response before truncating and log body text rather than only allowlisted fields. Sender/alias/signature checks are covered by existing tests, but bounded failure handling merits a separate test.

## What was verified and what was not

The original suite passed **324 tests across 33 files**. The two added bot audit files add four Vitest cases containing nine synthetic scenarios; the combined run passed **328 tests across 35 files**. The standalone report-handling script reproduced nine scenarios; the email script reproduced four fault scenarios plus a recovery-query coverage assertion.

Lint, all workspace typechecks, and the build passed. The required high-severity dependency audit initially could not reach the registry in the sandbox; rerunning with network access returned **zero vulnerabilities**.

Existing tests cover manual/AI paths, input validation, signed mail/webhooks, credit reservation and idempotency, lifecycle ownership checks, ambiguous final submission behavior, and several recovery paths. Most persistence tests stub SQL: passing them does not validate constraints, real locks, deadlocks, commit ordering, or a full API-to-bot transaction sequence. B01 demonstrates a cross-layer failure missed by the original suite.

No live Discord submissions, AI/search requests, SMTP tests, or production database changes were used. Production inspection was read-only and retained only aggregate findings here. Real PostgreSQL concurrency, large-backlog performance, Cloudflare runtime behavior, and post-webhook-change live delivery remain unverified.

## Reproduction files

Run from the repository root with installed dependencies and Node 24:

```powershell
node docs/audits/2026-09-12-report-handling.simulation.mjs
node docs/audits/2026-09-12-api-email.simulation.mjs
npm.cmd test -- docs/audits/2026-09-12-bot-notification.test.ts docs/audits/2026-09-12-bot-notification-supplement.test.ts
```

The audit simulations assert **current buggy behavior**, so a pass confirms reproduction, not correctness. When fixes are authorized, convert the relevant assertions into desired-behavior regression tests rather than preserving these expectations unchanged.

## Suggested repair order, for a later authorized change

1. B01–B03: make mutation outcomes and recovery unambiguous to users; avoid duplicate submissions.
2. B04–B07 and B19: repair card ownership/replacement and preserve decision/problem delivery.
3. B08–B11: make email correlation and preparation persistence recoverable and consistent.
4. B12–B18: isolate recovery failures, fix retries/transport classification, and stop alert/digest defects.
5. Reproduce B20–B21 with PostgreSQL, then address concurrency and measure the listed performance gaps.

This ordering is a proposal only. The audit does not implement any of these changes.
