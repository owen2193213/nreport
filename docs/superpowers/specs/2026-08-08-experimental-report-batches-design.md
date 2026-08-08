# Experimental Report Batches Design

## Purpose

Add two experimental message-context commands that create independent DSA reports for one targeted
Discord message without keeping the interaction handler alive for the batch:

- `Experimental 10x Same Category` creates ten reports in one AI-selected message category, with a
  distinct explanation and final report text for each report.
- `Experimental All Categories` creates one report for every message-report category captured from
  the catalog when the command is invoked. The current catalog contains 18 categories.

Both commands use the existing access-key authorization model. A normal user must have enough
credits for the entire batch. Administrators and deployments with `WHITELIST_ENABLED=false` retain
the existing credit-bypass behavior.

## Command surface

The commands are global user-installed message-context commands and are available in the same Guild,
Bot DM, and Private Channel contexts as the existing message commands. Their names intentionally fit
Discord's 32-character application-command limit. Message-context commands cannot carry a visible
description, so the longer behavioral descriptions belong in the bot documentation.

The interaction is deferred ephemerally before database or AI work. After the batch transaction
commits, the interaction response states how many credits were reserved and tells the user that one
DM card will track the batch. The handler then returns. An access or balance rejection edits the
ephemeral response and creates no batch.

## Ownership and architecture

Batch orchestration belongs entirely to the bot because it owns Discord interactions, access,
credits, encrypted message snapshots, AI report writing, tracking, and DMs. The API continues to
receive ordinary authenticated single-report create and retry requests through `DsaApi`. No bot
code imports API database or job internals, and no batch endpoint is added to the API.

The bot database gains durable batch and batch-item state. A bot-side worker claims due items using
row locks with `SKIP LOCKED`, recovers stale claims after a restart, and runs no more than two item
pipelines concurrently. The concurrency bound limits bursts toward OpenRouter and the API while
allowing the interaction handler to finish immediately.

## Persistent model

An experimental batch records:

- its UUID, invoking Discord user ID, source interaction ID, command mode, and item count;
- the encrypted message-report draft containing the captured message snapshot and country defaults;
- a snapshot of the message-category values and labels used for the invocation;
- the shared category after the same-category seed item resolves it;
- the aggregate DM channel/message identity and whether DM delivery is blocked;
- aggregate state, timestamps, and worker claim timing.

Each batch item records:

- its UUID, batch UUID, stable ordinal, and fixed category when known;
- its state and next-run/claim timestamps;
- AI preparation attempt count and lifecycle retry count;
- a normalized explanation fingerprint used to prevent duplicates within the batch;
- the bot tracking ID, original internal report ID, and retry successor report ID when present;
- its per-item credit state and a safe failure code suitable for the aggregate card.

Sensitive message content, explanations, final report context, and API create input remain encrypted.
Generated inputs use the existing encrypted `report_tracking.encrypted_request` storage once an item
is ready for API creation. Logs contain batch/item IDs, ordinal, category, state, counts, and safe
error fields only.

## Atomic reservation and settlement

Creating a batch is one database transaction:

1. Lock and validate the bot user.
2. Capture the category list and derive the required count: ten for same-category, or the captured
   catalog length for all-categories.
3. Reject a non-bypassed user whose balance is smaller than the required count.
4. Insert the batch and all items.
5. Deduct the full count and write a batch reservation ledger entry, unless credits are bypassed.

Each item owns one unit of the batch reservation. When the API creates its report, that unit becomes
consumed. When AI preparation or a definite pre-creation operation permanently fails, that unit is
released in a transaction and one credit is returned. An ambiguous API create keeps the unit
reserved while the existing idempotency key is reconciled. Settlement operations are idempotent so
worker retries cannot consume or return a credit twice.

An item is linked to ordinary `report_tracking` before its create request. Its stable API idempotency
identity is derived from the batch UUID and item ordinal rather than reusing the one Discord
interaction ID for every report. Reissuing an ambiguous bot-to-API create uses the same identity and
input.

## Batch expansion and AI generation

### Same category

The first item is the seed. It uses normal Quick Report Auto behavior so the writer chooses the
message category. When preparation succeeds, the chosen category is stored on the batch and copied
to the other nine items before they become runnable. All ten API create inputs therefore contain the
same `reportType`.

Every item asks the writer for its own explanation and final report text. The experimental variation
instruction includes the item ordinal, total item count, and previously accepted explanation
summaries, and asks for a materially different factual angle without inventing evidence. Before an
item is accepted, the bot normalizes its explanation by Unicode normalization, case folding, and
whitespace collapse. A database uniqueness constraint on the batch and fingerprint rejects exact
normalized duplicates. A duplicate is an AI preparation failure eligible for the one preparation
retry.

### All categories

The invocation snapshots every value and label returned by `reportReasons("message_urf")`. One item
is created for each snapshot entry in catalog order, and every item has its `reportType` fixed before
AI work begins. The command name contains no numeric count because future catalog additions or
removals automatically change the batch size and credit requirement.

Each fixed-category item independently generates a category-specific explanation, legal research,
and final report text from the same captured message. The bot does not claim that every forced
category is factually applicable; these commands are explicitly experimental, but generated text
must still remain factual and may not invent evidence.

Country selection preserves Quick Report semantics for each item: a saved country default fixes the
country; otherwise Auto lets the writer select a supported country from the evidence and legal
relevance.

## Processing and retry rules

An item pipeline has three durable phases: prepare with AI, create/reconcile through the API, and
observe the report lifecycle.

- AI preparation receives at most two total attempts. A transient writer error, invalid output, or
  duplicate explanation schedules one retry with bounded backoff. Exhaustion releases the item
  credit.
- A transient bot-to-API create error is retried once with the same idempotency identity and
  encrypted input. A definite permanent 4xx rejection is not retried. An ambiguous create remains
  reserved and is reconciled using that identity.
- After creation, the existing API is the authority for `retryable`. A failed report with
  `retryable=true` receives one call to the existing retry endpoint, producing a fresh successor
  report ID and lifecycle without another credit.
- A failure with `retryable=false`, including `ambiguous_submission_state`, is never automatically
  resubmitted. This preserves the repository rule against duplicating an ambiguous final Discord
  submission.

The worker continues other items after an individual failure. Batch completion means every item is
in a stable submitted, failed, or reconciliation-required state; later Discord receipt and decision
events can still update the aggregate card.

## Aggregate DM and lifecycle delivery

Each batch owns one DM message. The worker creates it on first processing and edits it at meaningful
state changes rather than sending one message per item. The card contains aggregate counts and one
compact field per item, ordered by ordinal. Each field shows category, a truncated explanation,
current outcome, original report ID when known, and successor ID when a lifecycle retry occurs.

The current all-category batch has 18 item fields, below Discord's 25-field embed limit. The builder
also enforces per-field and total embed character limits. Full report details remain available through
`/reports`.

Batch-linked tracking rows suppress ordinary individual lifecycle DMs. Lifecycle ingestion routes a
changed batch item to an aggregate-card refresh instead. The refresh fetches or uses the detail for
only the changed item, persists its display state, decides whether the one safe lifecycle retry is
needed, and edits the shared card. A Discord 50007 response marks aggregate DM delivery blocked; the
ephemeral invocation response remains the initial fallback, while `/reports` remains the durable
history surface.

## Error handling and observability

The ephemeral response reports only access, balance, and durable enqueue outcomes. Long-running
errors appear on the aggregate DM card. If the initial DM cannot be sent, the batch continues and
records that delivery is blocked rather than losing report work.

Structured logs record batch enqueue, worker claim, state transition, retry scheduling, credit
settlement, report creation, lifecycle retry, aggregate-card update, and batch completion. They do
not include message content, generated explanations, report context, credentials, raw API input, or
reporter identity data beyond the repository's existing pseudonymous actor key.

## Testing

Automated tests will verify:

- both commands register as user-installed message-context commands with valid names;
- handlers defer immediately, enqueue durably, and perform no inline AI or API creation;
- ten credits and the captured catalog count are reserved atomically;
- insufficient balances roll back without batches, items, or ledger changes;
- the seed fixes one category across all ten same-category inputs;
- all-categories creates exactly one item for every captured catalog entry;
- explanations and per-item idempotency identities are unique;
- no more than two item pipelines are active concurrently and stale claims recover;
- AI preparation retries once, definite exhausted failures release one credit, and settlement is
  idempotent;
- report lifecycle retry happens once only when the API says it is retryable and consumes no extra
  credit;
- ambiguous final submissions are never automatically retried;
- one aggregate embed fits Discord limits for the full current category catalog;
- batch lifecycle events update the shared card without individual DM delivery;
- restarts resume queued, claimed, create-ambiguous, and lifecycle-waiting items safely.

Repository validation after TypeScript changes is `npm.cmd run lint`, `npm.cmd run typecheck`,
`npm.cmd test`, `npm.cmd run build`, and `npm.cmd run audit:high`. `docs/BOT_API.md` and
`docs/BOT_IMPLEMENTATION.md` will document the new bot-visible command and lifecycle behavior.
