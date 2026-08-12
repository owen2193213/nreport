# Message Report Evidence Design

## Goal

Persist the reported Discord message and its author with each message report, then show the author identity and avatar on message-report cards. Preserve enough structured evidence for later database analysis without changing the Discord submission payload or crossing the API/bot ownership boundary.

## Scope

This applies to all `message_urf` reports created through **Apps → Report Message**, **Apps → Quick Report Message**, and `/report message`. Context-menu commands receive the selected Discord message directly. Link-based reports perform the existing best-effort bot lookup before report preparation.

The work does not add an analysis UI or public evidence-search API. It makes evidence durable and efficiently queryable in the API PostgreSQL database for later tooling.

## Canonical Storage

The API remains the report source of truth. A structured `messageEvidence` value is added to the shared message-report contract and stored in the existing `reports.input jsonb` column. This is a real PostgreSQL database record, not a loose JSON file. Bot drafts and tracking continue to use their existing encrypted payloads, but the bot database is not the canonical evidence store.

The API database applies its existing report-data access, backup, and retention controls to the snapshot. Snapshot content and URLs must never be emitted to structured logs. The JSONB value remains queryable; it is not separately application-encrypted because later content analysis requires database-level access to its fields.

Two partial expression indexes support later lookup without scanning unrelated reports:

- Captured author ID: `(input #>> '{messageEvidence,snapshot,authorId}')` for `flow = 'message_urf'`.
- Captured message ID: `(input #>> '{messageEvidence,snapshot,messageId}')` for `flow = 'message_urf'`.

## Shared Evidence Contract

`MessageCreateReportInput` and message `ReportedDetails` expose an optional `messageEvidence` union so historical records and rolling deployments remain readable:

- Captured evidence contains `source`, `status: "captured"`, `capturedAt`, and a snapshot.
- Unavailable evidence contains `source: "message_link"`, `status: "unavailable"`, and `attemptedAt`.
- `source` is `context_menu` or `message_link` for captured evidence.

The snapshot contains:

- Message ID, channel ID/name, server ID/name, exact message content, and original creation time.
- Author ID, username, display name, bot flag, and avatar URL.
- Attachments: filename, content type, byte size, URL, and spoiler flag.
- Embeds: title, description, and URL.

Attachment files and other media binaries are not downloaded or stored. Stored attachment and embed URLs are evidence metadata and remain excluded from Fireworks and Brave inputs under the existing media-processing rule.

## Capture and Data Flow

For a context-menu report, the bot snapshots `interaction.targetMessage` immediately and records `source: "context_menu"`. This is deterministic for the selected message and is used by both the normal and Quick Report paths.

For `/report message`, the bot parses the complete Discord message URL and asks the existing `MessageResolver` to fetch it. A successful fetch produces the same snapshot shape with `source: "message_link"`. If the bot cannot access the guild, channel, or message, the report remains valid and stores unavailable evidence. It does not infer or fabricate an author from the URL because a message link contains only server, channel, and message identifiers.

The bot includes `messageEvidence` in `CreateReportInput`. API validation accepts the backward-compatible absence of evidence, validates every supplied field and bound, and requires the snapshot message and channel IDs to match the submitted message URL. For guild links it also requires a non-null snapshot server ID to match the URL guild ID; DM links use `@me` and do not make that comparison.

The API stores the validated request in `reports.input`, returns the evidence through `ReportDetail.reportedDetails`, and preserves it when retrying a report. Rewrite-and-resend starts from the stored snapshot. It performs a new lookup only for a historical report that has no stored evidence; it never silently replaces captured evidence with a later edited version.

## Report Presentation

When captured evidence is available, message report review cards and subsequent status, history, browser, and lifecycle-DM cards add an **Author info** field containing:

```text
Reported user: Display Name (@username)
Discord ID: 123456789012345678
```

If Discord has no separate display name, the username is used as the display value. The embed thumbnail is the captured author's avatar when present. Discord-derived strings are truncated to embed limits and rendered without creating mentions.

For unavailable or historical evidence, the field reads `Author information unavailable.` No thumbnail is added. The report continues to show the submitted message URL as its Item.

The full captured message is stored for analysis but is not duplicated into the status card's Details field. Existing submitted report context remains the visible Details content.

## Error Handling and Compatibility

- A link-resolution failure does not block report creation and is represented explicitly as unavailable evidence.
- Context-menu capture is expected to succeed because Discord supplied the target message with the interaction; malformed snapshot data is rejected before API creation.
- Evidence validation failures return the normal safe API validation response and do not log the rejected content.
- Existing reports without `messageEvidence` remain viewable and show the unavailable fallback.
- Idempotency and ambiguous-final-submission behavior remain unchanged.
- API/bot deployment boundaries remain intact: shared shapes live in `@discord-dsa/contracts`, the bot uses the typed HTTP client, and the bot never reads API tables directly.

## Tests

Tests first cover:

- Context-menu snapshots including avatar, attachment, and embed metadata.
- Successful and inaccessible message-link resolution.
- Draft conversion carrying captured and unavailable evidence.
- API parsing, bounds, URL/snapshot ID consistency, JSONB persistence, and report-detail round trips.
- Author field and avatar rendering for captured evidence, plus the unavailable fallback.
- Retry and rewrite preservation of the original snapshot.
- PostgreSQL schema indexes for author and message lookup.

After focused red-green cycles, run root lint, workspace typecheck, all tests, build, and the high-severity audit.

## Documentation

Update `docs/BOT_API.md` with the message evidence contract, capture semantics, compatibility behavior, and report-detail response. Update `docs/BOT_IMPLEMENTATION.md` with context-menu versus link behavior, durable evidence storage, presentation rules, and the prohibition on logging evidence.
