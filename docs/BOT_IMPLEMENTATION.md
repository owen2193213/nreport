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
/report message message-link
/report profile target [server-id]
/report server [server-or-invite]
/reports list
/reports status report-id
/reports retry report-id
/access redeem key
/access status
/settings country country
/admin key create|list|inspect|revoke
/admin user inspect|suspend|reinstate
Apps -> Report Message
Apps -> Quick Report Message
```

Admin commands are visible in every supported context but authorize against the exact
IDs in `DISCORD_ADMIN_USER_IDS`. All command responses, errors, forms, and administrative
results are ephemeral. A report review is ephemeral when DM delivery is cleared; otherwise the
review and its confirmation controls are sent as an ordinary private bot DM.

## Report lifecycle

1. Enforce access or configured-admin bypass.
2. Open one combined report modal shared by all three `/report` flows and
   **Apps -> Report Message**. There is no intermediate setup embed. Use AI and Send review to DMs
   are selected by default. Country starts from the saved
   `/settings country` value or Auto, and the reporter can choose another supported country
   through the paginated picker. A saved `NULL` country means Auto.
3. Collect the flow-specific elements in that modal. Report fields appear first; country and the
   AI/DM preferences appear below them. Category and explanation are optional in the AI flow: their
   help text says that AI fills a blank field when Use AI is enabled.
   Both are validated as required when Use AI is cleared.
   Profile targets accept only a raw Discord user ID. The bot resolves the account and requires
   confirmation before collecting the report details; unresolved IDs can be retried or cancelled.
   The profile's optional observed server and the server report's optional server/invite remain
   slash-command parameters. A server report without either a slash target or current server is rejected.
4. Encrypt the draft and its OpenRouter conversation at rest with a 30-minute expiry.
5. Run an adaptive OpenRouter research completion. It conditionally searches unfamiliar evidence
   terminology first, resolves only omitted Auto fields after the meaning is clear, then searches
   for and confirms the country-specific law. Invalid structured data causes one fresh research
   attempt from the original evidence. The final writer receives only compact resolved evidence and
   research context. When DM delivery is selected, the Researching stage creates one structured
   report card in DMs; Writing, Refining, Regenerating, review, submission, and resubmission edit
   that same message. The ephemeral interaction points to the DM and remains the fallback if DM
   delivery fails. When DM delivery is cleared, the same cards remain ephemeral. Then ask
   `deepseek/deepseek-v4-flash` to write a factual report of at most 512 characters that naturally names
   the researched law or provision.
6. Atomically reserve one credit and create the API report with the interaction ID.
7. Consume the reservation after HTTP 202 or idempotent HTTP 200.
8. Release it after a definite pre-creation rejection; reconcile ambiguous responses with
   the exact body and idempotency key.
9. Poll briefly in the interaction, then let the durable worker continue.
10. When Send review to DMs is selected, persist the drafting DM's message ID and turn that same
    message into the review and then the complete current report card. Later lifecycle events edit
    the same card, so drafting, review, and submission do not create duplicate DMs. Clearing
    the option durably suppresses that report's lifecycle DMs and shows the complete status in the
    ephemeral interaction instead. Receipt updates are silent; final
    accepted/denied outcomes edit the card and send a short plain-text reply to it.
11. If Discord does not confirm receipt within two minutes after returning a report ID, the API
    fails the report with `discord_receipt_timeout`, edits the saved card, and offers the existing
    immutable new-report retry.
12. If Discord closes the original report without action and supplies a review link, the API
    encrypts the link and automatically submits one appeal through a fresh proxy session in the
    report's selected country. The original sticky IP and Discord session do not need to remain
    valid; the bot never receives the link, token, or a Discord account authorization credential.
13. A successful appeal POST is authoritative. The API waits two minutes for the review-request
    confirmation email; a missing email becomes an explicit unconfirmed diagnostic and never
    submits the appeal again. A network-ambiguous appeal POST is likewise not retried.
14. If Discord denies the appeal, the report card exposes **Resend same report** and
    **Rewrite & resend**. The rewrite path uses the existing AI drafting workflow, remains
    editable and review-first, enforces 512 characters, creates a fresh linked report, and does
    not reserve another credit.

Draft and report cards share Item, Status, Category, Country, code-blocked Details, AI decisions,
References, Dates, and Appeal. Submitted cards add Retry, Resubmission, errors, and History when applicable.
There is no separate Reason field because the reviewed report text is the clearer Details value. Interaction embeds replace
the timeline with `Check your DMs for the full status log.` The DM card uses relative Discord
timestamps and compresses the API timeline into user-facing phases: submission, the original
Discord result, appeal submission, and the appeal result. Request, verification, receipt, and queue
transport events are deliberately hidden. The latest stage or final outcome is bold while its
timestamp remains unbolded. Original results and appeal results are explicitly distinguished, such
as `Original report: Closed without action` followed by `Appeal denied — Discord upheld no action`.
Up to the three latest retry attempts are summarized; the API remains the source of truth for older
attempts and the complete technical timeline. History is not wrapped in a code block, so Discord
renders each timestamp. Verification codes are never displayed.
Only submission, failure, receipt, and final-result notifications edit the saved DM card; internal
transitions remain available from the API without causing an embed edit for every event. The API
retains the complete technical timeline. Server metadata and ID-backed profile metadata are
resolved best-effort and captured at submission time. DMs include full report details but omit the
generated reporter identity and email. A Discord 50007 response permanently disables DM
attempts for that tracked report; `/reports` remains available.

## Quick report

**Apps -> Quick Report Message** reports the targeted message immediately, with no modal, review,
or confirmation. Access and credit enforcement are identical to the normal flow. The bot builds an
all-Auto draft from the target message: country is the saved `/settings country` default when set,
otherwise Auto, and category and report text are always decided by the AI writer. The interaction
answers ephemerally with a single "Quick report started" notice; nothing else is shown in chat.
Writer progress, submission progress, and the final report card are delivered in one DM message
that is edited in place and registered as the tracked status card, so later lifecycle events edit
the same message. A writer failure keeps the encrypted draft and DMs the error card with the usual
Retry / Change country / Edit details / Cancel recovery controls. A definite pre-creation rejection
releases the reservation and DMs the same recovery card; an ambiguous failure keeps the reservation
for reconciliation and DMs the error without retry controls. When DM delivery is blocked, the
ephemeral interaction becomes the fallback surface for progress and results.

## AI report writing

The bot calls OpenRouter directly; the API and low-level Discord client never receive the
reporter's brief, model conversation, or selected image URLs. `OPENROUTER_API_KEY` is required and
`OPENROUTER_MODEL` defaults to `deepseek/deepseek-v4-flash`. The same configured model handles adaptive
research, writing, refinement, and repair. Every stage requires zero data retention, denies provider
data collection, requires support for every requested parameter, and dynamically sorts eligible
providers by throughput. Research and
report calls use strict JSON Schemas, and the bot also validates returned values locally. The complete generation workflow is
capped at 90 seconds.

Generation normally starts with one adaptive interpretation-and-research completion. Its output schema is
dynamic: fixed country, category, and reason values remain application-owned and are not requested
from the model; only missing Auto fields are returned alongside the law reference and summary. This
prevents AI echoes from changing supplied values. A case-insensitive literal `Auto` in the reason
field is normalized to omitted. The active flow's category catalog is supplied only when category
is Auto. Auto country results accept an exact supported code or defensively normalize a supported
English country name before validation.
The internal law reference has no length limit; validation distinguishes an invalid country,
missing reference, and missing research summary.
The prompt asks for only the essential legal relevance in a concise research summary without
hard-capping research output tokens. OpenRouter's web plugin performs one Parallel search with at
most two results. The model uses that search to clarify an unfamiliar, coded, ambiguous, or
context-dependent evidence term only when its meaning could materially affect classification or
legal relevance, and to confirm the relevant current law and provision. With explicit evidence it
focuses directly on the law. Category-catalog labels and unrelated categories are forbidden as
search terms. No domain filter is imposed. URL annotations are retained when available but remain
optional.
The plugin receives a custom search-results prompt that treats results as untrusted source material,
aligns them with the terminology-and-law workflow, and forbids Markdown citations in the JSON. This
replaces OpenRouter's default results prompt and avoids injecting unrelated formatting instructions.
The request does not send the beta `openrouter:web_search` server tool, `tool_choice`, or
`max_tool_calls`: repeated production requests reached OpenRouter's `server_tools` pipeline and
returned HTTP 404 before any provider completion. Research retains ZDR, denied data collection, and
required-parameter routing so OpenRouter selects an endpoint compatible with the strict schema and
plugin request. The plugin runs once by request contract, while
`usage.server_tool_use.web_search_requests` belongs to server-tool accounting and may be absent from
plugin responses. The bot records that value when present but never treats its absence as a research
failure. If completed research is malformed, the bot makes exactly one fresh research request from
the original evidence with a short failure reason. It never includes the failed model response in
that retry. No fallback model is used.
Writing, refinement, and repair use the same ZDR, denied-data-collection, required-parameter, and
throughput-sorted provider policy.

The AI integration intentionally remains bot-local and single-model. It assumes normal interactive
bot traffic, keeps the existing 90-second workflow budget, records the cost of every attempted
OpenRouter request, and adds no fallback model, local search executor, queue, database table, or
background worker or separate search API key. Media processing remains disabled.

The research prompt contains the supplied or Auto-selectable semantic reason, reporter brief, and
only useful resolved target data. Message reports include the accessible message content, author, timestamp,
server/channel context, embed summary, and attachment names/content types. Link-based reports fall
back to the link and brief when Discord does not allow the bot to fetch the message. Profile
reports include the ID, username, global display name, and bot status. A supplied server ID remains
report context, but a user-installed-only bot does not attempt to resolve server-member profiles
from it. Selecting profile photos or server media records the selected report element, but no media
or media URL is sent to OpenRouter while processing is disabled. Discord's supported bot API does not expose profile About Me text,
so the bot does not claim or attempt to retrieve it.

AI media processing is temporarily disabled for every report category. No images, GIFs, videos,
avatars, banners, server art, or attachment/embed media URLs are attached or included in
OpenRouter requests. This prevents child-safety media, gore, and other potentially prohibited
media from reaching the provider. Attachment names and content types may remain as factual text
metadata. This is intentionally conservative even though OpenRouter supports multimodal inputs
for compatible models.

The shared combined report modal enables Use AI and Send review to DMs by default and lets the
reporter use Auto, their saved/current country, or the paginated country picker. Report category,
flow-specific elements, and report details appear before country and preferences. Category and
details are optional, use the placeholder `Auto`, and explain that AI fills a blank field when Use
AI is enabled. When Use AI is cleared, interaction validation requires both category and
final report text and performs no OpenRouter
request, and shows the normal review with Submit, Edit manually, Change country, and Cancel.
Refine and Regenerate are omitted. Because Auto country selection requires AI, a manual report
with no saved country must select a country before review. The message context-menu command opens
the same combined modal with the selected-message target as the slash flow.

The review has no submission disclaimer and uses the shared draft/report field structure. Auto
country is labeled `Auto-selected` without naming the model. The researched
law or provision appears naturally inside the 512-character report;
brackets, URLs, footnotes, and separate source fields are not required.
The structured `lawReference` and final report name the country, clear full law title, and
provision instead of relying on an unexplained abbreviation or section number. The internal
`lawReference` is required but has no report-length limit; only the submitted report is capped at
512 characters.
Every AI-enabled drafting card includes an `AI decisions` field. During work it shows the observable
parameters still being resolved. After completion it records the operation time and concise
before/after values for country, category, and details handling, for example `Country: Auto →
Germany`. It never exposes model reasoning, prompts, evidence, sources, or report text. Generate,
refine, regenerate, and rewrite decisions are retained as a five-entry bounded log in the encrypted
draft and copied into bot-owned report tracking so later lifecycle DM edits can still display the
latest three entries after draft deletion. Manual reports explicitly say that AI was disabled.
After research, the writer receives a compact context containing only evidence, resolved category,
reason, country, law reference, and legal summary. It does not receive the supported-country list,
category catalog, search instructions, or raw research transcript. This compact context is retained
for refinement. Changing country clears the AI conversation and research before running both again. Refine appends
the instruction and report-only result to the same encrypted conversation and reuses the existing
research without web search or country changes. Regenerate starts a new conversation, resolves any
missing Auto fields, and reruns research; Auto may choose a
different country. Manual edits become the current assistant answer so a later refinement
continues from that text. Repair also
continues the same conversation, performs no search, and is attempted only once.

Every stage enables reasoning without an effort override and excludes reasoning text from
responses. Report-producing calls send `max_completion_tokens: 4096`; the reviewed report itself
remains limited to 512 characters. OpenRouter dynamically sorts eligible ZDR endpoints by current
throughput and retains availability fallbacks. The model is told
to return raw JSON without Markdown, and OpenRouter receives a strict JSON Schema containing only
the fields that stage owns. The parser also accepts one whole-response `json` code fence defensively
before applying local semantic and 512-character validation.
Reasoning, input/output tokens, search requests, request counts, and OpenRouter-reported cost are
accumulated per user in `bot_users` and displayed by `/access status`. Safe logs use a keyed
pseudonymous actor value plus stage, model, latency, usage, cost, and failure category.

If a report-writing result is empty, malformed, or exceeds 512 characters, the bot asks once for a repair.
If the repaired result is still invalid, the encrypted draft retains the latest AI text and
conversation. The manual-edit modal shows the AI draft in a copyable read-only text display and
provides a separate required 512-character input. Drafts already within the limit prefill that
input; overlength drafts leave it blank for the user to shorten and paste. Insufficient
OpenRouter balance, rate limits, timeouts, malformed output, unsupported Auto countries, and
unusable legal research use the safe AI failure screen. Errors identify legal research, writing,
refinement, or repair as the failed stage. Retry, country override, detail editing,
manual editing when candidate text is available, and cancel remain available. The bot asks AI
to include the researched law but does not reject reviewed text for omitting it or attempt to
verify that the law exists.
No report is created and no credit is reserved until valid reviewed text is submitted. Drafts hold
the country choice, optional source annotations, research summary, and conversation only until
normal expiry. Logs include pseudonymous actor keys, report flow/category, country mode, selected
element names, evidence/image/attachment counts or lengths, request/response lengths, usage, cost,
latency, media-allowed status, and failure category. They never contain raw user IDs, queries,
sources, evidence, images, prompts, research, reports, AI responses, or secrets.
Failed OpenRouter requests opt into router metadata and log only an allowlisted diagnostic summary:
error type/code, categorized message, provider code, retry delay, routing strategy/attempt, endpoint
counts, provider names, per-provider attempt statuses, server-tool pipeline stage names, and the
OpenRouter generation ID needed for a provider-side post-mortem. Raw error messages, pipeline data,
summaries, and response bodies are never logged.

The initial writer prompt contains one generalized report structure plus two style examples. They
appear once in the retained conversation and are explicitly examples of tone and organization,
not reusable facts or legal conclusions. Refine and Repair append compact instructions to that
same conversation instead of adding another copy of the examples.
The writer system prompt, initial writer prompt, and the Refine and Repair instructions all
require the report text to be written entirely in English.

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

- Understanding: one user-owned DM card must explain drafting choices and lifecycle outcomes without
  exposing internal transport noise or hidden model reasoning. Normal interactive scale and the
  existing PostgreSQL deployment are assumed; the API contract and submission semantics are out of
  scope.
- Chosen: persist a bounded, non-sensitive AI decision summary in bot `report_tracking`. Keeping it
  only in the encrypted draft would lose it after submission; adding it to the API request would
  cross the bot/API ownership boundary without improving report processing.
- Chosen: acknowledge a DM-enabled modal with only `Check your DMs.` Discord interactions still need
  a completed response, so sending no acknowledgement is not reliable.
- Chosen: render phase-based history and bold only the current/final stage text, leaving Discord's
  relative timestamp outside the bold span. The API retains the complete event history for
  diagnostics.

- API creation immediately creates the lifecycle status embed and stores its Discord message ID
  on the tracking row.
- `discord:received`, timeout, and outcome events edit that saved embed instead of sending another
  report card. Receipt is a silent edit. `actioned`, `closed_no_action`, and
  `review_not_approved` additionally send a plain-text reply to the saved card so the user receives
  a new Discord notification.
- `review_requested`, `review_received`, `review_confirmation_timeout`,
  `review_request_failed`, `review_ineligible`, and `review_request_ambiguous` update the same saved
  card. A missing confirmation explicitly says that the appeal was not sent again. Discord error
  `521004` is shown as **DSA report ineligible for review**, not as a generic automatic-appeal
  failure, and does not expose resend controls.
- Pre-submission failures edit the same full report embed and add the retry control when the API
  marks the failure safe to retry.
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
- Safe manual retries have no numeric ceiling. Ownership, suspension, idempotency, rate limiting,
  immutable predecessor/successor links, and the API's `retryable` flag still prevent unsafe
  retries or branches from the same failed report.

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

Final denied-review views instead include **Resend same report** and **Rewrite & resend**.
Resend uses the stored report input unchanged. Rewrite opens a guidance modal, seeds a new
reviewable draft from the denied report, and calls the same successor endpoint with only the
edited `reportReason` and `context`. The predecessor permits one successor branch, preserving the
same immutable audit relationship as failure retries.

### Decision log

- Chosen: deadline sweep over a permanent timeout job. This avoids expanding the job-kind schema
  and safely recovers deadlines created before a worker restart.
- Chosen: durable same-session resends at 20 and 40 seconds, with a fixed 60-second deadline, over
  in-memory timers or a sliding deadline. This survives restarts without monitoring indefinitely.
- Chosen: session persistence that preserves `verification_received`, because inbound email and
  the request job can finish in either order.
- Chosen: immutable successor rows over resetting a failed row. This preserves audit history and
  gives every manual retry the new ID requested by the product flow.
- Chosen: the same immutable successor model for a denied appeal. Resubmission remains explicit
  user action even though the preceding eligible appeal is automatic.
- Rejected: creating a fresh Discord session for each resend. It could pair an inbound code with
  the wrong session; all resends instead continue from the saved session.

## Access-key presentation and credit accounting

### Understanding and assumptions

- Plaintext access keys remain visible only in the one-time creation response.
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
- Logs may contain internal report, job, event, notification, and tracking IDs, report state,
  country, flow, category, selected elements, counts, lengths, timings, and diagnostic error
  classifications. They must not contain credentials, verification codes, access-key plaintext,
  encryption material, Discord interaction tokens, or raw email.
- Logging failures must not affect report processing. A failure while replying to an expired
  Discord interaction is contained and logged rather than escaping the event handler.

### Event vocabulary

- API: `report_create_accepted`, `report_retry_accepted`, `report_job_started`,
  `report_job_stage_started`, `report_job_stage_completed`, `report_job_completed`,
  `report_job_stage_failed`, `report_job_retry_scheduled`, `report_job_failed`,
  `verification_resend_completed`, `verification_resend_skipped`,
  `verification_resend_failed`, `verification_wait_expired`, `discord_receipt_wait_expired`,
  `review_confirmation_wait_expired`, `review_link_resolution_retry_scheduled`,
  `review_link_resolution_failed`, `review_link_resolved`, `review_request_submitted`,
  `review_request_failed`, `review_ineligible`, `review_request_ambiguous`,
  `review_report_id_mismatch`,
  `inbound_email_rejected`,
  `inbound_email_ignored`, and `inbound_email_correlated`.
- Bot: `interaction_failed`, `interaction_error_response_failed`,
  `report_submission_reserved`, `report_submission_created`, and
  `report_submission_observed` or `report_submission_failed`, in addition to the existing polling,
  reconciliation, webhook, and notification events.
- Email worker: `email_ignored`, `email_forward_started`, `email_forward_completed`, and
  `email_forward_failed`. Forwarding events use the same one-way message-ID digest recorded by the
  API; ignored events record only the routing reason.
- Discord delivers verification mail through multiple SMTP envelope formats, including
  `postmaster@*.discord.com` and bounce addresses at `mail.discord.com`, even though the parsed
  message sender is `noreply@discord.com`. The worker accepts any local part only at the exact
  `discord.com` domain or its true subdomains; the API retains the exact parsed-sender check.
- Inbound-email correlation records the parsed email kind, database result, correlated report ID
  when available, and a one-way message-ID digest. It does not record recipient or email content.
- Original closure emails use the trusted HTML `here` anchor associated with Discord's review
  sentence as the appeal-link source. The plain-text URL is fallback-only because MIME text
  conversion can corrupt the opaque signed tracking value while leaving the URL structurally valid.
- Ignored inbound email records a stable failure classification, sender addresses, sanitized
  subject, and a sanitized 500-character text preview. Email addresses and verification-code
  candidates are redacted, and raw MIME or HTML is never logged.
- Job stage records include duration so an operator can distinguish email delay, Discord network
  delay, and bot polling delay.
- Appeal diagnostics identify the exact stage, job attempt, flow, country, fresh-proxy use, HTTP
  status, Discord error code and bounded response summary, retry delay, safe network-cause
  classification, duration, token length/segment count, report type and text lengths, and safe
  target shape such as message scope/age or selected-element count. They also record explicitly
  that no Discord account authorization is sent. They never include the review URL or token,
  target ID, generated email, authorization, cookies, IP address, proxy session ID, or proxy URL.

### Decision log

- Chosen: create one DM report card at the first drafting stage and reuse its message ID through
  review, submission, resubmission, and lifecycle notifications. Separate progress and review DMs
  were rejected because they fragment one report across multiple messages; a new database mapping
  was rejected because the encrypted draft and existing tracking message ID already provide the
  required handoff.
- Chosen: prefer the eligible closure email's trusted HTML review anchor over its generated
  plain-text representation, while retaining text-only compatibility. Selecting by URL length or
  decoding Discord's opaque `upn` value would be brittle and cross the transport boundary.
- Chosen: emit one self-contained, redacted structured record for each appeal boundary and terminal
  result. Raw request/response dumps were rejected because review tokens, account credentials,
  cookies, and proxy credentials must remain unavailable to Railway logs.
- Chosen: classify exact Discord API code `521004` as the terminal `ineligible` review state. Reusing
  `request_failed` was rejected because it conflates Discord eligibility with transport/API faults;
  automatic or user-triggered resubmission was rejected to avoid looping an explicitly ineligible
  report.
- Chosen: use `deepseek/deepseek-v4-flash` for research, writing, refinement, and repair. A single
  configurable model keeps prompts, usage accounting, deployment configuration, and failure
  behavior consistent.
- Chosen: filter every AI stage to ZDR endpoints that deny data collection and support every
  requested parameter, then use OpenRouter's dynamic throughput sort. A fixed provider order was
  rejected because endpoint performance and availability change over time.
- Chosen: use OpenRouter's web plugin with the Parallel engine and require its one search, with two
  results and bounded retrieval context. Strict JSON Schema and required-parameter routing prevent
  a provider from silently ignoring the search or structured-output contract.
- Chosen: keep supplied country/category/reason values application-owned and omit them from dynamic
  model output schemas. One adaptive research completion conditionally clarifies terminology,
  resolves only missing fields, and confirms the law. This avoids a separate classification call
  and lets terminology inform Auto classification.
- Chosen: hand the writer a compact resolved context instead of replaying the research prompt and
  response. This avoids resending country lists, category catalogs, and tool instructions.
- Chosen: retry completed research exactly once when its structured output is invalid. Missing
  server-tool search accounting remains telemetry only because plugin-backed search runs by request
  contract. The retry starts from the original evidence and a categorical failure reason, never the
  failed response body.
- Rejected: OpenRouter's beta `openrouter:web_search` server-tool pipeline after repeated production
  HTTP 404 responses before provider completion. Also rejected direct Parallel or Exa integration,
  a Perplexity fallback, provider pinning, and an unbounded client-side tool loop; they add keys,
  cost, or operational state without being required for this report workflow.
- Chosen: validate only the Cloudflare envelope domain (`discord.com` or a true subdomain) and the
  generated recipient shape in the email worker. The API remains the sole MIME parser and exact
  visible-sender validator, avoiding duplicated checks for Discord's changing bounce formats.
- Chosen: lifecycle boundary events plus structured operational metadata over logging response
  bodies. The structured fields are sufficient for correlation without making logs unwieldy or
  risking accidental credential disclosure.
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
