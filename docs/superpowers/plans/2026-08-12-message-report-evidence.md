# Message Report Evidence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist full reported-message evidence in the API PostgreSQL report record and show the captured author identity and avatar on every message-report card.

**Architecture:** Define one shared evidence union in `@discord-dsa/contracts`, use it in the bot draft from capture through submission, validate it at the API boundary, and persist it in the existing `reports.input jsonb`. Report details return the same evidence to the bot; two partial PostgreSQL expression indexes support later author/message lookup, while inaccessible pasted links remain reportable with an explicit unavailable state.

**Tech Stack:** TypeScript, discord.js, Fastify, PostgreSQL JSONB, Vitest, npm workspaces.

## Global Constraints

- The API remains the canonical report/evidence owner; the bot must never read API tables.
- Existing reports and rolling deployments without `messageEvidence` remain compatible.
- Store exact message text and attachment/embed metadata, but do not download attachment binaries.
- Never send snapshot content or media URLs to logs, Brave, or Fireworks beyond the existing non-media textual prompt fields.
- Never replace captured evidence during retry or rewrite; only historical reports with no evidence may be resolved again.
- Preserve idempotency and never retry an ambiguous final Discord submission.
- Update `docs/BOT_API.md` and `docs/BOT_IMPLEMENTATION.md` because the public contract and bot-visible behavior change.
- After every TypeScript change group, run focused tests; before completion run lint, workspace typecheck, all tests, build, and `audit:high`.

---

### Task 1: Shared evidence contract and Discord capture

**Files:**
- Modify: `packages/report-contracts/src/types.ts`
- Modify: `apps/bot/src/types.ts`
- Modify: `apps/bot/src/message-resolver.ts`
- Test: `apps/bot/test/message-resolver.test.ts`
- Test: `packages/report-contracts/test/contracts.test.ts`

**Interfaces:**
- Produces: `ReportedMessageSnapshot`, `CapturedMessageEvidence`, `UnavailableMessageEvidence`, and `MessageEvidence` from `@discord-dsa/contracts`.
- Produces: `capturedMessageEvidence(message, source, capturedAt?) => CapturedMessageEvidence` and `unavailableMessageEvidence(attemptedAt?) => UnavailableMessageEvidence`.
- Changes: `ReportDraft.messageSnapshot` becomes `ReportDraft.messageEvidence?: MessageEvidence`.

- [ ] **Step 1: Write failing snapshot tests**

Extend `apps/bot/test/message-resolver.test.ts` so the first fixture includes Discord avatar, attachment size/spoiler metadata, and an embed, then asserts the complete captured evidence:

```ts
const evidence = capturedMessageEvidence(
  {
    id: "323456789012345678",
    channelId: "223456789012345678",
    channel: { name: "reports" },
    guildId: "123456789012345678",
    guild: { name: "Example server" },
    author: {
      id: "423456789012345678",
      username: "example",
      globalName: "Example Display",
      bot: false,
      displayAvatarURL: () => "https://cdn.discordapp.com/avatars/423/avatar.png"
    },
    member: null,
    content: "Message evidence",
    createdAt: new Date("2026-07-20T00:00:00.000Z"),
    attachments: new Map([["1", {
      name: "evidence.png",
      url: "https://cdn.discordapp.com/evidence.png",
      contentType: "image/png",
      size: 1234,
      spoiler: true
    }]]),
    embeds: [{ title: "Evidence", description: "Embedded text", url: "https://example.test/e" }]
  } as unknown as Message,
  "context_menu",
  "2026-07-20T00:01:00.000Z"
);
expect(evidence).toMatchObject({
  source: "context_menu",
  status: "captured",
  capturedAt: "2026-07-20T00:01:00.000Z",
  snapshot: {
    messageId: "323456789012345678",
    authorAvatarUrl: "https://cdn.discordapp.com/avatars/423/avatar.png",
    attachments: [{ size: 1234, spoiler: true }],
    embeds: [{ title: "Evidence", description: "Embedded text" }]
  }
});
```

Add a second assertion for `unavailableMessageEvidence("2026-07-20T00:01:00.000Z")` returning exactly `{ source: "message_link", status: "unavailable", attemptedAt: ... }`.

- [ ] **Step 2: Run the bot resolver test and verify RED**

Run: `npm.cmd test -w @discord-dsa/bot -- message-resolver.test.ts`

Expected: FAIL because the evidence helpers and new metadata do not exist.

- [ ] **Step 3: Add the shared types and capture helpers**

In `packages/report-contracts/src/types.ts`, add:

```ts
export interface ReportedMessageSnapshot {
  messageId: string;
  channelId: string;
  channelName: string | null;
  serverId: string | null;
  serverName: string | null;
  authorId: string;
  authorUsername: string;
  authorDisplayName: string | null;
  authorAvatarUrl: string | null;
  authorBot: boolean;
  content: string;
  createdAt: string;
  attachments: Array<{
    name: string;
    url: string;
    contentType: string | null;
    size: number;
    spoiler: boolean;
  }>;
  embeds: Array<{
    title: string | null;
    description: string | null;
    url: string | null;
  }>;
}

export interface CapturedMessageEvidence {
  source: "context_menu" | "message_link";
  status: "captured";
  capturedAt: string;
  snapshot: ReportedMessageSnapshot;
}

export interface UnavailableMessageEvidence {
  source: "message_link";
  status: "unavailable";
  attemptedAt: string;
}

export type MessageEvidence = CapturedMessageEvidence | UnavailableMessageEvidence;
```

Add `messageEvidence?: MessageEvidence` to message create input and message reported details. Import `MessageEvidence` in `apps/bot/src/types.ts`, replace `messageSnapshot?: MessageSnapshot`, and remove the local `MessageSnapshot` interface.

In `apps/bot/src/message-resolver.ts`, keep `snapshotMessage(message)` returning `ReportedMessageSnapshot`, add the new avatar/attachment fields, and implement:

```ts
export function capturedMessageEvidence(
  message: Message,
  source: CapturedMessageEvidence["source"],
  capturedAt = new Date().toISOString()
): CapturedMessageEvidence {
  return { source, status: "captured", capturedAt, snapshot: snapshotMessage(message) };
}

export function unavailableMessageEvidence(
  attemptedAt = new Date().toISOString()
): UnavailableMessageEvidence {
  return { source: "message_link", status: "unavailable", attemptedAt };
}
```

- [ ] **Step 4: Update resolver expectations and verify GREEN**

Keep `MessageResolver.resolve()` returning `ReportedMessageSnapshot | null`. Update the existing resolver tests only for the renamed shared type and added required fixture methods/properties.

Run: `npm.cmd test -w @discord-dsa/bot -- message-resolver.test.ts`

Expected: PASS.

- [ ] **Step 5: Verify the shared contract compiles and commit**

Run: `npm.cmd test -w @discord-dsa/contracts`

Expected: PASS.

Commit only the five Task 1 files:

```powershell
git add -- packages/report-contracts/src/types.ts packages/report-contracts/test/contracts.test.ts apps/bot/src/types.ts apps/bot/src/message-resolver.ts apps/bot/test/message-resolver.test.ts
git commit -m "feat: define message report evidence"
```

### Task 2: API validation, persistence, and lookup indexes

**Files:**
- Modify: `apps/api/src/validation.ts`
- Modify: `apps/api/src/server.ts`
- Modify: `apps/api/src/database.ts`
- Test: `apps/api/test/backend.test.ts`

**Interfaces:**
- Consumes: `MessageEvidence` and `ReportedMessageSnapshot` from Task 1.
- Produces: `parseCreateReportInput()` validated `messageEvidence` and `ReportDetail.reportedDetails.messageEvidence`.
- Produces indexes `reports_message_author_id_idx` and `reports_message_id_idx`.

- [ ] **Step 1: Write failing API boundary tests**

In `apps/api/test/backend.test.ts`, add a valid captured fixture whose URL IDs match its snapshot, then assert parsing preserves exact content and metadata. Add separate tests that reject a mismatched channel ID, message ID, guild ID, invalid timestamp, oversized content, unsafe/non-HTTPS URLs, more than 25 attachments/embeds, negative/non-integer attachment size, and invalid snowflakes. Add compatibility tests for absent evidence and unavailable link evidence.

The central happy-path assertion is:

```ts
const parsed = parseCreateReportInput({
  country: "DE",
  flow: "message_urf",
  reportReason: "Illegal content",
  reportType: "sub_other_hate_speech",
  messageUrl: "https://discord.com/channels/123456789012345678/223456789012345678/323456789012345678",
  messageEvidence: {
    source: "message_link",
    status: "captured",
    capturedAt: "2026-07-20T00:01:00.000Z",
    snapshot: {
      messageId: "323456789012345678",
      channelId: "223456789012345678",
      channelName: "reports",
      serverId: "123456789012345678",
      serverName: "Example server",
      authorId: "423456789012345678",
      authorUsername: "example",
      authorDisplayName: "Example Display",
      authorAvatarUrl: "https://cdn.discordapp.com/avatar.png",
      authorBot: false,
      content: "Exact evidence",
      createdAt: "2026-07-20T00:00:00.000Z",
      attachments: [],
      embeds: []
    }
  }
});
expect(parsed.messageEvidence?.status).toBe("captured");
expect(parsed.messageEvidence?.status === "captured" && parsed.messageEvidence.snapshot.content)
  .toBe("Exact evidence");
```

Use explicit limits in tests: message content 4,000 characters, names 256, channel/server/display names 100, username 100, embed title 256, embed description 4,096, URL 2,048, and at most 25 attachments and 25 embeds.

- [ ] **Step 2: Run the API test and verify RED**

Run: `npm.cmd test -w @discord-dsa/api -- backend.test.ts`

Expected: FAIL because the API currently drops `messageEvidence` and has no evidence validators or indexes.

- [ ] **Step 3: Implement strict evidence parsing**

In `apps/api/src/validation.ts`, add focused helpers `optionalMessageEvidence(input)` and `reportedMessageSnapshot(value)`. Reuse `record`, `requiredString`, and `optionalString`; add small helpers for ISO timestamps, nullable bounded strings, HTTPS URLs, booleans, non-negative integer sizes, and bounded record arrays.

Use a dedicated bounded raw-string helper for `snapshot.content` and embed descriptions. It must validate length without trimming or whitespace normalization so the persisted evidence remains byte-for-character identical to the captured Discord text. Identifier, name, and URL fields may continue using the existing trimmed-string helpers.

For captured evidence:

```ts
const messageEvidence = optionalMessageEvidence(input);
const url = new URL(messageUrl);
const [, , urlServerId, urlChannelId, urlMessageId] = url.pathname.split("/");
if (messageEvidence?.status === "captured") {
  const snapshot = messageEvidence.snapshot;
  if (snapshot.channelId !== urlChannelId || snapshot.messageId !== urlMessageId) {
    throw new Error("messageEvidence snapshot must match messageUrl.");
  }
  if (urlServerId !== "@me" && snapshot.serverId !== urlServerId) {
    throw new Error("messageEvidence serverId must match messageUrl.");
  }
}
return {
  ...base,
  flow,
  messageUrl,
  ...(messageEvidence === undefined ? {} : { messageEvidence })
};
```

Reject `status: "unavailable"` unless `source === "message_link"`. Do not include rejected evidence values in error messages or logs.

- [ ] **Step 4: Return evidence in report details and preserve it in Discord draft conversion**

In `apps/api/src/server.ts`, add `messageEvidence` to the message branch of `reportedDetails()`. In `apps/api/src/validation.ts`, keep `toReportDraft()` restricted to the fields Discord actually needs: it must continue returning only `messageUrl` for `message_urf`, proving that stored evidence does not enter the low-level Discord submission payload.

- [ ] **Step 5: Add the two JSONB lookup indexes**

In `SCHEMA_SQL` in `apps/api/src/database.ts`, add:

```sql
CREATE INDEX IF NOT EXISTS reports_message_author_id_idx
  ON reports ((input #>> '{messageEvidence,snapshot,authorId}'))
  WHERE flow = 'message_urf'
    AND input #>> '{messageEvidence,status}' = 'captured';
CREATE INDEX IF NOT EXISTS reports_message_id_idx
  ON reports ((input #>> '{messageEvidence,snapshot,messageId}'))
  WHERE flow = 'message_urf'
    AND input #>> '{messageEvidence,status}' = 'captured';
```

Add schema assertions to the existing migration/schema test so both exact index names and JSON paths are protected.

- [ ] **Step 6: Verify API GREEN and commit**

Run: `npm.cmd test -w @discord-dsa/api -- backend.test.ts`

Expected: PASS, including evidence round-trip and retry preservation through the existing `parseCreateReportInput({ ...report.input })` path.

Commit only the Task 2 files:

```powershell
git add -- apps/api/src/validation.ts apps/api/src/server.ts apps/api/src/database.ts apps/api/test/backend.test.ts
git commit -m "feat(api): persist message report evidence"
```

### Task 3: Carry evidence through every bot report path

**Files:**
- Modify: `apps/bot/src/types.ts`
- Modify: `apps/bot/src/message-resolver.ts`
- Modify: `apps/bot/src/interactions.ts`
- Modify: `apps/bot/src/ui.ts`
- Modify: `apps/bot/src/report-writer.ts`
- Modify: `apps/bot/src/brave-research.ts`
- Modify: `apps/bot/src/experimental-batch-worker.ts`
- Test: `apps/bot/test/bot.test.ts`
- Test: `apps/bot/test/report-writer.test.ts`
- Test: `apps/bot/test/brave-research.test.ts`
- Test: `apps/bot/test/experimental-batches.test.ts`

**Interfaces:**
- Consumes: Task 1 evidence union and capture helpers.
- Produces: `capturedMessageSnapshot(evidence): ReportedMessageSnapshot | undefined` as a small bot-local helper in `apps/bot/src/types.ts`.
- Changes: `draftToCreateInput()` includes `messageEvidence` when present.

- [ ] **Step 1: Write failing context-menu and link-flow tests**

In `apps/bot/test/bot.test.ts`, extend the existing Report Message and Quick Report fixtures so `targetMessage.author.displayAvatarURL()` returns a CDN URL. Assert the saved/decrypted draft contains captured `context_menu` evidence. Extend the `/report message` preparation test with two cases:

```ts
messageResolver: {
  resolve: vi.fn().mockResolvedValue(messageSnapshot)
} as unknown as MessageResolver
```

must lead to `source: "message_link", status: "captured"`; a resolver returning `null` must lead to `source: "message_link", status: "unavailable"` while still reaching report review/creation.

Add a `draftToCreateInput()` assertion that the evidence is included unchanged in the API request.

- [ ] **Step 2: Run focused bot tests and verify RED**

Run: `npm.cmd test -w @discord-dsa/bot -- bot.test.ts report-writer.test.ts brave-research.test.ts experimental-batches.test.ts`

Expected: FAIL because bot drafts still use `messageSnapshot` and API requests omit the evidence.

- [ ] **Step 3: Convert context-menu and link paths to the evidence union**

In `apps/bot/src/interactions.ts`:

- Replace every context-menu `messageSnapshot: snapshotMessage(interaction.targetMessage)` with `messageEvidence: capturedMessageEvidence(interaction.targetMessage, "context_menu")`.
- Wherever a message link is resolved, set captured link evidence around the resolved snapshot or unavailable evidence on `null`.
- Do not resolve again when `draft.messageEvidence?.status === "captured"`.
- On rewrite, copy `details.messageEvidence` into the new draft. Only call `MessageResolver` when `details.messageEvidence` is absent, for historical compatibility.

Use a helper accepting an already-resolved snapshot so timestamps remain explicit:

```ts
export function resolvedMessageEvidence(
  snapshot: ReportedMessageSnapshot,
  capturedAt = new Date().toISOString()
): CapturedMessageEvidence {
  return { source: "message_link", status: "captured", capturedAt, snapshot };
}
```

Add `capturedMessageSnapshot()` in `apps/bot/src/types.ts`:

```ts
export function capturedMessageSnapshot(
  evidence: MessageEvidence | undefined
): ReportedMessageSnapshot | undefined {
  return evidence?.status === "captured" ? evidence.snapshot : undefined;
}
```

- [ ] **Step 4: Adapt AI/research/experimental consumers without widening media exposure**

In `report-writer.ts`, `brave-research.ts`, and `experimental-batch-worker.ts`, replace reads of `draft.messageSnapshot` with `capturedMessageSnapshot(draft.messageEvidence)`. Keep the current prompt behavior: textual message, author, timestamps, filenames/content types, and embed text may be used; avatar, attachment, and embed URLs remain excluded while media processing is disabled. Update associated fixtures from `messageSnapshot` to captured `messageEvidence`.

- [ ] **Step 5: Include evidence in the typed API request**

In the message branch of `draftToCreateInput()`:

```ts
return {
  ...common,
  flow: draft.flow,
  messageUrl: draft.messageUrl,
  ...(draft.messageEvidence === undefined ? {} : { messageEvidence: draft.messageEvidence })
};
```

The existing encrypted bot tracking request then automatically retains the same typed value without adding a second plaintext bot table.

- [ ] **Step 6: Verify bot GREEN and commit**

Run: `npm.cmd test -w @discord-dsa/bot -- bot.test.ts report-writer.test.ts brave-research.test.ts experimental-batches.test.ts`

Expected: PASS, with Quick Report, normal context-menu, link success/failure, AI prompt, sensitive-query filtering, and batch display behavior unchanged except for evidence retention.

Commit only the Task 3 files:

```powershell
git add -- apps/bot/src/types.ts apps/bot/src/interactions.ts apps/bot/src/ui.ts apps/bot/src/report-writer.ts apps/bot/src/brave-research.ts apps/bot/src/experimental-batch-worker.ts apps/bot/test/bot.test.ts apps/bot/test/report-writer.test.ts apps/bot/test/brave-research.test.ts apps/bot/test/experimental-batches.test.ts
git commit -m "feat(bot): retain message evidence across report flows"
```

### Task 4: Render Author info and avatar on message reports

**Files:**
- Modify: `apps/bot/src/ui.ts`
- Test: `apps/bot/test/bot.test.ts`

**Interfaces:**
- Consumes: `ReportDraft.messageEvidence` and `ReportView.reportedDetails.messageEvidence`.
- Produces: bot-local `messageAuthorText(evidence): string` and `messageAuthorAvatar(evidence): string | null`.

- [ ] **Step 1: Write failing review and final-card rendering tests**

Add a captured evidence fixture to the existing complete message draft and `reportFixture()`. Assert both `buildReview()` and `reportEmbed()` contain:

```ts
expect(json.fields?.find((field) => field.name === "Author info")?.value).toBe(
  "Reported user: Example Display (@example)\nDiscord ID: `423456789012345678`"
);
expect(json.thumbnail?.url).toBe(
  "https://cdn.discordapp.com/avatars/423/avatar.png"
);
```

Add separate cases for a null display name (`example (@example)`), unavailable evidence, and historical absent evidence. Both unavailable cases must render `Author information unavailable.` and omit the thumbnail.

- [ ] **Step 2: Run the UI tests and verify RED**

Run: `npm.cmd test -w @discord-dsa/bot -- bot.test.ts`

Expected: FAIL because message report embeds currently render neither Author info nor a message-author thumbnail.

- [ ] **Step 3: Implement bounded, non-mention author rendering**

In `apps/bot/src/ui.ts`, add:

```ts
function messageAuthorText(evidence: MessageEvidence | undefined): string {
  if (evidence?.status !== "captured") return "Author information unavailable.";
  const snapshot = evidence.snapshot;
  const display = snapshot.authorDisplayName ?? snapshot.authorUsername;
  return `Reported user: ${truncate(display, 100)} (@${truncate(snapshot.authorUsername, 100)})\nDiscord ID: \`${snapshot.authorId}\``;
}

function messageAuthorAvatar(evidence: MessageEvidence | undefined): string | null {
  return evidence?.status === "captured" ? evidence.snapshot.authorAvatarUrl : null;
}
```

Add the `Author info` field after `Item` in both `buildReview()` and `reportEmbed()` only for `message_urf`. Set the message author avatar as the thumbnail before profile/server thumbnail handling; each flow can therefore have at most one relevant thumbnail. Keep the message URL as Item and keep full captured content out of Details.

- [ ] **Step 4: Verify UI GREEN and Discord embed limits**

Run: `npm.cmd test -w @discord-dsa/bot -- bot.test.ts`

Expected: PASS, including the existing 6,000-character/25-field embed limit test.

- [ ] **Step 5: Commit the UI change**

```powershell
git add -- apps/bot/src/ui.ts apps/bot/test/bot.test.ts
git commit -m "feat(bot): show reported message author"
```

### Task 5: Canonical documentation and full verification

**Files:**
- Modify: `docs/BOT_API.md`
- Modify: `docs/BOT_IMPLEMENTATION.md`

**Interfaces:**
- Documents: optional shared `messageEvidence` request/response union, JSONB storage and indexes, capture-source semantics, unavailable fallback, retry preservation, UI fields, and evidence logging restrictions.

- [ ] **Step 1: Update the API contract documentation**

In `docs/BOT_API.md`, extend the message create request and message `reportedDetails` examples with both union variants. State exact bounds and URL/snapshot consistency rules, that old reports may omit evidence, that the evidence is stored in `reports.input jsonb`, and that it is never added to the Discord transport payload.

- [ ] **Step 2: Update bot behavior documentation**

In `docs/BOT_IMPLEMENTATION.md`, replace the statement that Action History does not retain the original message. Document direct context capture, best-effort link capture, the unavailable Author info fallback, author avatar thumbnail, stored metadata without binary downloads, original-snapshot preservation on retry/rewrite, and the prohibition on evidence logs/AI media URLs.

- [ ] **Step 3: Check documentation consistency**

Run:

```powershell
rg -n "does not claim to retain|does not retain|messageEvidence|Author info|message snapshot" docs/BOT_API.md docs/BOT_IMPLEMENTATION.md
```

Expected: no stale claim that reported message evidence is never retained; both documents describe `messageEvidence` consistently.

- [ ] **Step 4: Run the complete repository verification gate**

Run each command separately from the repository root:

```powershell
npm.cmd run lint
npm.cmd run typecheck
npm.cmd test
npm.cmd run build
npm.cmd run audit:high
```

Expected: all five commands exit 0. Do not run the protected Discord transport diagnostics.

- [ ] **Step 5: Inspect the final diff and commit documentation**

Run:

```powershell
git diff --check
git status --short
git diff --stat HEAD~4..HEAD
```

Confirm unrelated pre-existing untracked files remain untouched. Then commit only the canonical documentation:

```powershell
git add -- docs/BOT_API.md docs/BOT_IMPLEMENTATION.md
git commit -m "docs: document message report evidence"
```
