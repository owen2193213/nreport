# Experimental Batch Latest Outcomes Design

## Goal

Make the experimental batch aggregate DM show the original targeted Discord message once near the
top and show each item's latest report or appeal outcome whenever lifecycle data changes.

## User-visible behavior

- The existing aggregate DM remains the only batch notification message.
- A bounded `Reported message` preview appears near the top of the aggregate card.
- The preview comes from the encrypted message snapshot captured when the command was invoked.
- If the message has no text, the preview summarizes its attachment and embed counts without
  exposing media URLs.
- Each item continues to show its category, generated reason preview, report identifiers, and safe
  error code.
- Each item also shows one latest-outcome label. It does not show a growing per-item history.

Latest outcomes use this precedence:

1. Appeal status, when present.
2. Discord report decision or receipt status.
3. API submission or failure status.
4. The worker's queued/preparing/creating/reconciling state.

Representative labels include `Report received — awaiting decision`, `Report accepted`, `Report
closed without action`, `Appeal preparing`, `Appeal submitted`, `Appeal accepted`, `Appeal denied`,
`Appeal uncertain`, `Submitted — awaiting confirmation`, and `Failed`.

## Data ownership and persistence

The bot remains the only owner of batch presentation state. The API contract and service boundary do
not change.

The existing encrypted batch draft already contains `messageSnapshot`, so no second message-content
column is added. The batch worker decrypts that snapshot only while constructing the private DM
payload. Original message content remains excluded from structured logs and plaintext database
columns.

Add nullable `last_review_status` to `experimental_report_batch_items`. Store it beside the existing
`last_status` and `last_discord_status` whenever a report is created, observed, or replaced by a
safe lifecycle retry. Existing rows migrate with `NULL` and naturally fall back to Discord/API or
worker state until their next observation.

## Lifecycle data flow

1. A webhook or event-feed reconciliation enters through the existing `ingestLifecycleEvent` path.
2. Batch-linked tracking suppresses the ordinary report DM and wakes the owning batch item.
3. The experimental worker fetches the authoritative current `ReportDetail` from the API.
4. The database transaction stores API status, Discord status, and appeal status on the item.
5. The worker reloads the batch view, derives the latest outcome, and edits the saved aggregate DM.

Initial creation and explicit safe retry responses follow the same persistence path, so the card is
accurate before the next lifecycle event as well.

## Rendering and limits

Outcome selection is implemented as a pure function so every state and precedence rule can be
tested independently. The aggregate UI receives `lastStatus`, `lastDiscordStatus`, and
`lastReviewStatus` for each item plus one batch-level `reportedMessage` value.

The original message preview is mention-safe through the existing `allowedMentions: { parse: [] }`
payload and is truncated to a conservative length. Item reason previews remain bounded. Tests
measure the serialized embed against Discord's 25-field, 1,024-character field, and 6,000-character
aggregate limits using the complete current message-category catalog.

## Error handling

- A missing or undecryptable snapshot omits the message preview without stopping report processing.
- An unknown appeal value falls back to a normalized readable label rather than failing the DM edit.
- Discord error 50007 continues to disable further aggregate DM attempts for that batch.
- A deleted aggregate DM continues to be replaced using the existing behavior.
- No lifecycle retry rules, credit accounting, or ambiguity handling change.

## Testing

- Pure outcome-label tests cover appeal precedence over Discord and API status.
- Rendering tests cover text messages, attachment-only messages, missing snapshots, and Discord
  embed limits across all current categories.
- Persistence tests verify create, observe, and safe-retry transitions store review status.
- Worker tests verify a refreshed batch view passes the persisted lifecycle fields and decrypted
  original message into the aggregate embed.
- Existing batch concurrency, credit, idempotency, retry, and ordinary notification tests remain
  green.

## Documentation

Update `docs/BOT_IMPLEMENTATION.md` to document the original-message preview and latest-outcome
semantics. `docs/BOT_API.md` needs no endpoint-shape update, but its experimental command contract
should state that the aggregate card reflects API, Discord, and appeal outcomes.
