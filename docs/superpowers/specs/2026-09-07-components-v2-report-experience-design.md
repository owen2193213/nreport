# Components V2 Report Experience Design

## Outcome

Replace the account-owned bot's minimal report embeds and raw-input forms with the approved Discord
Components V2 report experience. The bot owns presentation, interaction sequencing, notification
preferences, target enrichment, and edit coalescing. The API remains authoritative for report
preparation, generated identity, verification, Discord submission, decisions, automatic appeals,
hard recovery eligibility, credits, and durable history.

This design supersedes the report-review, resend-as-is, ineligible-retry, and per-event status-edit
parts of older design documents. It does not restore the legacy bot or move API-owned work into the
bot.

## Entry points and submission

- **Quick Report Message** is final consent. It captures the selected message and immediately calls
  report creation with `useAi: true`. It opens no modal, target preview, confirmation card, or AI
  review.
- **Report Message** opens the report modal directly. There is no target-preview component before
  it.
- `/report message`, `/report profile`, and `/report server` open the same flow-specific report modal
  directly.
- Submitting the report modal immediately creates the API report. There is no generated-report
  review modal or review card after AI preparation.
- All interaction replies remain ephemeral. The persistent status card is an ordinary private DM.

## Report modal

The modal uses Discord's current modal components: `Label`, `RadioGroup`, `StringSelect`, and
`TextInput`. It does not use legacy action-row-wrapped text inputs.

The fields are:

1. **How should this report be written?** — a two-option radio group:
   - **Use AI** — “AI chooses any blank fields, researches the law, and writes the report.”
   - **Write it myself** — “You must provide the country, category, and exact final report text.”
2. **Why are you reporting this?** — a flow-specific category dropdown. It is optional so blank is
   Auto only when Use AI is selected. The bot never sends a literal `"Auto"`; omission is the API's
   Auto value.
3. A required multi-select for profile or server reports only:
   - **Which profile elements are unlawful?** with the contract's profile element catalog.
   - **Where does the unlawful content appear?** with the contract's server element catalog.
4. **Report details** — one paragraph input. In AI mode it is optional evidence or guidance. In
   manual mode it is the exact final report text and must contain 1–512 characters.
5. **Country** — an optional two-letter country-code input with no minimum length at the Discord
   component layer. Blank means Auto in AI mode. Manual mode requires a supported two-letter code.

The bot validates mode-dependent requirements after submission and validates supplied countries and
categories against `GET /v1/discord/dsa/catalog`. Optional inputs must not declare a Discord
`min_length`, preventing the current blank-country validation bug. Modal titles may use
`@username` when the initiating interaction already provides it, but target identity is not a
separate modal step.

## Target context

The bot captures a minimal encrypted `TargetDisplayContext` while it resolves the target. It is
presentation data, not API ownership data:

- Message: author display name, literal `@username`, avatar URL, human/bot type, short sanitized
  message excerpt, channel/server label, posted time, and attachment count.
- Profile: display name, literal `@username`, avatar URL, human/bot type, user ID, observed server
  when available, selected profile elements, and capture time.
- Server: server name, icon URL, server ID or invite target, description excerpt, member/presence
  counts when available, selected server elements, and capture time.

Message resolution deliberately excludes replied-to or referenced-message content. Existing
`referencedMessage` contract fields are removed so that reference context cannot silently re-enter
AI evidence or the card.

The target display context is encrypted in the bot database and inherited by linked replacement
reports. If it is unavailable, the bot derives a reduced, URL-free fallback from the API's sanitized
`ReportDetail.target`. The API continues stripping avatar, attachment, banner, embed, and server
media URLs from public report responses.

## Persistent Components V2 status card

Every tracked case has one persistent DM status card. The message sets
`MessageFlags.IsComponentsV2` and uses a `Container` with `Section`, `Thumbnail`, `TextDisplay`,
`Separator`, and an action row when recovery is available. Components V2 payloads do not also send
`content` or `embeds`.

The card contains only:

- the user-facing status title, concise explanation, and status mark;
- a target section with the target avatar/server icon, name, literal `@username` where applicable,
  safe excerpt, and the small set of flow-specific metadata above;
- category, country, and AI/manual report type once known;
- **Report sent to Discord**, containing only `ReportDetail.finalText` in an escaped code block;
- condensed milestone history; and
- recovery buttons only when the fresh API state authorizes them.

The bot must never build the report-text code block by joining target metadata, message content,
`@username`, user ID, server information, category, country, or report description. The rendering
function accepts `finalText: string | null` separately and renders that value only. The API already
returns the AI-written text as `ReportDetail.finalText` after preparation; before then the section is
omitted.

Information intentionally cut from the default card:

- account ID, credit state, raw API enum values, full internal/Discord report IDs, and provider data;
- research summary and source list;
- repeated descriptions that duplicate the final report;
- every low-level lifecycle event; and
- replied-to message context.

IDs remain available through `/reports status` diagnostics when operationally necessary, but do not
dominate the persistent card.

## Visible lifecycle states

Internal preparation states are grouped to prevent noisy copy and rapid edits:

- `queued`, `planning`, `researching`, `writing` → **Preparing report**.
- `requesting_verification`, `awaiting_verification`, `verification_received`, `verifying`,
  `submitting` → **Submitting report**.
- `submitted` with no later Discord outcome → **Report submitted**.

Decision titles are explicit and never use a generic denied/accepted label:

- **Report accepted** — Discord actioned the original report before an appeal lifecycle.
- **Report denied** — Discord closed the original report without action and the automatic appeal is
  pending.
- **Appeal accepted** — `reviewStatus` is `approved`, or Discord actioned the report after a recorded
  appeal submission.
- **Appeal denied** — `reviewStatus` is `not_approved` or Discord returns
  `review_not_approved`.

Timeouts are terminal and distinct:

- **Report unconfirmed** — Discord did not confirm the report within 2 minutes; the reported message
  may have been deleted or become inaccessible. Do not retry automatically and show no resend-as-is
  action.
- **Appeal unconfirmed** — Discord did not confirm the appeal within 2 minutes. Do not retry
  automatically and show no resend-as-is action.
- **Appeal unavailable** — Discord returned ineligible. Show no resend-as-is action and no appeal
  retry.

## Card update coalescing

The bot uses one durable card-update job per case, not one Discord edit per lifecycle event.

- Event ingestion records the event idempotently and marks the case's card dirty.
- A single worker claims a case with row locking.
- Non-terminal changes are debounced for 2 seconds and spaced at least 5 seconds after the prior
  Discord edit.
- Terminal decisions, timeouts, and failures may bypass the spacing delay.
- The worker fetches the newest authoritative report immediately before rendering.
- It hashes the visible Components V2 JSON and skips the Discord edit when the hash is unchanged.
- If a newer event arrives while an edit is in flight, only the newest state is rendered on the next
  run; intermediate states are not replayed.
- Relative-time-only changes never schedule an edit.

This specifically prevents separate rapid edits for “Submitting report” and “Awaiting verification
email.” Buttons acknowledge and enqueue work; they do not produce disable/working/done edits in
quick succession.

## Decision and problem DMs

Progress never sends a new DM. It only updates the persistent card. Separate compact Components V2
DM replies are reserved for decisions or problems requiring awareness/action.

Notification preferences are:

- decision DMs: on by default;
- original report-denied DM: off by default because the automatic appeal continues;
- problem/action-required DMs: on by default;
- daily digest: off by default; and
- weekly digest: off by default.

With decision DMs enabled, report accepted, appeal accepted, and appeal denied send distinct compact
replies after the persistent card is updated. Report denied sends a reply only when its separate
preference is enabled. Appeal denied is not suppressed by the report-denied default. Compact replies
contain the exact outcome, category, target name/`@username`, and one action sentence; they do not
repeat the full report text or target evidence. `allowedMentions: { parse: [] }` prevents pings.

## Appeal-denial recovery

Only a fresh appeal-denied state exposes these actions:

- **Rewrite with AI** — no modal. The bot immediately requests a linked replacement. The API copies
  the immutable target/evidence, clears prior country/category/description choices, and runs a new
  autonomous preparation allowed to select a different country, category, and law.
- **Edit manually** — opens one modal containing category, country, the profile/server element
  multi-select when applicable, and complete final report text. Submitting immediately requests a
  linked replacement.

There is no **Resend as is** action. An ineligible appeal exposes neither resend-as-is nor these
appeal-denial actions unless a future specification explicitly authorizes them.

The API enforces ownership, terminal appeal-denied state, one-successor linkage, cooldown, credit
rules, allowed fields, and idempotency. The bot owns button availability, modal construction,
display-context inheritance, and status-card reuse.

The AI rewrite receives this internal instruction in addition to the original evidence and prior
prepared result:

> Discord denied the automatic appeal, but no explanatory denial reason was provided. Re-evaluate
> the original evidence independently. Write a materially improved replacement report and choose
> the strongest supported country, category, and legal reference; these may differ from the prior
> report. Do not invent a denial reason, new evidence, or facts not present in the captured target.

The API stores only the decision state, not an explanatory denial reason, so prompts and UI copy must
not imply that one exists.

## Verification

Automated tests must prove:

- report-category and element selections use modal dropdowns and supplied Auto fields are omitted;
- optional country accepts blank in AI mode, while manual mode rejects blank or unsupported values;
- Quick Report and modal submission call create immediately and never create a review step;
- referenced-message context is absent from captured evidence and AI prompts;
- target context is encrypted locally, inherited by a successor, and never concatenated with
  `finalText`;
- all status/decision/timeout classifications and exact recovery-button rules are correct;
- report-denied notifications default off while appeal-denied notifications default on;
- rapid event sequences produce at most one non-terminal visible edit, identical payloads produce
  no edit, and a terminal decision is not delayed;
- report and appeal confirmation timeouts never retry automatically;
- ineligible responses expose no resend-as-is or appeal retry;
- autonomous AI rewrite may change country/category/law and never claims a denial explanation; and
- manual replacement keeps target/evidence fixed while accepting only the editable fields.

After TypeScript changes, run root lint, workspace typecheck, tests, build, and high-severity audit as
required by the repository guide.
