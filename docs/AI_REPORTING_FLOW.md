# API-owned report preparation

The reporting API—not the Discord bot—owns AI writing and optional Brave research. Report
creation persists work and returns `202 Accepted` before any provider call. An in-process
`PreparationWorker` claims PostgreSQL jobs independently from the Discord lifecycle runner, with a
default concurrency of two, so long model requests cannot block verification or submission work.

## Workflow

```text
POST /v1/discord/dsa/reports
  -> reserve credit and persist original input
  -> queued
  -> planning
  -> researching (only when selected)
  -> writing
  -> persist prepared fields, sources, safe decision summary, and usage
  -> generate identity/session using the resolved country
  -> enqueue Discord verification lifecycle
```

Manual reports skip `planning`, `researching`, and `writing`. They copy the validated country,
category, description, and final text into prepared storage without constructing an AI or Brave
client. A `reuse` retry also copies the predecessor's immutable prepared payload, while a
`regenerate` retry starts from the original evidence and supplied hints.

## Field ownership

The original request is never overwritten. Any supplied country, category, or description is an
immutable reporter hint; the planner may fill only missing fields. `finalText` is forbidden in AI
mode and required in manual mode. Synthesis receives the resolved fields and cannot replace them.

The prepared record contains the resolved country, category, description, final report text,
legal reference, compact research summary, source annotations, and a safe summary of observable AI
decisions. Model reasoning, prompts, provider payloads, and the writer conversation are not stored.

Identity generation happens only after preparation because Auto country selection determines the
pseudonym locale, timezone, email alias, and country-matched sticky proxy session.

## Research limits and safety

The planner relies on model knowledge unless terminology or an exact country-specific legal
reference needs research. It may select bounded term research, law research, both, or neither.
Independent selected searches run concurrently. Synthesis may ask for one additional bounded
search; a second follow-up is rejected.

- Search queries are capped and reject URLs, email addresses, Discord snowflakes, known sensitive
  values, and unsafe Unicode/invisible content.
- Search results are untrusted source material. Only compact titles, HTTPS URLs, and excerpts reach
  synthesis.
- One structured-output repair is allowed for planner or synthesis validation failure.
- Provider/search transports use bounded retries, but the overall preparation deadline is 300
  seconds.
- Images and avatar, banner, attachment, and embed URLs are excluded from all AI and Brave input.
- Structured logs contain safe counts, stages, timings, and error categories, never credentials,
  raw evidence, prompts, or model reasoning.

Provider request, input-token, output-token, reasoning-token, and search totals are recorded
incrementally against the API account, including usage incurred before a later preparation failure.
The client cannot choose the model, provider, prompts, or callback destination.

## Failure and restart behavior

Preparation jobs are durable and restart-safe. A failure before Discord's final submission
boundary marks the report failed, releases the reserved credit, and emits a durable event. A worker
restart before that boundary requeues recoverable work. The separate lifecycle runner remains
fail-closed after the non-idempotent Discord boundary: crashes or ambiguous results keep the credit
consumed and never trigger an automatic second submission.

The account-scoped event feed exposes every visible transition. Administrator-assigned webhooks
accelerate updates but are not the source of truth.
