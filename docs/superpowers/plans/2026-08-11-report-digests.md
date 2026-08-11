# Report Digests Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver idempotent Daily, Weekly, or Monthly private report digests only when the user has at least three new reports or three personal outcome changes in the closed UTC period.

**Architecture:** The API supplies exact-range personal activity, personal cohort analytics, and privacy-filtered community analytics. The bot owns frequency preferences, closed-period scheduling, durable digest jobs, local chart rendering, and Discord DM delivery. Community activity can enrich an eligible personal digest but can never make one eligible.

**Tech Stack:** TypeScript 6, PostgreSQL, discord.js 14, Vitest 4, analytics contracts and chart renderer from the Analytics Hub plan.

## Global Constraints

- This plan depends on `2026-08-11-analytics-hub.md` and `2026-08-11-notification-settings.md` being complete.
- Digest frequencies are exactly `off`, `daily`, `weekly`, and `monthly`; Weekly is the default.
- Eligibility is `newReports >= 3 || outcomeChanges >= 3` for the user's exact closed UTC period.
- Qualifying outcome changes are Actioned, Closed without action, Appeal accepted, and Appeal denied.
- Community statistics never trigger a DM and retain all API-side privacy thresholds.
- Generate at most the most recently closed period after downtime; do not backfill multiple stale digests.
- Digest jobs and sends are idempotent per user, frequency, and period start.
- DMs are ordinary private Discord messages; settings, status, and error interactions remain ephemeral.
- Never store chart buffers, submitted report text, extracted phrases, or raw API aggregates in the bot database.
- Update `docs/BOT_API.md` and `docs/BOT_IMPLEMENTATION.md`.

---

## File structure

- Modify `packages/report-contracts/src/analytics.ts`: exact-range query and digest-activity DTO.
- Modify `packages/report-contracts/src/api.ts`: exact-range analytics and digest-activity methods.
- Modify `packages/report-contracts/test/analytics.test.ts`: adapter tests.
- Modify `apps/api/src/database.ts`: event-time activity counts.
- Modify `apps/api/src/server.ts`: exact-range and digest-activity query validation.
- Modify `apps/api/test/analytics.test.ts` and `apps/api/test/backend.test.ts`: activity and routes.
- Create `apps/bot/src/digest-periods.ts`: closed UTC period calculation.
- Modify `apps/bot/src/database.ts`: durable digest jobs and claim/retry methods.
- Create `apps/bot/src/digest-ui.ts`: compact personal/community digest rendering.
- Create `apps/bot/src/digest-worker.ts`: scheduling, eligibility, aggregation, charting, and delivery.
- Modify `apps/bot/src/main.ts`: worker lifecycle.
- Create `apps/bot/test/digests.test.ts`: period, threshold, persistence, rendering, and delivery tests.

### Task 1: Exact-range analytics and digest activity contract

**Files:**
- Modify: `packages/report-contracts/src/analytics.ts`
- Modify: `packages/report-contracts/src/api.ts`
- Modify: `packages/report-contracts/test/analytics.test.ts`
- Modify: `apps/api/src/database.ts`
- Modify: `apps/api/src/server.ts`
- Modify: `apps/api/test/analytics.test.ts`
- Modify: `apps/api/test/backend.test.ts`
- Modify: `docs/BOT_API.md`

**Interfaces:**
- Consumes: Analytics Hub period resolution and aggregation.
- Produces: `DigestActivity`, `DsaApi.analyticsForRange()`, `DsaApi.communityAnalyticsForRange()`, `DsaApi.digestActivity()`, `Database.reportAnalyticsForInterval()`, and `Database.communityAnalyticsForInterval()`.

- [ ] **Step 1: Write failing contract tests**

```ts
await api.analyticsForRange(
  "1197857362942378017",
  "2026-08-03T00:00:00.000Z",
  "2026-08-10T00:00:00.000Z"
);
await api.communityAnalyticsForRange(
  "2026-08-03T00:00:00.000Z",
  "2026-08-10T00:00:00.000Z"
);
await api.digestActivity(
  "1197857362942378017",
  "2026-08-03T00:00:00.000Z",
  "2026-08-10T00:00:00.000Z"
);

expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
  "https://api.example.test/v1/users/1197857362942378017/analytics?startAt=2026-08-03T00%3A00%3A00.000Z&endAt=2026-08-10T00%3A00%3A00.000Z",
  "https://api.example.test/v1/analytics/community?startAt=2026-08-03T00%3A00%3A00.000Z&endAt=2026-08-10T00%3A00%3A00.000Z",
  "https://api.example.test/v1/users/1197857362942378017/digest-activity?startAt=2026-08-03T00%3A00%3A00.000Z&endAt=2026-08-10T00%3A00%3A00.000Z"
]);
```

- [ ] **Step 2: Run contract tests and verify failure**

Run: `npm.cmd test -w @discord-dsa/contracts -- analytics.test.ts`

Expected: FAIL because exact-range and activity methods are absent.

- [ ] **Step 3: Add the activity DTO and adapter methods**

```ts
export interface DigestActivity {
  interval: AnalyticsInterval;
  newReports: number;
  outcomeChanges: {
    total: number;
    actioned: number;
    closedNoAction: number;
    appealActioned: number;
    appealDenied: number;
  };
  eligible: boolean;
}
```

Add exact method signatures:

```ts
public analyticsForRange(discordUserId: string, startAt: string, endAt: string): Promise<ReportAnalytics>;
public communityAnalyticsForRange(startAt: string, endAt: string): Promise<ReportAnalytics>;
public digestActivity(discordUserId: string, startAt: string, endAt: string): Promise<DigestActivity>;
```

Build all queries with `URLSearchParams` in `startAt`, `endAt` order.

- [ ] **Step 4: Write failing API activity tests**

Create event fixtures with two created reports and three qualifying outcome transitions in the range.
Include `report_submitted`, `discord:received`, and `review_requested` events and assert they do not
increase `outcomeChanges.total`.

```ts
expect(activity).toEqual({
  interval: expect.objectContaining({ period: "custom" }),
  newReports: 2,
  outcomeChanges: {
    total: 3,
    actioned: 1,
    closedNoAction: 1,
    appealActioned: 0,
    appealDenied: 1
  },
  eligible: true
});
```

- [ ] **Step 5: Implement parameterized activity counting**

Add:

```ts
public async reportAnalyticsForInterval(
  discordUserId: string,
  interval: AnalyticsInterval
): Promise<ReportAnalytics>;
public async communityAnalyticsForInterval(
  interval: AnalyticsInterval
): Promise<ReportAnalytics>;
public async digestActivity(
  discordUserId: string,
  startAt: Date,
  endAt: Date
): Promise<DigestActivity>;
```

Count owned reports with `retry_of_report_id IS NULL`, `created_at >= $2`, and `created_at < $3` for
`newReports`, so technical retries and denied-review resubmissions cannot trigger a digest. For
outcomes, join `report_events` to owned reports and count `discord_status_updated` metadata values
`actioned`, `closed_no_action`, and `review_not_approved` inside the event interval. Determine whether
an `actioned` event followed a prior closed-without-action event for that report chain; classify it as
`appealActioned` when true and ordinary `actioned` otherwise. `eligible` is computed only from the
two top-level counts.

Extend both analytics routes to accept either an approved `period` or an exact `startAt`/`endAt`
pair, never both. Add:

```text
GET /v1/users/:discordUserId/digest-activity?startAt=<ISO>&endAt=<ISO>
```

Require exact UTC ISO timestamps, `startAt < endAt`, and a maximum interval of 366 days for digest
worker calls. Return `invalid_analytics_query` on validation failure.

- [ ] **Step 6: Run contract and API tests**

```powershell
npm.cmd test -w @discord-dsa/contracts -- analytics.test.ts
npm.cmd test -w @discord-dsa/api -- analytics.test.ts backend.test.ts
```

Expected: PASS for exact paths, threshold calculation, event-time attribution, and invalid ranges.

- [ ] **Step 7: Document and commit the digest API boundary**

Document exact-range analytics, event-time activity semantics, and eligibility in `docs/BOT_API.md`.

```powershell
git add -- packages/report-contracts/src/analytics.ts packages/report-contracts/src/api.ts packages/report-contracts/test/analytics.test.ts apps/api/src/database.ts apps/api/src/server.ts apps/api/test/analytics.test.ts apps/api/test/backend.test.ts docs/BOT_API.md
git commit -m "feat(api): expose digest activity analytics"
```

### Task 2: UTC period scheduling and durable digest jobs

**Files:**
- Create: `apps/bot/src/digest-periods.ts`
- Modify: `apps/bot/src/database.ts`
- Create: `apps/bot/test/digests.test.ts`

**Interfaces:**
- Consumes: `DigestFrequency` from notification preferences.
- Produces: `closedDigestPeriod()`, `DigestJob`, `Database.listDigestUsers()`, `Database.ensureDigestJob()`, `Database.claimDigestJobs()`, `Database.completeDigestJob()`, and `Database.failDigestJob()`.

- [ ] **Step 1: Write failing closed-period tests**

```ts
import { describe, expect, it } from "vitest";
import { closedDigestPeriod } from "../src/digest-periods.js";

describe("closed digest periods", () => {
  it("uses the previous UTC day", () => {
    expect(closedDigestPeriod("daily", new Date("2026-08-11T12:30:00Z"))).toEqual({
      startAt: new Date("2026-08-10T00:00:00.000Z"),
      endAt: new Date("2026-08-11T00:00:00.000Z")
    });
  });

  it("uses Monday-to-Monday ISO weeks", () => {
    expect(closedDigestPeriod("weekly", new Date("2026-08-11T12:30:00Z"))).toEqual({
      startAt: new Date("2026-08-03T00:00:00.000Z"),
      endAt: new Date("2026-08-10T00:00:00.000Z")
    });
  });

  it("uses the previous UTC calendar month", () => {
    expect(closedDigestPeriod("monthly", new Date("2026-08-11T12:30:00Z"))).toEqual({
      startAt: new Date("2026-07-01T00:00:00.000Z"),
      endAt: new Date("2026-08-01T00:00:00.000Z")
    });
  });
});
```

- [ ] **Step 2: Run the digest test and verify failure**

Run: `npm.cmd test -w @discord-dsa/bot -- digests.test.ts`

Expected: FAIL because digest periods and jobs do not exist.

- [ ] **Step 3: Implement exact closed UTC periods**

```ts
export interface DigestPeriod {
  startAt: Date;
  endAt: Date;
}

export function closedDigestPeriod(
  frequency: Exclude<DigestFrequency, "off">,
  now?: Date
): DigestPeriod;
```

Use `Date.UTC`, `getUTC*`, and `setUTC*` only. Weekly periods start Monday. Reject `off` at the type
boundary rather than returning a synthetic period.

- [ ] **Step 4: Add the durable job table and methods**

Add to `SCHEMA_SQL`:

```sql
CREATE TABLE IF NOT EXISTS digest_jobs (
  id bigserial PRIMARY KEY,
  discord_user_id text NOT NULL REFERENCES bot_users(discord_user_id) ON DELETE CASCADE,
  frequency text NOT NULL CHECK (frequency IN ('daily', 'weekly', 'monthly')),
  period_start timestamptz NOT NULL,
  period_end timestamptz NOT NULL,
  state text NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending', 'sending', 'sent', 'skipped', 'failed')),
  attempts integer NOT NULL DEFAULT 0,
  run_at timestamptz NOT NULL DEFAULT now(),
  locked_at timestamptz,
  last_error text,
  discord_message_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (discord_user_id, frequency, period_start)
);

CREATE INDEX IF NOT EXISTS digest_jobs_claim_idx
  ON digest_jobs(state, run_at, locked_at);
```

Define:

```ts
export interface DigestJob {
  id: string;
  discordUserId: string;
  frequency: Exclude<DigestFrequency, "off">;
  periodStart: Date;
  periodEnd: Date;
  attempts: number;
}

public async listDigestUsers(): Promise<Array<{ discordUserId: string; frequency: Exclude<DigestFrequency, "off"> }>>;
public async ensureDigestJob(userId: string, frequency: Exclude<DigestFrequency, "off">, period: DigestPeriod): Promise<void>;
public async claimDigestJobs(limit?: number): Promise<DigestJob[]>;
public async completeDigestJob(id: string, state: "sent" | "skipped", messageId?: string): Promise<void>;
public async failDigestJob(job: DigestJob, message: string, permanent: boolean): Promise<void>;
```

Claim with `FOR UPDATE SKIP LOCKED`, increment attempts, and set `sending`. Retry delays use the
existing bounded exponential pattern and stop permanently after 5 attempts. `listDigestUsers()`
excludes `off` and suspended users.

- [ ] **Step 5: Run period and database-behavior tests**

Run: `npm.cmd test -w @discord-dsa/bot -- digests.test.ts`

Expected: PASS for daily/weekly/monthly boundaries, unique-job semantics, claim state, and retry caps.

- [ ] **Step 6: Commit digest scheduling primitives**

```powershell
git add -- apps/bot/src/digest-periods.ts apps/bot/src/database.ts apps/bot/test/digests.test.ts
git commit -m "feat(bot): add durable digest scheduling"
```

### Task 3: Digest rendering

**Files:**
- Create: `apps/bot/src/digest-ui.ts`
- Modify: `apps/bot/test/digests.test.ts`

**Interfaces:**
- Consumes: `DigestActivity`, personal `ReportAnalytics`, optional community `ReportAnalytics`, and `renderAnalyticsChart()`.
- Produces: `digestMessage()` with safe embeds and chart attachments.

- [ ] **Step 1: Write failing rendering tests**

```ts
import type { DigestActivity } from "@discord-dsa/contracts";
import { analyticsFixture, communityFixture } from "./analytics-fixtures.js";

function activityFixture(input: {
  newReports: number;
  outcomeChanges: number;
}): DigestActivity {
  return {
    interval: {
      period: "custom",
      startAt: "2026-08-03T00:00:00.000Z",
      endAt: "2026-08-10T00:00:00.000Z",
      asOf: "2026-08-11T12:00:00.000Z",
      timezone: "UTC"
    },
    newReports: input.newReports,
    outcomeChanges: {
      total: input.outcomeChanges,
      actioned: input.outcomeChanges,
      closedNoAction: 0,
      appealActioned: 0,
      appealDenied: 0
    },
    eligible: input.newReports >= 3 || input.outcomeChanges >= 3
  };
}

const payload = await digestMessage({
  frequency: "weekly",
  activity: activityFixture({ newReports: 3, outcomeChanges: 4 }),
  personal: analyticsFixture(),
  community: communityFixture()
});

const rendered = JSON.stringify(payload);
expect(rendered).toContain("Your week in reports");
expect(rendered).toContain("Community snapshot");
expect(rendered).toContain("Use `/analytics`");
expect(rendered.toLowerCase()).not.toContain("ban");
expect(rendered).not.toContain("submitted explanation");
```

Add a second test with `availability: "insufficient_community_data"` and assert the Community field
is omitted while the personal digest remains valid.

- [ ] **Step 2: Run the rendering tests and verify failure**

Run: `npm.cmd test -w @discord-dsa/bot -- digests.test.ts`

Expected: FAIL because `digest-ui.ts` does not exist.

- [ ] **Step 3: Implement bounded digest output**

```ts
export async function digestMessage(input: {
  frequency: Exclude<DigestFrequency, "off">;
  activity: DigestActivity;
  personal: ReportAnalytics;
  community: ReportAnalytics | null;
}): Promise<MessageCreateOptions>;
```

Render frequency-specific titles (“Your day/week/month in reports”), exact UTC dates, personal new
report and outcome totals, Actioned, appeal-then-actioned, pending, action rate, and median reply.
Include Community flow percentages, action rate, appeal-action rate, volume trend, and reply-time
trend only when `availability === "available"`. Attach locally generated charts using stable names
`report-volume.png` and `discord-reply-time.png`. If charting fails, omit files and retain textual
figures. Do not include Action History items, recurring phrases, report references, links, or target
content in scheduled DMs.

- [ ] **Step 4: Run digest rendering tests**

Run: `npm.cmd test -w @discord-dsa/bot -- digests.test.ts`

Expected: PASS for personal-only, community-enriched, text-fallback, terminology, and embed limits.

- [ ] **Step 5: Commit digest UI**

```powershell
git add -- apps/bot/src/digest-ui.ts apps/bot/test/digests.test.ts
git commit -m "feat(bot): render private report digests"
```

### Task 4: Digest worker and application lifecycle

**Files:**
- Create: `apps/bot/src/digest-worker.ts`
- Modify: `apps/bot/src/main.ts`
- Modify: `apps/bot/test/digests.test.ts`

**Interfaces:**
- Consumes: Task 1 API methods, Task 2 job methods, Task 3 renderer, Discord client.
- Produces: `DigestWorker.start()`, `DigestWorker.stop()`, scheduled job creation, eligibility evaluation, and bounded delivery.

- [ ] **Step 1: Write failing worker tests**

Use fake timers and mocks to cover:

```ts
it.each([
  [2, 2, false],
  [3, 0, true],
  [0, 3, true]
])("uses only personal thresholds", async (newReports, outcomeChanges, sends) => {
  api.digestActivity.mockResolvedValue(activityFixture({ newReports, outcomeChanges }));
  await worker.runOnce(new Date("2026-08-11T12:00:00Z"));
  expect(user.send).toHaveBeenCalledTimes(sends ? 1 : 0);
});
```

Also assert Community analytics is never requested for an ineligible job, Community availability
does not change eligibility, duplicate `runOnce()` calls do not duplicate jobs, a frequency changed
to Off skips a claimed job, blocked DMs permanently fail without repeated sends, and transient errors
return the job to pending.

- [ ] **Step 2: Run worker tests and verify failure**

Run: `npm.cmd test -w @discord-dsa/bot -- digests.test.ts`

Expected: FAIL because `DigestWorker` does not exist.

- [ ] **Step 3: Implement seeding and delivery**

```ts
export class DigestWorker {
  public start(): void;
  public stop(): void;
  public async runOnce(now?: Date): Promise<void>;
}
```

`runOnce()` first calls `listDigestUsers()`, calculates only the most recently closed period, and
calls `ensureDigestJob()`. It then claims jobs. Before API work, reload current preferences and skip
if the frequency no longer matches. Request `digestActivity()` first; mark `skipped` unless either
threshold is at least 3. Only then request personal and Community exact-range analytics, render, fetch
the Discord user, and send.

Start one 5-minute interval with an immediate run. Protect against overlapping runs with an in-memory
boolean while PostgreSQL remains the cross-process authority. Use `.unref()` as in other workers.
Classify Discord unknown-user or cannot-message errors as permanent; use safe bounded error strings
for retry state and structured logs.

- [ ] **Step 4: Wire worker startup and shutdown**

In `main.ts`, construct `DigestWorker` after database migration and Discord client creation. Start it
only after Discord readiness alongside `Notifier`. Stop it during the same shutdown path before
closing the database or destroying the Discord client.

- [ ] **Step 5: Run digest worker and existing bot tests**

```powershell
npm.cmd test -w @discord-dsa/bot -- digests.test.ts
npm.cmd test -w @discord-dsa/bot -- bot.test.ts
```

Expected: PASS for thresholds, idempotency, settings changes, retry behavior, and existing lifecycle
notifications.

- [ ] **Step 6: Commit worker integration**

```powershell
git add -- apps/bot/src/digest-worker.ts apps/bot/src/main.ts apps/bot/test/digests.test.ts
git commit -m "feat(bot): deliver scheduled report digests"
```

### Task 5: Documentation and repository-wide verification

**Files:**
- Modify: `docs/BOT_IMPLEMENTATION.md`
- Modify only implementation files required to correct introduced failures.

**Interfaces:**
- Consumes: Tasks 1–4.
- Produces: operator documentation and complete validation evidence.

- [ ] **Step 1: Document digest operations**

Add UTC Daily/Weekly/Monthly boundaries, Weekly default, Off behavior, the two threshold rules,
qualifying outcomes, no stale-period backfill, privacy-filtered Community enrichment, job
idempotency, chart fallback, blocked-DM behavior, and safe logging to `docs/BOT_IMPLEMENTATION.md`.

- [ ] **Step 2: Run required validation**

```powershell
npm.cmd run lint
npm.cmd run typecheck
npm.cmd test
npm.cmd run build
npm.cmd run audit:high
```

Expected: every command exits 0 and no high-severity dependency issue is introduced.

- [ ] **Step 3: Inspect final state and commit verification fixes**

Run `git diff --check` and `git status --short`. Confirm no protected Python diagnostic or unrelated
user file is staged. If fixes or final documentation remain, stage only exact digest files and commit:

```powershell
git commit -m "docs: document scheduled report digests"
```
