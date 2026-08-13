# Reliable Report Retries and Decision Notifications

## Goal

Make report failures recover automatically when retrying is provably safe, keep one durable Discord
DM status card throughout a report chain, and make final report and appeal decisions immediately
understandable without opening the full history.

## Safety boundary

The system may perform up to three total report-lifecycle attempts for a case only when the API says
the failed attempt is safe to retry. The original report is attempt one; at most two automatic linked
successors may be created.

The following outcomes must never trigger an automatic successor:

- a final report submission whose result is ambiguous;
- a final appeal submission whose result is ambiguous;
- a report for which Discord returned a report ID but no receipt email arrived;
- deterministic input, eligibility, authorization, ownership, or validation failures; and
- any failure for which the API returns `retryable: false`.

This preserves the existing rule that an uncertain final POST cannot be repeated automatically.
Every retry remains a fresh API-owned lifecycle with a new generated identity, email alias, proxy
session, and immutable predecessor/successor links.

## Durable automatic retry orchestration

The bot owns automatic successor orchestration because it already owns encrypted request tracking,
the user's status-DM message ID, and bot-to-user notification delivery. The API remains the authority
for retry safety and creates each successor through its authenticated retry endpoint.

When the bot ingests a `report_failed` event, it must:

1. Load the authoritative report and its bot tracking record.
2. If `retryable` is true and the case has made fewer than three total lifecycle attempts, create a
   successor with a stable automatic-retry idempotency key derived from the failed report/event.
3. Create or replay the successor tracking row transactionally, inheriting the encrypted request,
   AI decisions, target snapshots, quick-report mode, and saved status-DM message ID.
4. Edit the existing status card to the successor's state without sending a terminal-failure reply.
5. Let later lifecycle events continue against the successor tracking row.

Bot restart and duplicate-event processing must replay the same successor instead of creating
another one. If automatic retry orchestration itself encounters a transient API or database error,
the existing durable notification outbox retries that orchestration. A definite, non-transient
orchestration error terminates the chain and produces the failure notification.

After attempt three fails, or when a failure is not safe to retry, the bot edits the saved status
card and replies to that message with a concise terminal-failure notification. Retry controls appear
only when a separately defined manual recovery remains safe.

API job retries within one lifecycle continue to use bounded stage retries. Safe transient stages
use three total job attempts. Final submit operations remain excluded whenever a repeated POST could
duplicate a report or appeal.

## Missing Discord confirmation

`discord_receipt_timeout` means Discord returned a report ID but no receipt email arrived. It is not
an automatic-retry condition. The status card and its reply explain that Discord did not confirm the
report and that the target message, account context, or server may have been deleted or become
inaccessible.

The user receives one manual **Retry as new report** opportunity for this condition across the case
chain. The API enforces this limit by checking predecessor history, not merely by hiding a button.
If that manual successor also ends in `discord_receipt_timeout`, it is terminal and has no retry
button. A late authenticated Discord update still recovers either timed-out report to its true state
and disables stale retry controls.

## Quick-report continuation

Bot tracking persists whether a submission originated from the message-context **Quick report**
flow. That mode survives restarts and successor creation.

Quick-report AI generation retries safe transient failures up to three total attempts. If generation
eventually succeeds, the bot proceeds directly to submission; it does not show a review card or ask
the user to press **Submit DSA Report**. Report-lifecycle automatic successors likewise submit through
the normal API lifecycle without introducing a confirmation step.

Deterministic generation failures stop immediately. After the final safe generation attempt fails,
the existing DM is edited with the failure and appropriate manual generation/edit controls.

## One status DM per case

All report and resubmission flows use a shared delivery rule:

- If the interaction message is the saved status DM, edit that message with full history.
- If a saved status DM exists elsewhere, edit it and show only the compact DM notice at the external
  interaction.
- If no saved status DM exists, create one only when DM delivery is enabled; otherwise keep the full
  view in the current ephemeral interaction.

Successor tracking inherits the predecessor's `status_dm_message_id`. The retry button, `/reports
retry`, resend-as-is, rewrite-and-resend, quick report, and ordinary submission paths all use this
same rule. A DM-originated action must never replace its card with “Check your DMs for the full status
log” or create a second card. If the saved Discord message was deleted, the bot may create a
replacement and atomically store its ID.

## Decision notification embeds

Final lifecycle decisions reply to the saved status card with a small embed rather than plain text.
The title and color distinguish:

- **Report accepted**
- **Report denied**
- **Appeal accepted**
- **Appeal denied**

An `actioned` update is an appeal acceptance when the report already has an appeal lifecycle
(`reviewStatus` is non-null or the timeline contains an appeal-submitted event); otherwise it is an
original report acceptance. Existing explicit `reviewStatus: approved` remains authoritative.

The compact embed contains:

- the report category;
- the reported target;
- for captured message evidence, a message link and a short sanitized content excerpt;
- for captured message or profile users, a non-pinging Discord mention, display name, username, and
  user ID; and
- the final outcome sentence.

Server reports show the resolved server name and identifier when available. Missing historical
evidence is described as unavailable rather than guessed. `allowedMentions: { parse: [] }` prevents
the reported user from being notified.

The main status card remains the full source of history and is edited before the compact reply is
sent. Existing event/outbox deduplication prevents duplicate decision replies.

## Ineligible appeals

Discord review code `521004` is a terminal appeal-ineligible result after the existing confirmation
attempt. It must set `appealRetryable: false` and must not expose or accept **Retry appeal**.

Instead, it makes the underlying report resubmittable and offers:

- **Send as is**, which creates a fresh linked report with the same report text; and
- **Rewrite & send**, which opens the existing rewrite flow before creating the linked report.

The API rejects stale appeal-retry requests for an ineligible report. The bot also checks the fresh
report state before executing any button action. These actions remain free, owner-checked, and
unavailable to suspended users, matching current denied-appeal resubmission rules.

## Data and contract changes

The bot tracking model gains the minimum durable metadata needed to distinguish quick reports and
automatic retry identity. Successor tracking copies the predecessor's encrypted request and display
metadata rather than importing API-owned data.

The API report response remains the authority for `retryable`, `appealRetryable`, and
`resubmittable`. Its retry transaction enforces the three-attempt automatic ceiling and one manual
receipt-timeout retry. The authenticated retry request carries a required `mode` value of `automatic`
or `manual`. The API validates and records that value so it can apply the correct limit without
inferring intent from an idempotency key. This does not change report ownership boundaries.

Any public request/response or lifecycle behavior change is documented in `docs/BOT_API.md`.
Operational, DM, retry, and notification decisions are documented in `docs/BOT_IMPLEMENTATION.md`.

## Error handling and observability

Structured logs record pseudonymous tracking/report identifiers, retry mode, attempt number, safe
classification, and whether the status card was edited, replaced, or unavailable. They must not log
report context, message excerpts, usernames, raw Discord mail, verification codes, credentials, or
other protected report data.

Notification delivery failures continue through the durable bot outbox. Discord error `50007`
(cannot DM user) remains a permanent delivery failure. Unknown-message error `10008` permits one
replacement status card; other Discord errors follow bounded outbox retry behavior.

## Verification

Automated tests must prove:

- safe failures create no more than two automatic successors and survive duplicate events/restarts;
- unsafe, deterministic, ambiguous-submit, and receipt-timeout failures do not auto-retry;
- a terminal attempt-three failure edits and replies to the saved status card;
- receipt timeout offers exactly one manual retry across the chain and late recovery removes it;
- quick-report transient generation retries continue straight to submission;
- every retry/resend/rewrite entry point reuses a DM-originated status card and never shows the DM
  notice there;
- deleted saved cards are replaced once and relinked;
- report acceptance and appeal acceptance produce distinct compact embeds;
- accepted and denied embeds include only available target/category/message evidence and use
  non-pinging mentions;
- ineligible appeals expose send-as-is/rewrite controls, never appeal retry, and stale API attempts
  are rejected; and
- notification outbox idempotency prevents duplicate replies and duplicate successor creation.

After each TypeScript change, run root lint, workspace typecheck, tests, build, and the high-severity
audit as required by the repository guide.
