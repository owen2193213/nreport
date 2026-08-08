# Manual Appeal Retry Design

## Goal

Give a Discord appeal that receives the definitive `521004` ineligibility response one automatic
retry after 10 seconds, then let the report owner retry the same appeal manually at a convenient
time without exposing its review link or weakening ambiguous-submission safeguards.

## Behavior

- The first `521004` response from Discord does not immediately finalize the appeal as ineligible.
  The API job is rescheduled once with a 10-second delay.
- A second consecutive `521004` response finalizes the appeal as `ineligible` through the existing
  review status and lifecycle event.
- An ineligible report exposes a `Retry appeal` button in its private status surfaces.
- The button remains available after every later definitive `521004` response.
- Only one appeal attempt may be pending for a report at a time. The API also applies a short
  server-side cooldown so duplicate clicks cannot enqueue repeated attempts.
- A successful manual attempt removes the button naturally by advancing the existing review
  lifecycle.
- Network failures and ambiguous review submissions remain non-repeatable. The button is never
  available for `request_ambiguous` or other non-ineligible states.

## Architecture

The API continues to own appeal links and appeal submission. The completed review job already
retains the encrypted review URL; a new authenticated report action requeues that same job payload
after validating that the report is currently ineligible. The bot never receives the link or token.

The shared contracts package adds an appeal-retry operation and a report-view capability flag. The
bot renders the button from that flag, verifies report ownership through the API response, and calls
the new operation with an interaction-derived idempotency key. Existing API authentication and bot
ephemeral-response rules apply.

## Data Flow

1. The API worker resolves the encrypted Discord review link and submits its token.
2. On the first `521004`, the job returns to `pending` with `run_at` 10 seconds later and leaves the
   report in `queued` review state.
3. On the second `521004`, the API stores `ineligible` and publishes `review_ineligible`.
4. Private bot status surfaces receive `appealRetryable: true` and render `Retry appeal`.
5. A button click calls the API appeal-retry action with the owner ID and an idempotency key.
6. In one database transaction, the API verifies the current state and cooldown, changes the review
   state to `queued`, and requeues the retained encrypted job payload.
7. Webhook delivery and reconciliation update the same private status message as the attempt moves
   through the existing lifecycle.

## Error Handling and Safety

- The API rejects non-owners, reports without a retained review job, non-ineligible states, clicks
  during the cooldown, and clicks while an attempt is already pending.
- Repeated delivery of the same interaction is idempotent.
- A manual attempt that reaches an ambiguous POST outcome becomes `request_ambiguous`; it is not
  automatically retried and no manual retry button is shown.
- Review URLs, tokens, proxy credentials, and report context remain absent from responses and logs.
- The original report is not recreated and no report credit is charged.

## User Interface

The button label is `Retry appeal`. It appears only when the API says the existing appeal can be
retried. Clicking it gives an ephemeral acknowledgement that the appeal was queued; the private
status card and lifecycle DM continue to carry authoritative progress and outcome updates.

## Testing

- API worker tests prove the first `521004` schedules a 10-second retry and the next one finalizes
  ineligibility.
- Database/API tests prove owner validation, retained-payload reuse, idempotency, pending-attempt
  exclusion, and cooldown enforcement.
- Contract tests cover the new operation and capability field.
- Bot UI and interaction tests prove exact button visibility, ownership behavior, API invocation,
  ephemeral acknowledgement, and removal outside the ineligible state.
- Full lint, typecheck, test, build, and high-severity audit validation is required.

## Documentation

Update `docs/BOT_API.md` for the public API action and lifecycle semantics. Update
`docs/BOT_IMPLEMENTATION.md` for the automatic retry and private manual control.
