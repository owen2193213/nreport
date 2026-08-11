# Analytics Hub Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build one ephemeral `/analytics` hub with personal and privacy-filtered community metrics, locally rendered charts, recurring themes, and personal action history.

**Architecture:** The API computes authoritative case-cohort analytics from `reports` and `report_events`; the shared contracts package exposes typed DTOs and HTTP calls; the bot renders the four-view Discord dashboard. Case outcomes follow retry chains, while attempt reliability remains attempt-based. Community suppression happens inside the API so unsafe raw aggregates never cross the service boundary.

**Tech Stack:** TypeScript 6, PostgreSQL 16-compatible SQL, Fastify 5, discord.js 14, Vitest 4, `@napi-rs/canvas` for local PNG charts.

## Global Constraints

- Preserve the API/bot database boundary; only `apps/api` reads authoritative report lifecycle state.
- All Discord interaction replies, navigation updates, validation failures, and history results are ephemeral.
- Use “Action taken” or “Actioned”; never claim that Discord banned a user or server.
- Action History is submitter-scoped and shows submitted explanations and message links, not durably retained original message text.
- Community output requires 10 reports from 5 users; categorical buckets require 3 reports from 3 users; recurring phrases require 5 reports from 3 users.
- Never expose or log report text, extracted terms, message links, targets, aliases, pseudonyms, Discord IDs, or report identifiers in community analytics diagnostics.
- Use UTC boundaries and return exact `startAt`, `endAt`, and `asOf` values.
- Do not edit any protected Python diagnostic script.
- Update `docs/BOT_API.md` and `docs/BOT_IMPLEMENTATION.md` with contract and UI behavior.

---

## File structure

- Create `packages/report-contracts/src/analytics.ts`: analytics periods, scopes, DTOs, and history DTOs.
- Modify `packages/report-contracts/src/index.ts`: export analytics contracts.
- Modify `packages/report-contracts/src/api.ts`: typed analytics and Action History requests.
- Create `packages/report-contracts/test/analytics.test.ts`: contract and request-path tests.
- Create `apps/api/src/analytics.ts`: UTC period resolution, cohort classification, privacy suppression, pattern sanitization, and pure metric helpers.
- Modify `apps/api/src/database.ts`: analytics source queries, action-history query, and indexes.
- Modify `apps/api/src/server.ts`: validated analytics and history routes.
- Create `apps/api/test/analytics.test.ts`: pure classification and privacy tests.
- Modify `apps/api/test/backend.test.ts`: Fastify route and ownership-filter tests.
- Modify `apps/bot/package.json` and root `package-lock.json`: local chart renderer dependency.
- Create `apps/bot/src/analytics-charts.ts`: deterministic PNG volume and reply-time charts.
- Create `apps/bot/src/analytics-ui.ts`: four analytics views, controls, history modal, and pagination.
- Create `apps/bot/test/analytics-fixtures.ts`: complete reusable personal and community DTO fixtures.
- Modify `apps/bot/src/commands.ts`: register `/analytics`.
- Modify `apps/bot/src/interactions.ts`: command, select, button, and modal handlers.
- Create `apps/bot/test/analytics.test.ts`: chart, embed, ownership, navigation, and fallback tests.

### Task 1: Shared analytics contracts and HTTP adapter

**Files:**
- Create: `packages/report-contracts/src/analytics.ts`
- Modify: `packages/report-contracts/src/index.ts`
- Modify: `packages/report-contracts/src/api.ts`
- Create: `packages/report-contracts/test/analytics.test.ts`

**Interfaces:**
- Consumes: existing `DsaApi.request<T>()` and `ReportFlow`.
- Produces: `AnalyticsPeriod`, `AnalyticsScope`, `ReportAnalytics`, `ActionHistoryPage`, `DsaApi.analyticsFor()`, `DsaApi.communityAnalytics()`, and `DsaApi.actionHistory()`.

- [ ] **Step 1: Write failing contract and request-path tests**

```ts
import { describe, expect, it, vi } from "vitest";
import { ANALYTICS_PERIODS, DsaApi } from "../src/index.js";

describe("analytics contracts", () => {
  it("keeps the approved period catalog stable", () => {
    expect(ANALYTICS_PERIODS).toEqual(["24h", "7d", "30d", "ytd", "365d", "all"]);
  });

  it("encodes personal, community, and history requests", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ availability: "available" })
    });
    const api = new DsaApi({
      baseUrl: "https://api.example.test",
      apiKey: "test-key",
      fetch: fetchMock as typeof fetch
    });

    await api.analyticsFor("1197857362942378017", "7d");
    await api.communityAnalytics("30d");
    await api.actionHistory("1197857362942378017", {
      period: "7d",
      limit: 10
    });

    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      "https://api.example.test/v1/users/1197857362942378017/analytics?period=7d",
      "https://api.example.test/v1/analytics/community?period=30d",
      "https://api.example.test/v1/users/1197857362942378017/action-history?period=7d&limit=10"
    ]);
  });
});
```

- [ ] **Step 2: Run the contract test and verify it fails**

Run: `npm.cmd test -w @discord-dsa/contracts -- analytics.test.ts`

Expected: FAIL because the analytics exports and `DsaApi` methods do not exist.

- [ ] **Step 3: Define the exact DTO boundary**

```ts
import type { ReportFlow } from "./types.js";

export const ANALYTICS_PERIODS = ["24h", "7d", "30d", "ytd", "365d", "all"] as const;
export type AnalyticsPeriod = (typeof ANALYTICS_PERIODS)[number];
export type AnalyticsScope = "personal" | "community";

export interface AnalyticsInterval {
  period: AnalyticsPeriod | "custom";
  startAt: string | null;
  endAt: string;
  asOf: string;
  timezone: "UTC";
}

export interface RateMetric {
  numerator: number;
  denominator: number;
  percentage: number | null;
}

export interface DurationMetric {
  sampleSize: number;
  medianSeconds: number | null;
  p90Seconds: number | null;
}

export interface AnalyticsBreakdownItem {
  key: string;
  label: string;
  count: number;
  percentage: number;
}

export interface AnalyticsSeriesPoint {
  bucketStart: string;
  reportCount: number;
  medianReplySeconds: number | null;
}

export interface AnalyticsPattern {
  phrase: string;
  reportCount: number;
}

export interface ReportAnalytics {
  availability: "available" | "insufficient_community_data";
  scope: AnalyticsScope;
  interval: AnalyticsInterval;
  volume: {
    newCases: number;
    attempts: number;
    retries: number;
    sentAttempts: number;
    pendingAttempts: number;
    failedAttempts: number;
  };
  outcomes: {
    awaitingResponse: number;
    awaitingDecision: number;
    directActioned: number;
    closedNoAction: number;
    appealsStarted: number;
    appealActioned: number;
    appealsDenied: number;
  };
  rates: {
    submission: RateMetric;
    action: RateMetric;
    appealAction: RateMetric;
  };
  timing: {
    reply: DurationMetric;
    decision: DurationMetric;
    appealDecision: DurationMetric;
  };
  breakdowns: {
    flows: AnalyticsBreakdownItem[];
    categories: AnalyticsBreakdownItem[];
    countries: AnalyticsBreakdownItem[];
  };
  series: AnalyticsSeriesPoint[];
  patterns: AnalyticsPattern[];
}

export interface ActionHistoryItem {
  internalReportId: string;
  discordReportId: string | null;
  flow: ReportFlow;
  category: string;
  country: string;
  submittedText: string;
  messageUrl: string | null;
  submittedAt: string;
  actionedAt: string;
  actionSource: "direct" | "appeal";
}

export interface ActionHistoryPage {
  interval: AnalyticsInterval;
  items: ActionHistoryItem[];
  nextCursor: string | null;
}
```

Add `export * from "./analytics.js";` to `src/index.ts`. Add adapter methods with these signatures:

```ts
public analyticsFor(discordUserId: string, period: AnalyticsPeriod): Promise<ReportAnalytics>;
public communityAnalytics(period: AnalyticsPeriod): Promise<ReportAnalytics>;
public actionHistory(
  discordUserId: string,
  query: { period?: AnalyticsPeriod; startAt?: string; endAt?: string; after?: string; limit?: number }
): Promise<ActionHistoryPage>;
```

Use `URLSearchParams` and include only defined values. Encode the user ID as in `reportsFor()`.

- [ ] **Step 4: Run contract tests**

Run: `npm.cmd test -w @discord-dsa/contracts`

Expected: PASS, including exact analytics paths and the existing idempotency tests.

- [ ] **Step 5: Commit the contract boundary**

```powershell
git add -- packages/report-contracts/src/analytics.ts packages/report-contracts/src/index.ts packages/report-contracts/src/api.ts packages/report-contracts/test/analytics.test.ts
git commit -m "feat(contracts): add report analytics API"
```

### Task 2: Pure analytics rules and privacy suppression

**Files:**
- Create: `apps/api/src/analytics.ts`
- Create: `apps/api/test/analytics.test.ts`

**Interfaces:**
- Consumes: `AnalyticsPeriod`, `AnalyticsBreakdownItem`, and API database source rows.
- Produces: `resolveAnalyticsInterval()`, `classifyCaseOutcome()`, `rateMetric()`, `durationMetric()`, `sanitizePatternText()`, `recurringPatterns()`, and `suppressCommunityBreakdown()`.

- [ ] **Step 1: Write failing rule tests**

```ts
import { describe, expect, it } from "vitest";
import {
  classifyCaseOutcome,
  rateMetric,
  recurringPatterns,
  resolveAnalyticsInterval,
  suppressCommunityBreakdown
} from "../src/analytics.js";

describe("analytics rules", () => {
  it("resolves a seven-day interval in UTC", () => {
    const interval = resolveAnalyticsInterval("7d", new Date("2026-08-11T12:00:00.000Z"));
    expect(interval).toMatchObject({
      startAt: "2026-08-04T12:00:00.000Z",
      endAt: "2026-08-11T12:00:00.000Z",
      timezone: "UTC"
    });
  });

  it("classifies action after appeal separately", () => {
    expect(classifyCaseOutcome([
      { type: "discord_status_updated", discordStatus: "closed_no_action" },
      { type: "review_requested", discordStatus: null },
      { type: "discord_status_updated", discordStatus: "actioned" }
    ])).toBe("appeal_actioned");
  });

  it("does not turn an empty denominator into zero percent", () => {
    expect(rateMetric(0, 0)).toEqual({ numerator: 0, denominator: 0, percentage: null });
  });

  it("suppresses a community bucket represented by too few users", () => {
    expect(suppressCommunityBreakdown([
      { key: "message_urf", label: "Message", reportCount: 8, userCount: 5 },
      { key: "guild_urf", label: "Server", reportCount: 2, userCount: 2 }
    ])).toEqual([{ key: "message_urf", label: "Message", count: 8, percentage: 100 }]);
  });

  it("removes links, snowflakes, mentions, and rare phrases", () => {
    const patterns = recurringPatterns([
      { userId: "u1", text: "Repeated hateful threat https://example.test/1197857362942378017" },
      { userId: "u2", text: "Repeated hateful threat <@1197857362942378017>" },
      { userId: "u3", text: "Repeated hateful threat" },
      { userId: "u4", text: "Repeated hateful threat" },
      { userId: "u5", text: "Repeated hateful threat" }
    ], "community");
    expect(patterns[0]).toMatchObject({ phrase: "repeated hateful threat", reportCount: 5 });
    expect(JSON.stringify(patterns)).not.toContain("1197857362942378017");
  });
});
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run: `npm.cmd test -w @discord-dsa/api -- analytics.test.ts`

Expected: FAIL because `apps/api/src/analytics.ts` does not exist.

- [ ] **Step 3: Implement deterministic pure helpers**

Use these exported signatures:

```ts
export function resolveAnalyticsInterval(period: AnalyticsPeriod, now?: Date): AnalyticsInterval;
export function classifyCaseOutcome(events: readonly AnalyticsEvent[]): CaseOutcome;
export function rateMetric(numerator: number, denominator: number): RateMetric;
export function durationMetric(seconds: readonly number[]): DurationMetric;
export function sanitizePatternText(value: string): string[];
export function recurringPatterns(rows: readonly PatternSource[], scope: AnalyticsScope): AnalyticsPattern[];
export function suppressCommunityBreakdown(rows: readonly RawBreakdown[]): AnalyticsBreakdownItem[];
```

Use `Math.round((numerator / denominator) * 1000) / 10` for percentages. For YTD, use January 1
00:00:00 UTC. For community patterns require 5 reports and 3 distinct users; personal patterns
require 2 reports and have no cross-user threshold. Return at most 10 phrases, ordered by report
count descending and phrase ascending. Phrase lengths are 1–3 normalized tokens. Do not log or
return rejected pattern candidates.

- [ ] **Step 4: Run pure analytics tests**

Run: `npm.cmd test -w @discord-dsa/api -- analytics.test.ts`

Expected: PASS for period resolution, appeal classification, rate semantics, suppression, and sanitization.

- [ ] **Step 5: Commit the analytics rules**

```powershell
git add -- apps/api/src/analytics.ts apps/api/test/analytics.test.ts
git commit -m "feat(api): define analytics classification rules"
```

### Task 3: Authoritative database aggregation and Action History

**Files:**
- Modify: `apps/api/src/database.ts`
- Modify: `apps/api/test/analytics.test.ts`

**Interfaces:**
- Consumes: `resolveAnalyticsInterval()` and pure aggregation helpers from Task 2.
- Produces: `Database.reportAnalytics()`, `Database.communityAnalytics()`, and `Database.actionHistory()`.

- [ ] **Step 1: Add failing database-source tests around exported row aggregation**

Extend `apps/api/test/analytics.test.ts` with source rows where failed root `root-1` points to
successful actioned successor `retry-1`. Assert that the source produces one case, two attempts, one
retry, one sent attempt, and one direct action. Add a second source whose event order is closed,
review-requested, actioned and assert `appealActioned: 1`.

```ts
expect(aggregateAnalyticsRows({
  reports: [
    {
      id: "root-1", rootId: "root-1", retryOfReportId: null,
      createdAt: "2026-08-05T00:00:00.000Z", status: "failed",
      discordReportId: null, flow: "message_urf", category: "illegal_content",
      country: "DE", submitterDiscordUserId: "user-1", submittedText: "first attempt"
    },
    {
      id: "retry-1", rootId: "root-1", retryOfReportId: "root-1",
      createdAt: "2026-08-05T01:00:00.000Z", status: "submitted",
      discordReportId: "discord-1", flow: "message_urf", category: "illegal_content",
      country: "DE", submitterDiscordUserId: "user-1", submittedText: "second attempt"
    }
  ],
  events: [
    { reportId: "retry-1", type: "report_submitted", occurredAt: "2026-08-05T01:02:00.000Z", discordStatus: null },
    { reportId: "retry-1", type: "discord_status_updated", occurredAt: "2026-08-06T01:02:00.000Z", discordStatus: "actioned" }
  ]
})).toMatchObject({
  volume: { newCases: 1, attempts: 2, retries: 1, sentAttempts: 1 },
  outcomes: { directActioned: 1, appealActioned: 0 }
});
```

- [ ] **Step 2: Run the test and verify retry-chain failure**

Run: `npm.cmd test -w @discord-dsa/api -- analytics.test.ts`

Expected: FAIL because `aggregateAnalyticsRows()` and the database row models are absent.

- [ ] **Step 3: Add indexes and query methods**

Append idempotent indexes to `SCHEMA_SQL`:

```sql
CREATE INDEX IF NOT EXISTS reports_created_at_idx ON reports(created_at, id);
CREATE INDEX IF NOT EXISTS report_events_type_created_idx
  ON report_events(event_type, created_at, report_id);
```

Add `AnalyticsSourceReport`, `AnalyticsSourceEvent`, and
`aggregateAnalyticsRows({ reports, events })` to `apps/api/src/analytics.ts`, using the exact fields
shown in the failing fixture. Add these public database methods:

```ts
public async reportAnalytics(discordUserId: string, period: AnalyticsPeriod): Promise<ReportAnalytics>;
public async communityAnalytics(period: AnalyticsPeriod): Promise<ReportAnalytics>;
public async actionHistory(input: {
  discordUserId: string;
  interval: AnalyticsInterval;
  after: string | null;
  limit: number;
}): Promise<ActionHistoryPage>;
```

For case outcomes, begin with roots where `retry_of_report_id IS NULL` and `created_at` is inside the
interval, then use a recursive CTE over `retried_as_report_id` to obtain the latest chain member.
Query events for every member of each selected chain and order by event ID. Separately select all
attempts created inside the interval for reliability counts. Fetch only actioned explanations needed
for bounded pattern analysis.

Action History must include `submitter_discord_user_id = $1`, require current `discord_status =
'actioned'`, order by `(discord_status_updated_at DESC, id DESC)`, and encode the next cursor as
base64url JSON containing those two values. Validate decoded cursors before using parameterized
keyset predicates; never interpolate cursor values into SQL.

- [ ] **Step 4: Run API analytics tests**

Run: `npm.cmd test -w @discord-dsa/api -- analytics.test.ts`

Expected: PASS, including retry-chain de-duplication and appeal sequencing.

- [ ] **Step 5: Commit database analytics**

```powershell
git add -- apps/api/src/database.ts apps/api/test/analytics.test.ts
git commit -m "feat(api): aggregate report analytics and history"
```

### Task 4: Authenticated API routes

**Files:**
- Modify: `apps/api/src/server.ts`
- Modify: `apps/api/test/backend.test.ts`
- Modify: `docs/BOT_API.md`

**Interfaces:**
- Consumes: the three Database methods from Task 3.
- Produces: authenticated personal analytics, community analytics, and Action History endpoints.

- [ ] **Step 1: Write failing route tests**

Add Fastify tests that assert:

```ts
expect((await app.inject({
  method: "GET",
  url: "/v1/users/1197857362942378017/analytics?period=7d",
  headers: { authorization: "Bearer test-api-key" }
})).statusCode).toBe(200);

expect((await app.inject({
  method: "GET",
  url: "/v1/users/not-a-snowflake/action-history?period=7d",
  headers: { authorization: "Bearer test-api-key" }
})).statusCode).toBe(400);
```

Also assert invalid periods, invalid dates, reversed dates, invalid cursors, and limits outside 1–25
return stable `invalid_analytics_query` errors without invoking database methods.

- [ ] **Step 2: Run the backend route tests and verify they fail**

Run: `npm.cmd test -w @discord-dsa/api -- backend.test.ts`

Expected: FAIL with 404 responses for the new routes.

- [ ] **Step 3: Implement route validation and responses**

Register:

```text
GET /v1/users/:discordUserId/analytics?period=7d
GET /v1/analytics/community?period=7d
GET /v1/users/:discordUserId/action-history?period=7d&startAt=&endAt=&after=&limit=10
```

Reuse the existing Discord snowflake validation. Accept `startAt` and `endAt` only together; when
present, ignore `period` for interval construction and require UTC ISO timestamps produced by the
bot's inclusive-date conversion. Cap history pages at 25. All routes use the existing bearer
authorization pre-handler.

Document the DTOs, cohort semantics, UTC boundaries, suppression thresholds, pagination, and the
fact that service authentication does not replace bot ownership enforcement.

- [ ] **Step 4: Run API tests**

Run: `npm.cmd test -w @discord-dsa/api`

Expected: PASS for existing report lifecycle behavior and all analytics routes.

- [ ] **Step 5: Commit API routes and contract documentation**

```powershell
git add -- apps/api/src/server.ts apps/api/test/backend.test.ts docs/BOT_API.md
git commit -m "feat(api): expose report analytics endpoints"
```

### Task 5: Local chart renderer and analytics UI

**Files:**
- Modify: `apps/bot/package.json`
- Modify: `package-lock.json`
- Create: `apps/bot/src/analytics-charts.ts`
- Create: `apps/bot/src/analytics-ui.ts`
- Create: `apps/bot/test/analytics-fixtures.ts`
- Create: `apps/bot/test/analytics.test.ts`

**Interfaces:**
- Consumes: `ReportAnalytics`, `ActionHistoryPage`, and existing Discord embed conventions.
- Produces: `renderAnalyticsChart()`, `analyticsView()`, `analyticsComponents()`, `actionHistoryModal()`, and `actionHistoryView()`.

- [ ] **Step 1: Install the local renderer**

Run: `npm.cmd install @napi-rs/canvas -w @discord-dsa/bot`

Expected: `apps/bot/package.json` and the root lockfile contain one production dependency; no hosted
chart service is added.

- [ ] **Step 2: Write failing chart and embed tests**

```ts
import { describe, expect, it } from "vitest";
import { renderAnalyticsChart } from "../src/analytics-charts.js";
import { analyticsView } from "../src/analytics-ui.js";
import { analyticsFixture } from "./analytics-fixtures.js";

it("renders a PNG without embedding report content", async () => {
  const png = await renderAnalyticsChart("volume", analyticsFixture());
  expect(png.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  expect(png.includes(Buffer.from("submitted explanation"))).toBe(false);
});

it("labels actioned results without claiming bans", () => {
  const payload = analyticsView(analyticsFixture(), "overview");
  const text = JSON.stringify(payload);
  expect(text).toContain("Actioned");
  expect(text.toLowerCase()).not.toContain("ban");
});
```

Create `analytics-fixtures.ts` with these exports and complete valid DTO defaults. The personal
default contains one seven-day series point, one flow/category/country bucket, no patterns, and
non-zero rate denominators. The community fixture changes only `scope` and the approved aggregate
counts.

```ts
import type { ReportAnalytics } from "@discord-dsa/contracts";

export function analyticsFixture(
  overrides: Partial<ReportAnalytics> = {}
): ReportAnalytics {
  const base: ReportAnalytics = {
    availability: "available",
    scope: "personal",
    interval: {
      period: "7d",
      startAt: "2026-08-04T12:00:00.000Z",
      endAt: "2026-08-11T12:00:00.000Z",
      asOf: "2026-08-11T12:00:00.000Z",
      timezone: "UTC"
    },
    volume: {
      newCases: 3,
      attempts: 3,
      retries: 0,
      sentAttempts: 3,
      pendingAttempts: 0,
      failedAttempts: 0
    },
    outcomes: {
      awaitingResponse: 0,
      awaitingDecision: 1,
      directActioned: 1,
      closedNoAction: 1,
      appealsStarted: 1,
      appealActioned: 0,
      appealsDenied: 0
    },
    rates: {
      submission: { numerator: 3, denominator: 3, percentage: 100 },
      action: { numerator: 1, denominator: 2, percentage: 50 },
      appealAction: { numerator: 0, denominator: 0, percentage: null }
    },
    timing: {
      reply: { sampleSize: 2, medianSeconds: 3600, p90Seconds: 7200 },
      decision: { sampleSize: 2, medianSeconds: 86400, p90Seconds: 172800 },
      appealDecision: { sampleSize: 0, medianSeconds: null, p90Seconds: null }
    },
    breakdowns: {
      flows: [{ key: "message_urf", label: "Message", count: 3, percentage: 100 }],
      categories: [{ key: "illegal_content", label: "Illegal content", count: 3, percentage: 100 }],
      countries: [{ key: "DE", label: "Germany", count: 3, percentage: 100 }]
    },
    series: [{
      bucketStart: "2026-08-04T12:00:00.000Z",
      reportCount: 3,
      medianReplySeconds: 3600
    }],
    patterns: []
  };
  return { ...base, ...overrides };
}

export function communityFixture(
  overrides: Partial<ReportAnalytics> = {}
): ReportAnalytics {
  return analyticsFixture({ scope: "community", ...overrides });
}
```

- [ ] **Step 3: Run the tests and verify they fail**

Run: `npm.cmd test -w @discord-dsa/bot -- analytics.test.ts`

Expected: FAIL because the chart and UI modules do not exist.

- [ ] **Step 4: Implement deterministic charts and four views**

```ts
export type AnalyticsView = "overview" | "trends" | "outcomes" | "history";
export type AnalyticsChart = "volume" | "reply_time";

export async function renderAnalyticsChart(
  chart: AnalyticsChart,
  analytics: ReportAnalytics
): Promise<Buffer>;

export function analyticsView(
  analytics: ReportAnalytics,
  view: Exclude<AnalyticsView, "history">
): { embeds: EmbedBuilder[]; files: AttachmentBuilder[]; components: ActionRowBuilder<MessageActionRowComponentBuilder>[] };
```

Use an 1100×420 canvas, the existing Discord dark palette, visible axis labels, and no report-derived
free text. Limit every embed field to Discord limits and include textual totals even when a chart is
attached. `analyticsComponents()` uses custom IDs shaped as
`analytics:<view>:<scope>:<period>:<cursor-token>`, omitting the cursor outside history. The custom
history modal ID is `analytics:history-range` with `start_date` and `end_date` text inputs.

If `renderAnalyticsChart()` throws, `analyticsView()` returns the same embeds without files and with
a short “Chart unavailable; totals are shown above” footer addition.

- [ ] **Step 5: Run bot analytics UI tests**

Run: `npm.cmd test -w @discord-dsa/bot -- analytics.test.ts`

Expected: PASS for the PNG signature, safe labels, embed limits, control IDs, and text fallback.

- [ ] **Step 6: Commit chart and UI primitives**

```powershell
git add -- apps/bot/package.json package-lock.json apps/bot/src/analytics-charts.ts apps/bot/src/analytics-ui.ts apps/bot/test/analytics-fixtures.ts apps/bot/test/analytics.test.ts
git commit -m "feat(bot): render analytics dashboard views"
```

### Task 6: Analytics command and interaction navigation

**Files:**
- Modify: `apps/bot/src/commands.ts`
- Modify: `apps/bot/src/interactions.ts`
- Modify: `apps/bot/test/analytics.test.ts`
- Modify: `docs/BOT_IMPLEMENTATION.md`

**Interfaces:**
- Consumes: Task 1 `DsaApi` methods and Task 5 UI functions.
- Produces: `/analytics`, stateless view/scope/period navigation, custom history ranges, and history pagination.

- [ ] **Step 1: Write failing command and ownership tests**

Assert that `COMMANDS` contains `/analytics` with optional string choice `period`, default handling
requests personal `7d`, Community buttons call only `communityAnalytics()`, and every Action History
path passes `interaction.user.id` as the first `actionHistory` argument rather than accepting a user
ID from a component or modal.

```ts
expect(api.actionHistory).toHaveBeenCalledWith(
  interaction.user.id,
  expect.objectContaining({ period: "7d", limit: 10 })
);
expect(interaction.editReply).toHaveBeenCalledWith(
  expect.objectContaining({ allowedMentions: { parse: [] } })
);
```

- [ ] **Step 2: Run focused tests and verify failure**

Run: `npm.cmd test -w @discord-dsa/bot -- analytics.test.ts`

Expected: FAIL because `/analytics` is not registered or dispatched.

- [ ] **Step 3: Register and dispatch the hub**

Add a user-installed `/analytics` command with one optional choice-backed `period` option using the
six contract values. Add `case "analytics"` to `handleChatInput()`. Defer ephemerally before API
calls. Add early branches to modal, select, and button handlers for `analytics:*` custom IDs.

Validate custom history dates with `YYYY-MM-DD`, convert the inclusive end date to the next UTC
midnight, reject reversed ranges, and cap ranges at 3660 days. Component state contains only approved
enum values and opaque API cursors; never include a Discord user ID in a custom ID.

- [ ] **Step 4: Run bot analytics tests**

Run: `npm.cmd test -w @discord-dsa/bot -- analytics.test.ts`

Expected: PASS for registration, ephemeral deferral, stateless navigation, personal history,
date conversion, invalid-date errors, pagination, and chart fallback.

- [ ] **Step 5: Update implementation documentation**

Document the four views, Personal/Community behavior, all periods, custom Action History dates,
local chart rendering, privacy thresholds, cohort semantics, and “Action taken” terminology in
`docs/BOT_IMPLEMENTATION.md`.

- [ ] **Step 6: Commit command wiring and documentation**

```powershell
git add -- apps/bot/src/commands.ts apps/bot/src/interactions.ts apps/bot/test/analytics.test.ts docs/BOT_IMPLEMENTATION.md
git commit -m "feat(bot): add private analytics hub"
```

### Task 7: Full analytics verification

**Files:**
- Modify only files required to correct failures introduced by Tasks 1–6.

**Interfaces:**
- Consumes: complete analytics hub.
- Produces: repository-wide validation evidence.

- [ ] **Step 1: Run formatting and static validation**

Run:

```powershell
npm.cmd run lint
npm.cmd run typecheck
```

Expected: both commands exit 0.

- [ ] **Step 2: Run all tests and build**

Run:

```powershell
npm.cmd test
npm.cmd run build
```

Expected: all workspaces pass and production TypeScript output builds.

- [ ] **Step 3: Run the required security audit**

Run: `npm.cmd run audit:high`

Expected: exit 0 with no high-severity production dependency advisory. If the canvas dependency has
a high-severity advisory, stop and replace it with a locally rendered dependency that passes the
same chart tests; do not waive the audit.

- [ ] **Step 4: Inspect the final diff and commit verification fixes**

Run:

```powershell
git diff --check
git status --short
```

Expected: no whitespace errors and only analytics-scope changes. If verification required code
changes, stage only those exact files and commit them as `fix: complete analytics verification`.
