# Message Report Content-First Prompt Design

## Goal

For message reports, guide the AI report writer to foreground the reported message's content and the reporter's explanation instead of unnecessarily foregrounding the message author's username.

## Scope

- Change only the general initial writer guidance in `apps/bot/src/report-writer.ts`.
- Apply the new prioritization only when the reported target is a Discord message.
- Preserve author identification when it is necessary to make a factual report clear.
- Leave profile and server report guidance unchanged.
- Add a regression test that verifies the message-specific instruction reaches the writing completion.

## Design

The existing initial writer prompt will retain its adaptable structure, but will explicitly distinguish message reports from other report targets. For a message report, it will instruct the model to begin with the reported message's content or conduct and the reporter's explanation of why it is harmful or unlawful. The author name is supporting context, not the subject of the report, unless identifying the author is necessary for clarity.

No evidence fields, model schemas, report limits, research behavior, or prompt transport will change. The writer will still return the same JSON-only `report` output and remain limited to 512 characters.

## Validation

The focused report-writer test will use a message-flow draft and assert that the outgoing writer conversation includes the new message-specific instruction. The test will fail before the prompt change and pass afterward. Existing report-writer tests will then be rerun.
