# Discord DSA Bot Implementation

Status: implemented user-installed app design
API contract: [`BOT_API.md`](BOT_API.md)

## Deployment boundary

The bot is the `@discord-dsa/bot` npm workspace and deploys independently from the API.
It imports API DTOs and the HTTP adapter from `@discord-dsa/contracts`; it never imports
the API database, job runner, proxy, email, or low-level Discord reporting client.

The API and bot use separate PostgreSQL services. The API database remains authoritative
for every report. The bot database contains only access state, encrypted temporary drafts,
idempotency reconciliation records, notification cursors, and a durable DM outbox.

## Discord installation and commands

All commands are global and use `USER_INSTALL` only. They support guild channels, the
app's bot DM, ordinary DMs, and group DMs:

When `NODE_ENV=production`, bot startup synchronizes this complete command set through
Discord's bulk global-command endpoint before connecting to the Gateway. The standalone
registration script requires only `DISCORD_BOT_TOKEN` and `DISCORD_APPLICATION_ID`.

```text
/report message message-link [country]
/report profile target [server-id] [country]
/report server [server-or-invite] [country]
/reports list
/reports status report-id
/reports retry report-id
/access redeem key
/access status
/settings country country
/admin key create|list|inspect|revoke
/admin user inspect|suspend|reinstate
Apps -> Report Message
```

Admin commands are visible in every supported context but authorize against the exact
IDs in `DISCORD_ADMIN_USER_IDS`. All command responses, errors, forms, reviews, and
administrative results are ephemeral. Lifecycle DMs are ordinary private bot DMs.

## Report lifecycle

1. Enforce access or configured-admin bypass.
2. Resolve country in this order: a `/report` override, the saved `/settings country` value,
   then Auto. A saved `NULL` country means Auto, including for existing users.
3. Collect the flow-specific reason, elements, target, and a short explanation.
   Profile targets accept only a raw Discord user ID. The bot resolves the account and requires
   confirmation before collecting the report details; unresolved IDs can be retried or cancelled.
4. Encrypt the draft and its OpenRouter conversation at rest with a 30-minute expiry.
5. In one multimodal OpenRouter request, resolve Auto when needed and research a supporting law.
   Then ask `x-ai/grok-4.5` to write a factual report of at most 512 characters that naturally
   names the researched law or provision. Show an ephemeral review with submit, refine, regenerate,
   country-change, manual-edit, and cancel controls.
6. Atomically reserve one credit and create the API report with the interaction ID.
7. Consume the reservation after HTTP 202 or idempotent HTTP 200.
8. Release it after a definite pre-creation rejection; reconcile ambiguous responses with
   the exact body and idempotency key.
9. Poll briefly in the interaction, then let the durable worker continue.
10. On successful submission, DM one complete current report card and persist that Discord
    message ID. Later lifecycle events edit the same card. Receipt updates are silent; final
    accepted/denied outcomes edit the card and send a short plain-text reply to it. Failures before
    Discord returns a report ID use a plain-text DM rather than an embed.
11. If Discord does not confirm receipt within two minutes after returning a report ID, the API
    fails the report with `discord_receipt_timeout`, edits the saved card, and offers the existing
    immutable new-report retry.

Report cards include the target, category, full country name and flag, human reason plus
selected elements, reported details, references, and a simplified milestone history. The API
retains the complete technical timeline. Server metadata and ID-backed profile metadata are
resolved best-effort and captured at submission time. DMs include full report details but omit the
generated reporter identity and email. A Discord 50007 response permanently disables DM
attempts for that tracked report; `/reports` remains available.

## AI report writing

The bot calls OpenRouter directly; the API and low-level Discord client never receive the
reporter's brief, model conversation, or selected image URLs. `OPENROUTER_API_KEY` is required and
`OPENROUTER_MODEL` defaults to `x-ai/grok-4.5`. Provider routing requires zero data retention,
denies provider data collection, and requires structured-output support. The complete generation
workflow is capped at 90 seconds.

Every generation begins with one combined country-selection and legal-research request using the
`openrouter:web_search` server tool. It receives the complete report category, selected elements,
supported country names/codes, reporter explanation, resolved evidence, and selected images.
The prompt prefers one search but allows up to three when results conflict or another supported
country may have a stronger basis. Search uses OpenRouter's standard result settings with no
domain or result-list filter. OpenRouter search counts and URL annotations are retained when
available but are not required for a usable result.

The prompt contains the selected semantic reason, the reporter's brief, and only the useful
resolved target data. Message reports include the accessible message content, author, timestamp,
server/channel context, embed summary, and attachment metadata; image attachments are supplied as
images. Link-based reports fall back to the link and brief when Discord does not allow the bot to
fetch the message. Profile reports include the ID, usernames, display names, and bot status.
When `photos` is selected, the bot supplies both the current avatar and banner when available.
Server icon, banner, invite splash, and discovery splash URLs are supplied only when their matching
elements are selected. Discord's supported bot API does not expose profile About Me text, so the
bot does not claim or attempt to retrieve it.

The review identifies whether the country was Auto-selected, a saved default, or a report
override. The researched law or provision appears naturally inside the 512-character report;
brackets, URLs, footnotes, and separate source fields are not required.
Changing country clears the AI conversation and research before running both again. Refine appends
the instruction and result to the same encrypted conversation and reuses the existing research
with optional web search when the requested change needs new legal facts or challenges Auto's
country. Regenerate starts a new conversation and reruns combined research; Auto may choose a
different country. Manual edits become the current assistant answer so a later refinement
continues from that text, but the researched law reference must remain. Repair also
continues the same conversation, performs no search, and is attempted only once.

Writing, refinement, and repair use OpenRouter reasoning with
`OPENROUTER_WRITER_REASONING_EFFORT` (default `medium`) and exclude reasoning text from responses.
Reasoning, input/output tokens, search requests, request counts, and OpenRouter-reported cost are
accumulated per user in `bot_users` and displayed by `/access status`. Safe logs use a keyed
pseudonymous actor value plus stage, model, latency, usage, cost, and failure category.

If a model result exceeds 512 characters or omits its law reference, the bot asks once for a repair;
a second invalid result is never silently truncated. Insufficient OpenRouter balance, rate limits,
timeouts, malformed output, unsupported Auto countries, and unusable legal research use the safe
AI failure screen. Retry, country override, detail editing, and cancel remain
available. Manual editing is offered only when the encrypted draft already has valid research.
No report is created and no credit is reserved until valid reviewed text is submitted. Drafts hold
the country choice, optional source annotations, research summary, and conversation only until
normal expiry. Logs include pseudonymous actor keys, report flow/category, country mode, selected
element names, evidence/image/attachment counts or lengths, request/response lengths, usage, cost,
latency, and failure category. They never contain raw user IDs, queries, sources, evidence, images,
prompts, research, reports, AI responses, or secrets.

The initial writer prompt contains one generalized report structure plus two style examples. They
appear once in the retained conversation and are explicitly examples of tone and organization,
not reusable facts or legal conclusions. Refine and Repair append compact instructions to that
same conversation instead of adding another copy of the examples.

Message snapshots support ordinary text channels, threads, forum posts, Stage chat, voice-channel
chat, and DMs. A context-menu message can have a valid channel ID while Discord.js has no hydrated
channel object; in that case the snapshot stores a null channel name and preserves the remaining
message evidence instead of failing.

## Access credits

- Whitelisting is enabled unless `WHITELIST_ENABLED=false`.
- Normal users begin with zero credits; configured admins are unlimited.
- A one-use key grants any positive integer number of credits and may have a redemption deadline.
- Plaintext key values are displayed once; only a peppered HMAC and safe prefix are stored.
- Report creation consumes one credit. Status checks and lifecycle retries are free.
- Revoking a redeemed key suspends its user, clears every remaining credit, and deletes
  unsubmitted drafts. Existing reports and lifecycle notifications continue.
- A suspended user cannot redeem a new key. Admin reinstatement returns them with zero credits.

## Operations

The notification worker uses leased PostgreSQL rows and `SKIP LOCKED`, so restarts and additional
replicas can process work safely. Pending creation and submission work polls approximately every
30 seconds; individual polling stops after submission. The API owns the two-minute receipt
deadline and emits a durable failure event if it expires. Signed private webhooks provide fast
delivery, with full 15-minute event-feed reconciliation as a safety net. DMs use a per-attempt
unique `(tracking_id, event_key)` key, persist the successful status-card message ID, and retry
transient failures with a bounded exponential delay.

### Notification decision log

- A successful `report_submitted` event creates the only lifecycle status embed and stores its
  Discord message ID on the tracking row.
- `discord:received`, timeout, and outcome events edit that saved embed instead of sending another
  report card. Receipt is a silent edit. `actioned`, `closed_no_action`, and
  `review_not_approved` additionally send a plain-text reply to the saved card so the user receives
  a new Discord notification.
- Pre-submission failures send plain text plus the retry control. They never create a failure
  embed.
- A missing or user-deleted saved status message is replaced only when Discord had already
  returned a report ID.
- Chosen: persist the message ID on `report_tracking`, keeping Discord delivery metadata in the
  bot database and report lifecycle state in the API database.
- Chosen: enforce the 120-second receipt deadline in the API and make that explicit timeout
  retryable, even though Discord returned a report ID. A late authenticated Discord update
  recovers the timed-out record to submitted and disables further retry from that record.

## Bounded lifecycle polling

### Understanding and assumptions

- Signed webhooks provide immediate lifecycle delivery and the paginated event feed reconciles
  missed webhook deliveries every 15 minutes with one request for all tracked reports.
- Per-report polling is a fallback and must not grow into a high-frequency request stream as the
  report history grows.
- Report history remains available after tracking expires; expiration only stops background
  polling and lifecycle DMs.

### Final design

Active creation states are polled every 30 seconds. Individual polling stops as soon as a report
is submitted; signed webhooks provide immediate updates and the cursor feed provides durable
recovery with a constant baseline of one request every 15 minutes. Each tracking row expires 60
days after its original creation time. Expired rows are excluded from polling, lifecycle-event
ingestion, and notification delivery, while existing report records and user-facing history remain
intact. Existing rows are migrated using their original `created_at`.

Webhook ingestion distinguishes accepted, expired, and not-yet-tracked events. Accepted and
expired events receive HTTP `202`; expired events are intentionally discarded. Only a genuine
creation/linking race receives HTTP `409`, allowing the API outbox to retry without retrying events
that have deliberately aged out.

### Decision log

- Chosen: active-only per-report polling plus webhook/feed delivery and 60-day retention. Silent
  submitted reports perform no report-specific work while retaining immediate updates.
- Rejected: six-hour or age-tiered submitted polling. It duplicates the durable event pipeline and
  continues to scale with unresolved report count.
- Deferred: a batch integrity endpoint. Add it only if production evidence shows report state and
  lifecycle events diverging.
- Rejected: retaining 15-minute per-report polling. It duplicates the event feed and scales
  linearly with unresolved reports.

## Verification timeout and immutable retries

### Understanding and assumptions

- A report must not remain in `awaiting_verification` indefinitely when Discord's verification
  email never reaches the Cloudflare worker.
- The API waits for at most 60 seconds after requesting verification, then marks the report failed
  with `verification_email_timeout` and makes it retryable.
- The API makes the initial verification request and, while the same report is still waiting,
  repeats that same Discord request at 20 and 40 seconds. Every request uses the report's existing
  sticky proxy identity, email alias, and persisted Discord session. Resends never extend the
  original 60-second deadline.
- An email may reach the inbound worker before the initial request job finishes saving its Discord
  session. Persisting the session must therefore preserve an already-recorded
  `verification_received` state rather than moving the report backwards to
  `awaiting_verification`. The same preservation rule applies if mail arrives while a resend is
  refreshing that session.
- A manual retry is free, remains owner/admin protected, and is unavailable to suspended users.
- Each retry creates a new internal report ID, generated identity/email, proxy session, API row,
  bot tracking row, and timeline. The failed report remains immutable and links to its successor.
- A chain is limited to the original report plus two successors. This preserves the existing
  three-attempt safety limit without allowing branches from the same failed report.

### Final design

The initial request transaction schedules two durable `request_code` resend jobs. A resend is a
no-op unless the report is still `awaiting_verification`, has a saved session, and remains inside
its original deadline. This makes restarts safe and stops both resending and report correlation as
soon as mail arrives or the deadline expires. The Cloudflare catch-all itself remains online for
other reports; late mail for the expired alias is recorded as unmatched and cannot revive it.

The API worker sweeps expired verification deadlines every few seconds. Expiration and the
`report_failed` lifecycle event are committed together, so the bot receives a durable failure DM.
The existing retry endpoint creates a successor report transactionally and returns that new report;
idempotent replays return the same successor. The bot creates separate tracking for the successor,
so lifecycle notification keys and polling state cannot collide with the failed report.

Failed report views and failure DMs include a **Retry as new report** button. `/reports retry`
uses the same operation. Both surfaces update to the successor's new report card after creation.

### Decision log

- Chosen: deadline sweep over a permanent timeout job. This avoids expanding the job-kind schema
  and safely recovers deadlines created before a worker restart.
- Chosen: durable same-session resends at 20 and 40 seconds, with a fixed 60-second deadline, over
  in-memory timers or a sliding deadline. This survives restarts without monitoring indefinitely.
- Chosen: session persistence that preserves `verification_received`, because inbound email and
  the request job can finish in either order.
- Chosen: immutable successor rows over resetting a failed row. This preserves audit history and
  gives every manual retry the new ID requested by the product flow.
- Rejected: creating a fresh Discord session for each resend. It could pair an inbound code with
  the wrong session; all resends instead continue from the saved session.

## Access-key presentation and credit accounting

### Understanding and assumptions

- Plaintext access keys are sensitive and remain visible only in the one-time creation response.
- The database UUID is an administrative implementation detail and is omitted from that creation
  response; administrators can obtain it from the key list when inspection or revocation is needed.
- Key list and inspection views identify the redeeming Discord user ID and redemption time, or say
  explicitly that the key is unredeemed.
- Normal report submission reserves and then consumes one credit. Configured admins retain the
  documented unlimited-access bypass, and `WHITELIST_ENABLED=false` intentionally bypasses credits
  for every user.
- Credit reservation remains transactional and suitable for concurrent submissions; no new schema
  or additional external service is required.
- Administrative key views display the immutable number of credits originally granted by a key;
  they are not a live user-balance view.
- Reservation logs record whether the operation was an idempotent replay and the safe numeric
  balance before and after the transaction. Creation logs record the persisted post-creation
  credit state rather than the stale in-memory reservation state.

### Decision log

- Chosen: hide internal IDs only in the one-time generated-key response, preserving the ID in
  administrative list/inspect output because those commands address keys by ID.
- Chosen: render raw Discord user IDs without mentions so administrative output cannot ping users.
- Chosen: preserve the established admin and disabled-whitelist bypass policy. Operators who want
  to exercise credit accounting must test with a non-admin while whitelisting is enabled.
- Chosen: clarify the key grant label and log transactional balance changes instead of adding a
  second balance store or an administrative ledger command without evidence that either is needed.

## Verification resend cleanup

### Understanding and assumptions

- Verification resend jobs are useful only while a report is awaiting its verification email.
- Once a code is accepted, the report times out, or processing fails, pending resend jobs cannot
  help and should not later wake merely to log that they were skipped.
- A resend already claimed by a worker may still finish its status check; this race remains safe.

### Decision log

- Chosen: complete only pending resend jobs in the same transaction that advances or fails the
  report. This removes stale work while preserving claimed-job concurrency and report history.

## Operational lifecycle logging

### Understanding and assumptions

- Railway logs must reconstruct a report from creation through email correlation, Discord
  verification/submission, bot tracking, and notification delivery without database access.
- Expected production volume is modest, but repeated status polling can be noisy; state-changing
  boundaries are logged at `info`, recoverable anomalies at `warn`, and terminal failures at
  `error`.
- Logs may contain internal report, job, event, notification, and tracking IDs. They must never
  contain raw email addresses or messages, verification codes, access-key plaintext/hashes,
  report context, OpenRouter prompts/responses/image URLs/conversation history, proxy credentials,
  encryption material, Discord interaction tokens, or request bodies.
- Logging failures must not affect report processing. A failure while replying to an expired
  Discord interaction is contained and logged rather than escaping the event handler.

### Event vocabulary

- API: `report_create_accepted`, `report_retry_accepted`, `report_job_started`,
  `report_job_stage_started`, `report_job_stage_completed`, `report_job_completed`,
  `report_job_stage_failed`, `report_job_retry_scheduled`, `report_job_failed`,
  `verification_resend_completed`, `verification_resend_skipped`,
  `verification_resend_failed`, `verification_wait_expired`, `discord_receipt_wait_expired`,
  `inbound_email_rejected`,
  `inbound_email_ignored`, and `inbound_email_correlated`.
- Bot: `interaction_failed`, `interaction_error_response_failed`,
  `report_submission_reserved`, `report_submission_created`, and
  `report_submission_observed` or `report_submission_failed`, in addition to the existing polling,
  reconciliation, webhook, and notification events.
- Email worker: `email_rejected`, `email_forward_completed`, and `email_forward_failed`, correlated
  using the same one-way message-ID digest recorded by the API.
- Inbound-email correlation records the parsed email kind, database result, correlated report ID
  when available, and a one-way message-ID digest. It does not record recipient or email content.
- Ignored inbound email records a stable failure classification, sender addresses, sanitized
  subject, and a sanitized 500-character text preview. Email addresses and verification-code
  candidates are redacted, and raw MIME or HTML is never logged.
- Job stage records include duration so an operator can distinguish email delay, Discord network
  delay, and bot polling delay.

### Decision log

- Chosen: explicit lifecycle boundary events over logging response bodies. Bodies contain private
  reporting data and are not needed for correlation.
- Chosen: a short SHA-256 message-ID digest over raw IDs or recipient addresses for duplicate-mail
  investigation without exposing mailbox identifiers.
- Chosen: exact localized verification-template phrases over a language-agnostic six-character
  scan. English, German, and the observed German `Ã¼` decoding variant are accepted without turning
  ordinary body text into a verification code.
- Chosen: a sender-gated subject-ending token as the final fallback for other locales. It requires
  the exact Discord sender, exactly six uppercase alphanumeric characters with at least one letter,
  and subject-final position; numeric references, lowercase prose, non-Discord senders, and generic
  body tokens remain rejected.
- Chosen: send `language: "en"` in the verification-code request body as the primary email-language
  control. Localized parsing remains as defense against Discord ignoring or changing the hint.
- Chosen: contain secondary Discord response errors in the interaction handler so an expired
  interaction cannot terminate the bot process.
- Rejected: logging every successful report-status GET beyond Fastify's existing access log; bot
  state-change and polling logs already provide the useful status signal.

Do not register production commands or enable production reporting workers in pull-request
environments. Use a separate Discord application and mocked API for staging.
