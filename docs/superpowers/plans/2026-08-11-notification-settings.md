# Granular Notification Settings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let each reporter control lifecycle DM categories and choose Off, Daily, Weekly, or Monthly digest frequency through `/settings notifications`.

**Architecture:** Notification preferences live only in the bot database. API lifecycle events continue to be ingested and deduplicated unchanged; the notifier checks current preferences immediately before delivery, so changing a setting affects already queued but unsent notifications. Report-specific `dm_enabled` remains an additional restriction and granular settings never change report tracking or reconciliation.

**Tech Stack:** TypeScript 6, PostgreSQL, discord.js 14, Vitest 4.

## Global Constraints

- All lifecycle settings default to enabled to preserve existing behavior.
- Digest frequency defaults to `weekly`; valid values are exactly `off`, `daily`, `weekly`, and `monthly`.
- Settings interactions and confirmations are ephemeral.
- Continue ingesting every authorized lifecycle event even when its DM category is disabled.
- A disabled setting suppresses delivery only; it does not remove history, move cursors, or alter API state.
- Preserve report-level `dm_enabled` behavior and the existing 60-day tracking boundary.
- Never log a user's report content, preference-linked report IDs, or Discord DM content.
- Update `docs/BOT_IMPLEMENTATION.md` for preference defaults and event mappings.

---

## File structure

- Create `apps/bot/src/notification-preferences.ts`: preference types, event-category mapping, and pure allow/deny helper.
- Modify `apps/bot/src/database.ts`: preference schema, mapping, reads, writes, and current-preference data on claimed jobs.
- Create `apps/bot/src/settings-ui.ts`: notification settings card and controls.
- Modify `apps/bot/src/commands.ts`: add `/settings notifications` while preserving `/settings country`.
- Modify `apps/bot/src/interactions.ts`: settings command and component handlers.
- Modify `apps/bot/src/notifier.ts`: delivery-time suppression.
- Create `apps/bot/test/notification-preferences.test.ts`: pure mapping, database-facing behavior, UI, and interaction tests.
- Modify `apps/bot/test/bot.test.ts`: regression coverage for command registration and existing lifecycle delivery.

### Task 1: Preference model and database migration

**Files:**
- Create: `apps/bot/src/notification-preferences.ts`
- Modify: `apps/bot/src/database.ts`
- Create: `apps/bot/test/notification-preferences.test.ts`

**Interfaces:**
- Consumes: existing lifecycle event type strings and `bot_users` rows.
- Produces: `DigestFrequency`, `NotificationPreferenceKey`, `NotificationPreferences`, `notificationCategory()`, `allowsLifecycleNotification()`, `Database.getNotificationPreferences()`, `Database.setNotificationPreference()`, and `Database.setDigestFrequency()`.

- [ ] **Step 1: Write failing preference-mapping tests**

```ts
import { describe, expect, it } from "vitest";
import {
  allowsLifecycleNotification,
  notificationCategory,
  type NotificationPreferences
} from "../src/notification-preferences.js";

const preferences: NotificationPreferences = {
  submissionResults: true,
  actioned: false,
  declined: true,
  appealProgress: false,
  digestFrequency: "weekly"
};

describe("notification preferences", () => {
  it.each([
    ["report_submitted", "submission_results"],
    ["report_failed", "submission_results"],
    ["discord:received", "submission_results"],
    ["discord:actioned", "actioned"],
    ["discord:closed_no_action", "declined"],
    ["discord:review_not_approved", "declined"],
    ["review_requested", "appeal_progress"],
    ["review_received", "appeal_progress"],
    ["review_confirmation_timeout", "appeal_progress"],
    ["review_request_failed", "appeal_progress"],
    ["review_ineligible", "appeal_progress"],
    ["review_request_ambiguous", "appeal_progress"]
  ])("maps %s to %s", (eventType, category) => {
    expect(notificationCategory(eventType)).toBe(category);
  });

  it("checks the matching current preference", () => {
    expect(allowsLifecycleNotification("discord:actioned", preferences)).toBe(false);
    expect(allowsLifecycleNotification("discord:closed_no_action", preferences)).toBe(true);
    expect(allowsLifecycleNotification("review_requested", preferences)).toBe(false);
  });
});
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run: `npm.cmd test -w @discord-dsa/bot -- notification-preferences.test.ts`

Expected: FAIL because the preference module does not exist.

- [ ] **Step 3: Implement the pure preference boundary**

```ts
export const DIGEST_FREQUENCIES = ["off", "daily", "weekly", "monthly"] as const;
export type DigestFrequency = (typeof DIGEST_FREQUENCIES)[number];

export type NotificationPreferenceKey =
  | "submission_results"
  | "actioned"
  | "declined"
  | "appeal_progress";

export interface NotificationPreferences {
  submissionResults: boolean;
  actioned: boolean;
  declined: boolean;
  appealProgress: boolean;
  digestFrequency: DigestFrequency;
}

export function notificationCategory(eventType: string): NotificationPreferenceKey | null;
export function allowsLifecycleNotification(
  eventType: string,
  preferences: NotificationPreferences
): boolean;
```

Unknown event types return `null` and are not newly deliverable. Keep `shouldNotifyLifecycleType()`
as the first allowlist; this helper only subdivides already approved lifecycle types.

- [ ] **Step 4: Add idempotent preference columns**

Add to the initial `bot_users` table definition and migration tail:

```sql
notify_submission_results boolean NOT NULL DEFAULT true,
notify_actioned boolean NOT NULL DEFAULT true,
notify_declined boolean NOT NULL DEFAULT true,
notify_appeal_progress boolean NOT NULL DEFAULT true,
digest_frequency text NOT NULL DEFAULT 'weekly'
  CHECK (digest_frequency IN ('off', 'daily', 'weekly', 'monthly'))
```

For existing databases use four `ALTER TABLE bot_users ADD COLUMN IF NOT EXISTS` statements and one
digest column statement, followed by an idempotent named constraint inside a PostgreSQL `DO` block
matching the existing migration style. Define `NotificationPreferencesRow`, map snake_case to the
exported view, and add:

```ts
public async getNotificationPreferences(userId: string): Promise<NotificationPreferences>;
public async setNotificationPreference(
  userId: string,
  key: NotificationPreferenceKey,
  enabled: boolean
): Promise<NotificationPreferences>;
public async setDigestFrequency(
  userId: string,
  frequency: DigestFrequency
): Promise<NotificationPreferences>;
```

Each write inserts `bot_users(discord_user_id)` if missing, uses a fixed SQL column selected by an
exhaustive `switch` rather than user-supplied SQL, updates `updated_at`, and returns the complete
mapped preference state.

- [ ] **Step 5: Run preference tests**

Run: `npm.cmd test -w @discord-dsa/bot -- notification-preferences.test.ts`

Expected: PASS for all event mappings and default preference values.

- [ ] **Step 6: Commit the preference model**

```powershell
git add -- apps/bot/src/notification-preferences.ts apps/bot/src/database.ts apps/bot/test/notification-preferences.test.ts
git commit -m "feat(bot): persist granular notification preferences"
```

### Task 2: Delivery-time lifecycle suppression

**Files:**
- Modify: `apps/bot/src/database.ts`
- Modify: `apps/bot/src/notifier.ts`
- Modify: `apps/bot/test/notification-preferences.test.ts`
- Modify: `apps/bot/test/bot.test.ts`

**Interfaces:**
- Consumes: `allowsLifecycleNotification()` and stored preference columns from Task 1.
- Produces: claimed `NotificationJob.preferences` and safe suppression before any Discord DM request.

- [ ] **Step 1: Write failing delivery-time suppression tests**

Construct a claimed `discord:actioned` job with `actioned: false`. Assert the notifier calls
`completeNotification(job.id)`, does not call `client.users.fetch()`, and logs only
`notification_send_suppressed` with the notification ID and semantic category. Add a second test
where `declined: true` and assert the existing DM edit/reply flow is unchanged.

```ts
expect(database.completeNotification).toHaveBeenCalledWith("41");
expect(client.users.fetch).not.toHaveBeenCalled();
expect(botLogMock).toHaveBeenCalledWith("notification_send_suppressed", {
  notificationId: "41",
  category: "actioned"
});
```

- [ ] **Step 2: Run focused tests and verify failure**

Run: `npm.cmd test -w @discord-dsa/bot -- notification-preferences.test.ts bot.test.ts`

Expected: FAIL because claimed jobs do not contain current preferences and the notifier does not
apply them.

- [ ] **Step 3: Join current preferences into claimed jobs**

Extend `NotificationJob` with `preferences: NotificationPreferences`. In
`claimNotifications()`, join `bot_users` by `notification_outbox.discord_user_id` and select all
five preference columns. Map them after the transactional claim; do not store a stale preference
snapshot in `notification_outbox.payload`.

At the start of each notifier delivery loop, after the existing `dm_blocked`/tracking suppression
check and before fetching Discord data, run:

```ts
const category = notificationCategory(job.payload.eventType);
if (category === null || !allowsLifecycleNotification(job.payload.eventType, job.preferences)) {
  await this.database.completeNotification(job.id);
  botLog("notification_send_suppressed", { notificationId: job.id, category });
  continue;
}
```

Do not modify webhook ingestion, reconciliation cursor advancement, or event inbox insertion.

- [ ] **Step 4: Run lifecycle notification tests**

Run: `npm.cmd test -w @discord-dsa/bot -- notification-preferences.test.ts bot.test.ts`

Expected: PASS for disabled-category suppression and all existing notification deduplication,
status-DM editing, and blocked-DM behavior.

- [ ] **Step 5: Commit notifier enforcement**

```powershell
git add -- apps/bot/src/database.ts apps/bot/src/notifier.ts apps/bot/test/notification-preferences.test.ts apps/bot/test/bot.test.ts
git commit -m "feat(bot): enforce lifecycle DM preferences"
```

### Task 3: `/settings notifications` UI and interactions

**Files:**
- Create: `apps/bot/src/settings-ui.ts`
- Modify: `apps/bot/src/commands.ts`
- Modify: `apps/bot/src/interactions.ts`
- Modify: `apps/bot/test/notification-preferences.test.ts`

**Interfaces:**
- Consumes: Task 1 database methods and preference types.
- Produces: `notificationSettingsView()` and component IDs under the `settings:notifications:*` namespace.

- [ ] **Step 1: Write failing command and settings-card tests**

Assert `/settings` contains both `country` and `notifications`; the settings card renders all four
toggles and `Digest: Weekly`; toggling Actioned calls
`setNotificationPreference(userId, "actioned", false)`; selecting Monthly calls
`setDigestFrequency(userId, "monthly")`; and every reply/update is ephemeral with mentions disabled.

```ts
expect(database.setNotificationPreference).toHaveBeenCalledWith(
  interaction.user.id,
  "actioned",
  false
);
expect(database.setDigestFrequency).toHaveBeenCalledWith(
  interaction.user.id,
  "monthly"
);
```

- [ ] **Step 2: Run focused tests and verify failure**

Run: `npm.cmd test -w @discord-dsa/bot -- notification-preferences.test.ts`

Expected: FAIL because only `/settings country` exists.

- [ ] **Step 3: Build the settings card**

```ts
export function notificationSettingsView(
  preferences: NotificationPreferences
): InteractionUpdateOptions;
```

Render one embed listing each category as Enabled or Disabled. Use four toggle buttons with custom
IDs `settings:notifications:toggle:<key>:<next-value>` and one string select with custom ID
`settings:notifications:digest`. The select has exactly Off, Daily, Weekly, and Monthly; mark the
stored frequency as default. Keep component rows within Discord's five-row limit.

- [ ] **Step 4: Register and handle the subcommand**

Add this subcommand to `settings`:

```ts
.addSubcommand((command) =>
  command.setName("notifications").setDescription("Configure private lifecycle alerts and digests")
)
```

Change `handleSettingsCommand()` to branch on `getSubcommand(true)`: retain current country behavior
verbatim and render notification settings for the new branch. Handle the settings button before
report buttons and the digest select before country selects. Parse preference keys and booleans
through explicit allowlists; reject malformed component state by returning without a database write.

- [ ] **Step 5: Run settings tests**

Run: `npm.cmd test -w @discord-dsa/bot -- notification-preferences.test.ts`

Expected: PASS for registration, full-state rendering, toggles, digest selection, ephemeral updates,
and malformed custom-ID rejection.

- [ ] **Step 6: Commit settings UI**

```powershell
git add -- apps/bot/src/settings-ui.ts apps/bot/src/commands.ts apps/bot/src/interactions.ts apps/bot/test/notification-preferences.test.ts
git commit -m "feat(bot): add notification settings dashboard"
```

### Task 4: Documentation and complete verification

**Files:**
- Modify: `docs/BOT_IMPLEMENTATION.md`
- Modify only implementation files required to correct introduced failures.

**Interfaces:**
- Consumes: Tasks 1–3.
- Produces: documented defaults, event mapping, and repository-wide validation evidence.

- [ ] **Step 1: Document settings semantics**

Add the four categories, their exact event mappings, default-enabled migration behavior, weekly
digest default, Off/Daily/Weekly/Monthly choices, delivery-time evaluation, continued event
ingestion, and interaction privacy to `docs/BOT_IMPLEMENTATION.md`.

- [ ] **Step 2: Run required validation**

```powershell
npm.cmd run lint
npm.cmd run typecheck
npm.cmd test
npm.cmd run build
npm.cmd run audit:high
```

Expected: every command exits 0; existing lifecycle DMs remain enabled under migrated defaults.

- [ ] **Step 3: Inspect and commit final fixes**

Run `git diff --check` and `git status --short`. Stage only notification-settings files. If fixes or
documentation remain uncommitted, commit them as:

```powershell
git commit -m "docs: document notification preferences"
```
