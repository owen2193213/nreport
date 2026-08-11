# Analytics, Action History, Notification Settings, and Digests

Date: 2026-08-11
Status: Approved design

## Objective

Add one private analytics hub where a reporter can inspect personal results and anonymized
community trends on demand. Add personal action history, granular lifecycle-DM settings, and
scheduled daily, weekly, or monthly digests without weakening the API/bot ownership boundary or
exposing sensitive report data.

The feature must not describe an `actioned` Discord status as a ban. Discord confirms only that it
took action; it does not disclose whether it removed content, warned a user, suspended an account,
or applied another measure.

## Product structure

### Analytics command

`/analytics` opens one ephemeral hub. It accepts an optional period and defaults to the last seven
days. The user can switch between Personal and Community scope without invoking another command.
Action History remains personal even if Community was selected previously.

Supported analytics periods are:

- last 24 hours;
- last 7 days;
- last 30 days;
- year to date;
- last 365 days;
- all time.

The response displays the exact UTC interval and the time at which the metrics were calculated.
Action History additionally supports custom start and end calendar dates entered through a modal.
Both dates are inclusive from the user's perspective; the bot converts the end to the exclusive
start of the following UTC day for the API query. Invalid, reversed, or excessively large custom
intervals receive an ephemeral validation error.

The hub has four views:

1. **Overview** presents new report cases, total attempts, successfully sent reports, actioned
   reports, reports awaiting a Discord response, action rate, appeal-then-action rate, and median
   Discord reply time.
2. **Trends** presents report volume, Discord reply time, message/server/profile percentages,
   semantic category and country breakdowns, and first-attempt versus retry volume.
3. **Outcomes** presents direct actions, reports closed without action, appeals started, appeals
   subsequently actioned, appeals denied, transport failures, and recurring patterns in actioned
   report explanations.
4. **Action History** presents only the requesting user's actioned reports, ordered newest first and
   filterable by preset or custom dates. Each item can show flow, category, country, submission and
   action dates, submitted explanation, internal reference, Discord reference when assigned, and
   message URL for message reports.

All analytics interactions and errors are ephemeral. Action History enforces ownership in the bot
before presenting any report detail. The global API credential remains a service credential and is
not treated as end-user authorization.

### Terminology and metric semantics

The interface uses **Action taken** or **Actioned**, never **Banned**.

- A **new case** is a root report created during the selected interval.
- An **attempt** is any report row created during the interval, including technical retries and
  denied-review resubmissions.
- A **sent report** has a `report_submitted` event or assigned Discord report ID. Current API status
  alone is insufficient because a sent report can later enter a receipt-timeout failure state.
- A **direct action** is an `actioned` Discord transition with no preceding closed-without-action
  and appeal sequence.
- An **appeal-then-action** is an `actioned` transition after the report was closed without action
  and an appeal was initiated.
- A **final denial** is `review_not_approved`. `closed_no_action` is reported separately because an
  eligible appeal may still be pending.
- **Awaiting response** means the report was sent but has no Discord lifecycle status yet.
- **Awaiting decision** means Discord has acknowledged receipt but has not produced an action or
  closed-without-action outcome.
- **Discord reply time** is the duration from `report_submitted` to the first correlated Discord
  lifecycle update.
- **Decision time** is the duration from `report_submitted` to the first actioned or
  closed-without-action update.
- **Appeal decision time** is the duration from `review_requested` to the subsequent actioned or
  review-not-approved update.

Rates always include their numerator and denominator. Pending records are excluded from denominators
that require a resolved state. When the denominator is zero, the rate is returned and rendered as
unavailable rather than zero percent.

The main analytics views use a created-case cohort: they answer what has happened, as of the query
time, to root reports created in the selected interval. Case outcome metrics follow the linear
`retry_of_report_id`/`retried_as_report_id` chain to its latest attempt, so failed predecessors do
not inflate denials or reduce the action rate. A retry created in the interval for a root case from
before the interval contributes to attempt and submission-reliability metrics but not to the new-case
outcome cohort. Results can change when Discord sends a late lifecycle update. The response includes
`asOf` to make that behavior explicit.

### Charts

The bot generates chart images locally and attaches them to the ephemeral response. No report data
is sent to a hosted chart service.

Trends contains:

- a volume chart bucketed hourly for 24 hours, daily for 7 and 30 days, weekly for year-to-date and
  365 days, and monthly for all time;
- a Discord reply-time chart using the same buckets when practical;
- compact percentage bars for flow and other categorical breakdowns.

Every chart has the underlying textual totals in the embed. If image generation fails, the command
still succeeds with the textual representation and logs only a safe chart error code.

### Recurring patterns

Pattern analysis uses only the final submitted `reportReason` and `context` fields. It does not
require or introduce durable storage of original Discord message text.

Personal scope can show normalized recurring terms or short phrases from the user's actioned report
explanations. Community scope applies all privacy rules below and labels the result **Recurring
themes** rather than implying that an individual phrase caused Discord's action.

Before aggregation, the analyzer removes URLs, Discord snowflakes, mentions, email-like values,
standalone numbers, punctuation-only tokens, and common stop words. Matching is case-insensitive and
uses bounded phrase lengths. The analyzer never emits an original explanation, full sentence, or
unredacted rare phrase. Pattern processing is deterministic and local; report content is not sent
to another model or analytics provider.

### Action History content boundary

The current authoritative report record contains the submitted explanation and, for message reports,
the message URL. It does not retain a durable snapshot of the original target message text for
ordinary reports. Action History therefore shows the submitted explanation and link, not a claim
that the linked message still exists or that its exact text was preserved.

Persisting original target content would expand sensitive-data retention and is explicitly outside
this feature. It requires a separate encrypted-retention design and approval.

## Community analytics privacy

Community analytics are aggregate-only and contain no Discord usernames, user IDs, report IDs,
targets, message links, pseudonyms, reporter aliases, or individual explanations.

Community output is available only when the selected interval contains at least 10 reports from at
least 5 distinct submitting users. Otherwise the hub shows that there is not enough activity to
produce a privacy-preserving result.

Within an eligible aggregate:

- a categorical bucket requires at least 3 reports from at least 3 users;
- suppressed categorical buckets are combined into **Other** when the combined bucket is itself
  safe to display;
- a recurring term or phrase requires at least 5 reports from at least 3 users;
- percentages are calculated only after suppression rules are applied, and the response does not
  expose hidden raw counts that would allow suppressed values to be reconstructed.

Community statistics never trigger a digest. They can only be included after the reporter's own
activity makes that digest eligible.

## Notification settings

The existing `/settings` command gains a `notifications` subcommand that opens an ephemeral settings
card. The country setting remains independent.

The user can independently toggle:

- submission results and transport failures;
- action taken and appeal accepted;
- closed without action and appeal denied;
- appeal progress updates.

The user can choose one digest frequency:

- Off;
- Daily;
- Weekly;
- Monthly.

Weekly is the default for new and existing bot-user preference records. Existing granular lifecycle
preferences default to enabled, preserving current notification behavior. A user changing a setting
receives an ephemeral confirmation showing the complete current preference state.

Lifecycle events continue to be ingested and reconciled regardless of notification preferences.
Preferences affect only outbound DM delivery; they do not alter report state, event cursors, report
history, or access to on-demand analytics.

## Digest behavior

A scheduled digest is eligible only when its UTC period contains at least one of:

- 3 new personal reports; or
- 3 personal outcome changes.

For eligibility, an outcome change is one of: action taken, closed without action, appeal accepted,
or appeal denied. Submission progress and community activity do not count toward the threshold.

An eligible digest contains:

- the user's new-report and outcome-change totals;
- personal action, appeal, pending, and median-reply figures;
- an anonymized Community snapshot when the community privacy thresholds are satisfied;
- flow percentages, action rate, appeal-then-action rate, volume trend, and reply-time trend;
- a concise instruction to use `/analytics` for full exploration.

Digest activity is attributed by event time: new reports count report creation during the digest
period, and outcome changes count qualifying lifecycle transitions that occurred during that period.
The digest labels these as period activity. It does not present them as the final outcomes of a
created-case cohort. Any cohort-based rate included in the digest uses the same explicit definition
as `/analytics` and is labeled separately.

Daily, weekly, and monthly boundaries are calculated consistently in UTC. The scheduler records the
frequency and exact period in every digest key. The unique key is conceptually
`digest:<discord-user-id>:<frequency>:<period-start>` so worker restarts and reconciliation cannot
send the same digest twice.

If a user's DMs are blocked, delivery follows the existing safe failure handling and does not retry
indefinitely. A failed or skipped digest does not change lifecycle notification preferences. An
ineligible period is recorded as evaluated without creating an outbound Discord message.

## Architecture and ownership

### API service

The API remains authoritative for report analytics. It adds database queries and authenticated
endpoints for:

- a submitter-scoped analytics aggregate;
- a privacy-filtered community aggregate;
- a submitter-scoped, actioned-only history page.

Queries derive state from `reports` and transitions/timing from `report_events`. The implementation
must not aggregate through the existing user report-list endpoint because that endpoint is capped at
100 records. The API does not import bot preference or notification state.

Useful indexes include a general reports creation-time index and an event-type/time index in addition
to the existing submitter/time and report-event indexes. Live queries are appropriate at the current
expected volume. Persistent analytics rollups are deferred until measured query performance requires
them.

### Shared contracts

`@discord-dsa/contracts` defines period identifiers, scope, interval metadata, count/rate/timing
metrics, chart series, privacy availability, breakdowns, pattern summaries, and paginated Action
History DTOs. Its `DsaApi` adapter exposes the new endpoints. It remains free of Discord SDK,
PostgreSQL, Fastify, and bot-runtime dependencies.

### Bot service

The bot owns:

- Discord command and component interactions;
- ownership and administrator checks before requesting scoped data;
- preference storage;
- digest schedule evaluation and idempotent delivery records;
- local chart rendering;
- ephemeral dashboard rendering and ordinary private digest DMs.

The bot does not reproduce the API's report aggregation logic or use expiring `report_tracking` as
the annual analytics source. Digest records and preference fields belong in the bot database.

## Data flow

### On-demand analytics

1. The user invokes `/analytics` and the bot defers an ephemeral reply.
2. The bot validates the period, scope, and ownership context.
3. The bot requests the matching aggregate from the API through the shared HTTP adapter.
4. The API calculates the authoritative cohort, transition metrics, breakdowns, privacy suppression,
   and chart series.
5. The bot renders the selected view and attempts local chart generation.
6. Buttons and selects retain scope and period while switching views. Action History forces Personal
   scope and uses cursor-based pagination.

### Notification delivery

1. The API lifecycle webhook/feed is ingested idempotently as today.
2. Before a lifecycle DM is delivered, the bot maps its semantic event to the user's current
   granular preference.
3. Disabled categories are recorded as suppressed; enabled categories proceed through the existing
   notification outbox and DM sender.

### Scheduled digest

1. The scheduler finds users whose configured digest period has closed and has not been evaluated.
2. It requests personal eligibility counts for that exact period.
3. If neither threshold is met, it records the evaluation and stops.
4. If eligible, it requests the complete personal aggregate and the privacy-filtered community
   aggregate for the same interval.
5. It generates the digest payload and chart attachments locally, then inserts an idempotent outbox
   record.
6. Delivery records success, a safe blocked-DM result, or a bounded retryable failure without
   duplicating the digest.

## Failure handling

- Empty personal periods render a no-activity dashboard rather than an error.
- Community periods below the privacy threshold render a privacy-preserving unavailable state.
- A zero rate denominator renders as unavailable.
- Invalid custom dates receive an ephemeral validation response and do not query the API.
- API timeout or unavailability uses the existing concise safe-error handling; no partial metric set
  is presented as complete.
- Chart generation failure falls back to textual metrics.
- Pattern-analysis failure omits the pattern field without failing the rest of the dashboard or
  digest.
- Preference writes are transactional. The confirmation is shown only after persistence succeeds.
- Digest creation and delivery are idempotent per user, frequency, and period.
- Logs contain metric counts, intervals, safe error codes, and hashed/pseudonymous actors where
  applicable, but never explanations, keywords, target content, links, IDs from report payloads,
  pseudonyms, aliases, or chart labels derived from sensitive text.

## Testing and validation

### Contracts

- Period, scope, metric, breakdown, pattern, and history DTO coverage.
- HTTP adapter paths, query encoding, pagination, and error behavior.

### API

- Root cases versus retry attempts.
- Sent reports that later enter receipt-timeout failure.
- Direct action versus appeal-then-action classification.
- Pending, closed-without-action, appeal-denied, and recovered late events.
- Reply, decision, and appeal timing calculations.
- Cohort interval boundaries and UTC year-to-date behavior.
- Submitter ownership filters and actioned-only history pagination.
- Community minimum-user/report thresholds, bucket suppression, and non-reconstructable percentages.
- Pattern sanitization, minimum support, and failure isolation.
- Query plans using the intended indexes on representative data volume.

### Bot

- `/analytics` defaults, scope and period switching, view navigation, and ephemeral responses.
- Action History always forcing personal scope and preventing cross-user access.
- Text fallback when chart rendering fails.
- Existing notification behavior after preference migration.
- Each granular notification toggle and semantic event mapping.
- Digest Off, Daily, Weekly, and Monthly schedules.
- Eligibility at 2 versus 3 reports and 2 versus 3 outcome changes.
- Community activity never triggering a digest.
- Idempotent evaluation, outbox insertion, retry, restart, and blocked-DM behavior.
- Settings persistence and confirmation rendering.

After TypeScript changes, run the repository-required lint, workspace typecheck, test, build, and
high-severity audit commands. Update `docs/BOT_API.md` for API/contract changes and
`docs/BOT_IMPLEMENTATION.md` for command, settings, notification, digest, privacy, and operational
behavior.

## Deferred work

- Durable encrypted retention of original target message content.
- Public or guild-visible analytics.
- Individual-user leaderboards or community drill-downs.
- Hosted analytics or chart providers.
- Yearly digest frequency.
- AI token/cost and credit-ledger analytics in the report dashboard.
- Materialized analytics rollups before live-query performance requires them.
