# Discord Command UI Design

## Understanding summary

- Replace raw command text with a consistent, Discord-native embed system.
- Let users browse their reports one at a time with stateless Previous/Next buttons.
- Show one current status, human reason, country, timestamps, and shortened identifiers.
- Keep every interaction result ephemeral; lifecycle notifications remain private DMs.
- Include full report details in private lifecycle DMs while omitting generated identity data.
- Support dozens of reports without keeping pagination sessions in memory.

## Assumptions

- One detailed report per page is more useful than a dense table of identifiers.
- The API report list is small enough to re-fetch on a page click.
- Discord IDs and internal report IDs remain available in code formatting for support workflows.
- Existing ownership and administrator authorization checks remain authoritative.

## Final design

`ui.ts` owns reusable embed builders for reports, access, settings, administration, errors,
draft review, country selection, transient submission state, and lifecycle DMs. Status colors
and labels are derived from semantic API states rather than displayed as raw enum values.

`/reports list` renders a single report card and navigation row. Button IDs contain only the
requested page number; each click re-fetches the invoking user's reports and clamps the page.
This remains correct after restarts and does not persist UI sessions. Empty lists use the same
embed language without pagination controls.

Admin key lists use compact embed fields and remain bounded by the database query limit.
One-time plaintext keys stay in ephemeral embed descriptions. Errors use a red embed with a
safe concise message. Report cards consistently show target, category, country, combined
reason/elements, reported details, one status, references, and a user-facing milestone history.
Verification and submission internals remain available in the API timeline but collapse into
Created, Submitted, Received, and Outcome stages in Discord. Notification titles carry the new
status without repeating it in separate Progress or Discord review fields.

Profile reporting uses one required `target` string containing a Discord username or raw user ID.
Display names and mentions are rejected. Snowflake-shaped IDs are resolved and shown in an
ephemeral confirmation with Report This Account, Use as Username, and Cancel actions. Failed
lookup adds a retry action.
Resolved public profile metadata is captured in the encrypted draft and API JSON report input,
so no relational migration is required and later account changes do not rewrite report history.

## Alternatives considered

- Multi-report table embed: compact, but recreates the difficult-to-scan raw list.
- Select-menu report browser: scalable, but internal IDs are poor option labels and select
  options are limited to 25.
- Stateful collectors: flexible, but break across deployments and add unnecessary cleanup.

## Decision log

- Selected one report per page for clarity and readable mobile layouts.
- Selected stateless button pagination for restart safety and low maintenance.
- Selected shared embed builders so every command uses the same status vocabulary and colors.
- Retained ephemeral interaction replies and adopted full-detail private lifecycle DMs as requested.
- Selected signed webhook delivery plus periodic reconciliation for fast, recoverable updates.
- Retained low-frequency submitted-report polling so webhook or reconciliation outages do not
  suppress lifecycle DMs.
- Selected semantic milestone history while retaining the complete API event log.
- Selected explicit confirmation for snowflake-shaped profile targets because numeric usernames
  and Discord IDs are otherwise ambiguous.
