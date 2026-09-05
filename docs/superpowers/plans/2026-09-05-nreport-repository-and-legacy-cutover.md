# NReport Repository and Legacy Cutover Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Transfer the account-owned Discord DSA overhaul into the independent NReport repository, namespace it as `discord.dsa`, deploy it with isolated email infrastructure, and convert the original bot/API into a safe read-only legacy system.

**Architecture:** The new checkout is the writable NReport platform and exposes DSA below `/v1/discord/dsa`; the original checkout remains a separate lifecycle archive. The legacy bot and API independently reject new mutations while retaining all workers and interfaces required to finish and display existing reports.

**Tech Stack:** TypeScript 6, npm workspaces, Fastify, PostgreSQL, Discord.js, Cloudflare Email Workers/Wrangler, Vitest, Railway, Git/GitHub.

**Spec:** `docs/superpowers/specs/2026-09-05-nreport-repository-and-legacy-cutover-design.md`

## Global Constraints

- New local checkout: `C:\Users\Zhuoxuan\Documents\nreport`; legacy checkout: `C:\Users\Zhuoxuan\Documents\Discord DSA`.
- New remote: `https://github.com/owen2193213/nreport.git`; never replace the legacy repository's `origin` and never force-push.
- Preserve all uncommitted legacy files, including `packages/discord-dsa-client/src/client.ts`, `packages/discord-dsa-client/test/client.test.ts`, and the currently modified `apps/api/.env.example`, until their ownership is resolved.
- Public service identifier: `discord.dsa`; account base path: `/v1/discord/dsa`; administrator base path: `/v1/admin/discord/dsa`.
- Infrastructure paths `/healthz`, `/openapi.json`, and `/webhooks/cloudflare-email` remain unprefixed.
- New Worker name: `nreport-discord-dsa-email`; trusted envelope sender: exactly `noreply@discord.com`.
- The old and new systems share no database, Discord application, email domain/route, encryption key, API key, webhook secret, or Worker destination.
- Do not run the real Discord transport diagnostics during normal verification.
- Stage named files only; never use broad reset, checkout, clean, or add commands.

---

### Task 1: Freeze and inventory both repository states

**Files:**
- Read: `C:\Users\Zhuoxuan\Documents\Discord DSA\AGENTS.md`
- Read: `C:\Users\Zhuoxuan\Documents\Discord DSA\.worktrees\account-owned-api-overhaul\AGENTS.md`
- Read: both repositories' tracked and untracked status

**Interfaces:**
- Consumes: the existing legacy `main` checkout and `codex/account-owned-api-overhaul` worktree.
- Produces: an operator-reviewed inventory that identifies which dirty files belong to the overhaul and which must remain solely in the legacy checkout.

- [ ] **Step 1: Record the legacy and overhaul status without modifying either checkout**

Run:

```powershell
git -C 'C:\Users\Zhuoxuan\Documents\Discord DSA' status --short --branch
git -C 'C:\Users\Zhuoxuan\Documents\Discord DSA\.worktrees\account-owned-api-overhaul' status --short --branch
git -C 'C:\Users\Zhuoxuan\Documents\Discord DSA' remote -v
git -C 'C:\Users\Zhuoxuan\Documents\Discord DSA' worktree list --porcelain
```

Expected: legacy is on `main`; overhaul is on `codex/account-owned-api-overhaul`; the three known legacy modifications are visible.

- [ ] **Step 2: Inspect the new remote before defining any push**

Run:

```powershell
git ls-remote --symref https://github.com/owen2193213/nreport.git HEAD
git ls-remote --heads https://github.com/owen2193213/nreport.git
```

Expected: either no refs, or a documented existing default branch that must be incorporated without force.

- [ ] **Step 3: Compare the three legacy dirty files with the overhaul worktree**

Run:

```powershell
git -C 'C:\Users\Zhuoxuan\Documents\Discord DSA' diff -- apps/api/.env.example packages/discord-dsa-client/src/client.ts packages/discord-dsa-client/test/client.test.ts
git -C 'C:\Users\Zhuoxuan\Documents\Discord DSA\.worktrees\account-owned-api-overhaul' diff -- apps/api/.env.example packages/discord-dsa-client/src/client.ts packages/discord-dsa-client/test/client.test.ts
```

Expected: every hunk has an explicit destination decision before any commit. Stop if ownership remains ambiguous.

- [ ] **Step 4: Create recoverable database backups and configuration inventories**

Use Railway's PostgreSQL backup/export mechanism for both legacy databases and record service-variable names, domains, Worker routes, and service IDs in the operator's secure deployment records. Do not write secret values to the repository or terminal transcript.

Expected: backups can be identified and restored; no secret value appears in Git.

- [ ] **Step 5: Verify the existing overhaul before establishing its baseline commit**

Run from the overhaul worktree:

```powershell
npm.cmd run lint
npm.cmd run typecheck
npm.cmd test
npm.cmd run build
npm.cmd run audit:high
```

Expected: every command exits zero. This proves the already-implemented overhaul is sound before naming and migration edits are layered over it.

- [ ] **Step 6: Commit the existing overhaul without absorbing legacy or protected files**

Generate the candidate manifest with `git status --porcelain=v1`, inspect each path, and reject the commit if it includes anything below `scripts/`, either user-owned low-level client file, or an unexplained file. Stage each approved manifest path explicitly, verify `git diff --cached --name-status`, and commit:

```powershell
git commit -m "feat: add account-owned automatic reporting API"
```

Expected: the overhaul worktree is clean except for the approved design/plan documents, and the legacy checkout retains its three pre-existing modifications byte-for-byte.

### Task 2: Namespace the NReport contract and typed clients

**Files:**
- Modify: `packages/report-contracts/src/api.ts`
- Modify: `packages/report-contracts/src/types.ts`
- Modify: `packages/report-contracts/src/schemas.ts`
- Modify: `packages/report-contracts/src/index.ts`
- Modify: `packages/report-contracts/test/account-api.test.ts`
- Modify: `packages/report-contracts/test/contracts.test.ts`

**Interfaces:**
- Consumes: existing `DsaApi`, `DsaAdminApi`, DTOs, and exported JSON Schemas.
- Produces: `DSA_API_BASE_PATH`, `DSA_ADMIN_BASE_PATH`, `NreportServiceDescriptor`, and clients that call only the approved paths.

- [ ] **Step 1: Add failing contract tests for the service descriptor and route prefixes**

Add assertions equivalent to:

```ts
expect(NREPORT_DISCORD_DSA_SERVICE).toEqual({ category: "discord", type: "dsa", version: "v1" });
expect(requests.map(({ url }) => new URL(url).pathname)).toContain("/v1/discord/dsa/account");
expect(requests.map(({ url }) => new URL(url).pathname)).toContain("/v1/admin/discord/dsa/accounts");
expect(requests.every(({ url }) => !new URL(url).pathname.startsWith("/v1/reports"))).toBe(true);
```

- [ ] **Step 2: Run the focused tests and confirm they fail on old paths**

Run:

```powershell
npm.cmd test -w @discord-dsa/contracts -- account-api.test.ts contracts.test.ts
```

Expected: failures show the unqualified routes or missing service descriptor.

- [ ] **Step 3: Export the approved constants and type**

Implement:

```ts
export const DSA_API_BASE_PATH = "/v1/discord/dsa" as const;
export const DSA_ADMIN_BASE_PATH = "/v1/admin/discord/dsa" as const;
export const NREPORT_DISCORD_DSA_SERVICE = {
  category: "discord",
  type: "dsa",
  version: "v1"
} as const;
export type NreportServiceDescriptor = typeof NREPORT_DISCORD_DSA_SERVICE;
```

Use these constants for every `DsaApi` and `DsaAdminApi` request. Do not change the unprefixed infrastructure URLs.

- [ ] **Step 4: Run the focused tests**

Run the Task 2 test command again.

Expected: all focused contract tests pass.

- [ ] **Step 5: Commit only the contract changes**

```powershell
git add packages/report-contracts/src/api.ts packages/report-contracts/src/types.ts packages/report-contracts/src/schemas.ts packages/report-contracts/src/index.ts packages/report-contracts/test/account-api.test.ts packages/report-contracts/test/contracts.test.ts
git commit -m "feat(contracts): namespace Discord DSA API"
```

### Task 3: Apply the namespace and NReport identity to the API

**Files:**
- Modify: `apps/api/src/server-v2.ts`
- Modify: `apps/api/test/server-v2.test.ts`
- Modify: `apps/api/src/main.ts`
- Modify: `apps/api/src/config.ts`
- Modify: `apps/api/.env.example`

**Interfaces:**
- Consumes: the route constants and service descriptor from Task 2.
- Produces: matching Fastify routes, OpenAPI paths/tags, catalog service metadata, and NReport-oriented configuration.

- [ ] **Step 1: Add failing API tests for routing and OpenAPI**

Cover all ordinary and administrator routes. Include these exact behavioral checks:

```ts
expect((await app.inject({ method: "GET", url: "/v1/discord/dsa/catalog", headers: auth })).statusCode).toBe(200);
expect((await app.inject({ method: "GET", url: "/v1/catalog", headers: auth })).statusCode).toBe(404);
expect(catalog.service).toEqual({ category: "discord", type: "dsa", version: "v1" });
expect(openapi.info.title).toBe("NReport API");
expect(openapi.paths["/v1/discord/dsa/reports"]).toBeDefined();
expect(openapi.paths["/v1/admin/discord/dsa/accounts"]).toBeDefined();
expect(openapi.paths["/v1/reports"]).toBeUndefined();
```

Also assert that `/healthz`, `/openapi.json`, and `/webhooks/cloudflare-email` retain their current paths.

- [ ] **Step 2: Run the focused API test and verify failure**

```powershell
npm.cmd test -w @discord-dsa/api -- server-v2.test.ts
```

Expected: namespaced route and title assertions fail.

- [ ] **Step 3: Register routes from shared prefixes**

Replace every ordinary literal `/v1/...` registration with `${DSA_API_BASE_PATH}/...` and every administrator registration with `${DSA_ADMIN_BASE_PATH}/...`. Update the OpenAPI paths from the same constants, set its title to `NReport API`, add the approved tags, and include `service: NREPORT_DISCORD_DSA_SERVICE` in the catalog response.

- [ ] **Step 4: Rename consumer-facing configuration without weakening validation**

Expose `NREPORT_API_URL`, `NREPORT_ADMIN_KEY`, and related NReport names in `.env.example` and `AppConfig`. Keep a single canonical environment name in the new repository; do not add fallback aliases for an undeployed API. Update `main.ts` references accordingly.

- [ ] **Step 5: Run API and contract tests**

```powershell
npm.cmd test -w @discord-dsa/contracts
npm.cmd test -w @discord-dsa/api -- server-v2.test.ts
```

Expected: both suites pass and old public route tests have been removed or inverted to assert 404.

- [ ] **Step 6: Commit the API namespace**

```powershell
git add apps/api/src/server-v2.ts apps/api/test/server-v2.test.ts apps/api/src/main.ts apps/api/src/config.ts apps/api/.env.example
git commit -m "feat(api): expose Discord DSA under NReport namespace"
```

### Task 4: Rename workspace metadata and update the NReport bot

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `apps/api/package.json`
- Modify: `apps/bot/package.json`
- Modify: `apps/email-worker/package.json`
- Modify: `packages/report-contracts/package.json`
- Preserve: `packages/discord-dsa-client/package.json`
- Modify: all TypeScript imports containing `@discord-dsa/`
- Modify: `apps/bot/src/config.ts`
- Modify: `apps/bot/src/main.ts`
- Modify: `apps/bot/.env.example`
- Modify: `apps/bot/test/account-overhaul.test.ts`

**Interfaces:**
- Consumes: namespaced `DsaApi` and `DsaAdminApi` from Task 2.
- Produces: an npm workspace named `nreport` whose bot uses NReport variables and paths.

- [ ] **Step 1: Add failing bot configuration/client assertions**

Assert that bot configuration reads `NREPORT_API_URL` and `NREPORT_ADMIN_KEY`, and that a connected account client requests `/v1/discord/dsa/account`, reports, events, and analytics. Assert the admin handler uses `/v1/admin/discord/dsa`.

- [ ] **Step 2: Run the focused bot test**

```powershell
npm.cmd test -w @discord-dsa/bot -- account-overhaul.test.ts
```

Expected: configuration assertions fail before renaming.

- [ ] **Step 3: Rename package metadata and imports mechanically**

Use these exact names:

```text
nreport
@nreport/api
@nreport/contracts
@discord-dsa/client
@nreport/discord-dsa-bot
@nreport/discord-dsa-email-worker
```

Update all workspace dependency names, import specifiers, root scripts, and lockfile workspace records together. Keep exported client class names unchanged.

- [ ] **Step 4: Replace bot API environment names**

Use `NREPORT_API_URL` for the new API base and `NREPORT_ADMIN_KEY` for administrator commands. Keep personal keys in encrypted per-user storage. Remove superseded new-repository-only aliases from `.env.example`.

- [ ] **Step 5: Reinstall lockfile metadata and run workspace tests**

```powershell
npm.cmd install --package-lock-only --ignore-scripts
npm.cmd test -w @nreport/contracts
npm.cmd test -w @nreport/discord-dsa-bot -- account-overhaul.test.ts
npm.cmd run typecheck
```

Expected: platform packages resolve through `@nreport/*`; the protocol-only `@discord-dsa/client` remains available to the API and protected diagnostic scripts; focused tests and typecheck pass.

- [ ] **Step 6: Commit metadata and bot changes**

Stage the explicitly enumerated package files, changed TypeScript imports, bot configuration, test, and lockfile; inspect `git diff --cached` before committing.

Commit:

```powershell
git commit -m "refactor: brand workspace as NReport"
```

### Task 5: Isolate and harden the new Cloudflare Email Worker

**Files:**
- Modify: `apps/email-worker/src/index.ts`
- Modify: `apps/email-worker/test/index.test.ts`
- Modify: `apps/email-worker/wrangler.jsonc`
- Modify: `apps/email-worker/package.json`

**Interfaces:**
- Consumes: `INGEST_URL` and `INGEST_SHARED_SECRET` supplied by the new deployment only.
- Produces: Worker `nreport-discord-dsa-email`, accepting exactly `noreply@discord.com` and forwarding only signed raw mail.

- [ ] **Step 1: Add failing exact-sender tests**

Test that `noreply@discord.com` is accepted and each of these is ignored without a fetch:

```text
support@discord.com
noreply@mail.discord.com
noreply@evil-discord.com
NOREPLY@discord.com.evil.example
```

Retain tests for invalid alias local parts, signed raw-body forwarding, bounded/redacted diagnostics, and a 404 public fetch handler.

- [ ] **Step 2: Run the Worker tests and verify the subdomain case fails**

```powershell
npm.cmd test -w @nreport/discord-dsa-email-worker
```

Expected: `noreply@mail.discord.com` is incorrectly accepted before the fix.

- [ ] **Step 3: Make sender matching exact**

Implement:

```ts
function isDiscordEnvelopeSender(address: string): boolean {
  return address.trim().toLowerCase() === "noreply@discord.com";
}
```

Do not inspect or log message content while rejecting mail.

- [ ] **Step 4: Remove the hard-coded production ingestion URL**

Set Wrangler metadata to name `nreport-discord-dsa-email`. Keep `INGEST_SHARED_SECRET` as a Wrangler secret and inject `INGEST_URL` through the new environment-specific Worker configuration; it must not contain the legacy Railway hostname.

- [ ] **Step 5: Run the Worker tests and commit**

```powershell
npm.cmd test -w @nreport/discord-dsa-email-worker
git add apps/email-worker/src/index.ts apps/email-worker/test/index.test.ts apps/email-worker/wrangler.jsonc apps/email-worker/package.json
git commit -m "fix(email): isolate NReport inbound routing"
```

Expected: tests pass and `rg "discord-dsa-production|domain.endsWith" apps/email-worker` returns no matches.

### Task 6: Update NReport documentation and deployment descriptors

**Files:**
- Modify: `README.md`
- Modify: `AGENTS.md`
- Modify: `docs/BOT_API.md`
- Modify: `docs/BOT_IMPLEMENTATION.md`
- Modify: `docs/AI_REPORTING_FLOW.md`
- Modify: `apps/api/railway.json`
- Modify: `apps/bot/railway.json`
- Modify: repository environment examples

**Interfaces:**
- Consumes: final names, routes, packages, and Worker behavior from Tasks 2–5.
- Produces: operator documentation with no legacy hostname, shared-secret instruction, or unqualified new API route.

- [ ] **Step 1: Add a documentation consistency check**

Run searches before editing and save the match list for review:

```powershell
rg -n 'Discord DSA Reporting API|/v1/(account|catalog|reports|events|analytics|action-history|digest-activity)|@discord-dsa/|dsa-inbound-email|discord-dsa-production' README.md AGENTS.md docs apps packages package.json
```

Expected: matches identify every active document or descriptor requiring migration; historical protocol documents may retain historical terminology when clearly labeled.

- [ ] **Step 2: Rewrite active documentation around the approved hierarchy**

Document NReport, `discord.dsa`, `/v1/discord/dsa`, `/v1/admin/discord/dsa`, personal keys, automatic preparation/submission, independent deployments, the new Worker, and the absence of submitting Discord IDs in the API. Add a separate legacy cutover section that links to this spec and plan.

- [ ] **Step 3: Update Railway watch paths and commands after package renaming**

Ensure the API service watches contracts and low-level client changes, the bot watches contracts and bot files, and Worker/docs-only changes do not accidentally deploy Railway. Preserve separate databases and service start commands.

- [ ] **Step 4: Re-run the consistency search**

Expected: no active new-system document or configuration contains an old platform package name, unqualified public DSA route, old Worker name, or legacy hostname. The intentional `@discord-dsa/client` transport references and any explicitly historical result may remain.

- [ ] **Step 5: Commit documentation and descriptors**

```powershell
git add README.md AGENTS.md docs/BOT_API.md docs/BOT_IMPLEMENTATION.md docs/AI_REPORTING_FLOW.md apps/api/railway.json apps/bot/railway.json apps/api/.env.example apps/bot/.env.example
git commit -m "docs: describe NReport Discord DSA deployment"
```

### Task 7: Verify, transfer, and clone the new repository

**Files:**
- Verify: every tracked file in the overhaul worktree
- Create checkout: `C:\Users\Zhuoxuan\Documents\nreport`

**Interfaces:**
- Consumes: verified NReport commits from Tasks 2–6 and the remote inventory from Task 1.
- Produces: a clean independent clone whose `origin` is `owen2193213/nreport`.

- [ ] **Step 1: Run the completion gate in the overhaul worktree**

```powershell
npm.cmd run lint
npm.cmd run typecheck
npm.cmd test
npm.cmd run build
npm.cmd run audit:high
```

Expected: every command exits zero; the audit reports no high-severity vulnerability. Do not run transport diagnostics.

- [ ] **Step 2: Inspect the complete staged/unstaged state**

```powershell
git status --short --branch
git diff --check
git log --oneline --decorate -10
```

Expected: no uncommitted implementation file remains. Planning documents may be committed separately after user review.

- [ ] **Step 3: Publish without changing the legacy origin**

If Task 1 proved the remote empty, add it to the overhaul checkout as remote `nreport` and push the verified branch to `main` without force. If it was non-empty, fetch it, review histories, and integrate its default branch in a dedicated branch before a normal push. Stop on any non-fast-forward error rather than overriding it.

- [ ] **Step 4: Clone the new remote as a sibling folder**

```powershell
git clone https://github.com/owen2193213/nreport.git 'C:\Users\Zhuoxuan\Documents\nreport'
git -C 'C:\Users\Zhuoxuan\Documents\nreport' remote -v
git -C 'C:\Users\Zhuoxuan\Documents\nreport' status --short --branch
```

Expected: `origin` is only the NReport URL and the checkout is clean on `main`.

- [ ] **Step 5: Verify from the fresh clone**

Run `npm.cmd ci`, lint, typecheck, tests, build, and audit from the new clone. Expected: results match Step 1.

- [ ] **Step 6: Retire the temporary worktree only after clone verification**

Use `git worktree remove` with the exact verified path only when it is clean and all commits exist in the new remote. Do not use recursive filesystem deletion.

### Task 8: Add an explicit legacy API mutation gate

**Files (legacy repository):**
- Modify: `apps/api/src/config.ts`
- Modify: `apps/api/src/server.ts`
- Modify: `apps/api/.env.example`
- Modify: `apps/api/test/backend.test.ts`
- Modify: `docs/BOT_API.md`

**Interfaces:**
- Consumes: `ACCEPT_NEW_REPORTS`, parsed strictly as `true` or `false` and required explicitly in production.
- Produces: `assertReportMutationsEnabled()` behavior returning HTTP 410 and stable code `legacy_read_only` before mutation work.

- [ ] **Step 1: Add failing API shutdown tests**

Build the server with `acceptNewReports: false` and assert HTTP 410 for:

```text
POST /v1/reports
POST /v1/reports/:id/retry
POST /v1/reports/:id/retry-appeal
```

For each response assert `error.code === "legacy_read_only"`. Spy on `generateIdentity`, `database.createReport`, `database.retryReport`, and `database.retryIneligibleReview`; assert none is called. Also assert GET report/history/analytics/events, `/healthz`, and a valid existing-report email correlation remain available.

- [ ] **Step 2: Run the focused legacy API tests and verify failure**

```powershell
npm.cmd test -w @discord-dsa/api -- backend.test.ts
```

Expected: mutation routes still enter their current handlers.

- [ ] **Step 3: Parse the shutdown configuration strictly**

Add `acceptNewReports: boolean` to `AppConfig`. Reject values other than `true` and `false`, require the variable in production, and permit an `active` development/test default only outside production. Document `ACCEPT_NEW_REPORTS=false` as the legacy deployment value.

- [ ] **Step 4: Add a pre-handler before all client mutation logic**

Implement one shared guard that sends:

```json
{
  "error": {
    "code": "legacy_read_only",
    "message": "This service no longer accepts new reports. Use NReport instead."
  }
}
```

with HTTP 410. Register it on create, report retry, and appeal retry. Do not register it on internal email or lifecycle paths.

- [ ] **Step 5: Run legacy API tests and commit**

```powershell
npm.cmd test -w @discord-dsa/api -- backend.test.ts
git add apps/api/src/config.ts apps/api/src/server.ts apps/api/.env.example apps/api/test/backend.test.ts docs/BOT_API.md
git commit -m "feat(api): disable legacy report mutations"
```

Expected: shutdown and existing-lifecycle tests pass.

### Task 9: Define the legacy bot's read-only command surface

**Files (legacy repository):**
- Modify: `apps/bot/src/config.ts`
- Modify: `apps/bot/src/commands.ts`
- Modify: `apps/bot/src/command-registration.ts`
- Modify: `apps/bot/src/presence.ts`
- Modify: `apps/bot/.env.example`
- Modify: `apps/bot/test/config.test.ts`
- Modify: `apps/bot/test/bot.test.ts`

**Interfaces:**
- Consumes: `BOT_MODE=legacy_read_only`.
- Produces: `BotMode = "active" | "legacy_read_only"`, `commandsForMode(mode)`, and a read-only Discord presence.

- [ ] **Step 1: Add failing command-surface tests**

For `legacy_read_only`, assert command registration contains `reports` with only `list` and `status`, `access` with only `status`, `settings`, and `analytics`. Assert it excludes `report`, `admin`, `Report Message`, `Quick Report Message`, `reports retry`, `access redeem`, and all experimental commands.

- [ ] **Step 2: Add failing strict-mode configuration tests**

Assert `BOT_MODE=legacy_read_only` parses successfully and an unknown mode fails startup. Assert legacy mode does not require AI provider, AI key, Brave key, or experimental webhook configuration.

- [ ] **Step 3: Run focused bot tests and verify failure**

```powershell
npm.cmd test -w @discord-dsa/bot -- config.test.ts bot.test.ts
```

- [ ] **Step 4: Implement mode-specific command builders and presence**

Export `ACTIVE_COMMANDS`, `LEGACY_READ_ONLY_COMMANDS`, and `commandsForMode(mode)`. Pass the selected list into command registration rather than importing a global mutable list. Use presence text `Legacy reports · Read only` in legacy mode.

- [ ] **Step 5: Make legacy configuration conditional**

Continue requiring database, Discord, API read credential, encryption, and event webhook values. Do not read or validate report-writer, Brave, experiment, simulation, or mutation-only values when the mode is `legacy_read_only`.

- [ ] **Step 6: Run focused bot tests and commit**

```powershell
npm.cmd test -w @discord-dsa/bot -- config.test.ts bot.test.ts
git add apps/bot/src/config.ts apps/bot/src/commands.ts apps/bot/src/command-registration.ts apps/bot/src/presence.ts apps/bot/.env.example apps/bot/test/config.test.ts apps/bot/test/bot.test.ts
git commit -m "feat(bot): register legacy read-only commands"
```

### Task 10: Enforce legacy read-only interactions and stop mutation workers

**Files (legacy repository):**
- Create: `apps/bot/src/legacy-read-only.ts`
- Create: `apps/bot/test/legacy-read-only.test.ts`
- Modify: `apps/bot/src/interactions.ts`
- Modify: `apps/bot/src/main.ts`
- Modify: `apps/bot/src/ui.ts`
- Modify: `apps/bot/src/notifier.ts`
- Modify: `apps/bot/src/digest-worker.ts`
- Modify: `apps/bot/test/bot.test.ts`

**Interfaces:**
- Consumes: `BotMode` and all Discord `Interaction` variants.
- Produces: `legacyReadOnlyDecision(interaction): { allowed: true } | { allowed: false; message: string }`, plus a startup path that omits mutation-only dependencies.

- [ ] **Step 1: Add a table-driven stale-interaction test**

Include old `/report`, `/reports retry`, `/access redeem`, `/admin`, both report context commands, create/refine/regenerate/retry buttons, create selects, and report modal submissions. Assert each returns `allowed: false`. Include report list/status pagination, notification settings, analytics navigation, and non-mutating dismissal controls; assert each remains allowed.

- [ ] **Step 2: Add startup composition tests**

Inject factories into a small startup composition function and assert legacy mode never constructs `ReportWriter` or `ExperimentalBatchWorker`, while it does construct/start `NotificationWorker`, `DigestWorker`, and `HealthServer`.

- [ ] **Step 3: Run tests and verify failures**

```powershell
npm.cmd test -w @discord-dsa/bot -- legacy-read-only.test.ts bot.test.ts
```

- [ ] **Step 4: Implement the centralized policy before handler dispatch**

At the first interaction dispatch boundary, evaluate the policy. For a denied interaction, reply or follow up ephemerally with:

```text
This legacy bot is read-only and no longer accepts new reports or retries. Connect to the NReport bot to create a report.
```

Do not reserve credits, create drafts, call the API, or resolve report evidence before this check.

- [ ] **Step 5: Split startup construction by mode**

In active mode preserve current behavior. In legacy mode omit countries needed solely for creation, `ReportWriter`, AI usage callbacks, and `ExperimentalBatchWorker`. Retain the API read client, database, resolvers still required for display, notifier, digests, health server, and Discord client.

- [ ] **Step 6: Verify existing updates remain functional**

Add tests that ingest a lifecycle event, reconcile an event cursor, edit an existing DM card, and deliver a due digest in legacy mode. Ensure revoked/missing credentials fail safely without enabling a mutation path.

- [ ] **Step 7: Run tests and commit**

```powershell
npm.cmd test -w @discord-dsa/bot -- legacy-read-only.test.ts bot.test.ts
git add apps/bot/src/legacy-read-only.ts apps/bot/test/legacy-read-only.test.ts apps/bot/src/interactions.ts apps/bot/src/main.ts apps/bot/src/ui.ts apps/bot/src/notifier.ts apps/bot/src/digest-worker.ts apps/bot/test/bot.test.ts
git commit -m "feat(bot): enforce legacy read-only operation"
```

### Task 11: Document and verify the legacy shutdown

**Files (legacy repository):**
- Modify: `README.md`
- Modify: `docs/BOT_API.md`
- Modify: `docs/BOT_IMPLEMENTATION.md`
- Modify: `apps/api/railway.json`
- Modify: `apps/bot/railway.json`

**Interfaces:**
- Consumes: shutdown behavior from Tasks 8–10.
- Produces: an operator runbook describing cutover, rollback, retained workers, and eventual retirement.

- [ ] **Step 1: Document the two independent controls**

State that production legacy shutdown requires both `ACCEPT_NEW_REPORTS=false` and `BOT_MODE=legacy_read_only`. List allowed reads, retained lifecycle behavior, blocked operations, reduced secret requirements, rollback steps, and the rule that the old email route remains until the terminal-report grace period ends.

- [ ] **Step 2: Run the full legacy completion gate**

```powershell
npm.cmd run lint
npm.cmd run typecheck
npm.cmd test
npm.cmd run build
npm.cmd run audit:high
```

Expected: all commands exit zero. Do not run Discord transport diagnostics.

- [ ] **Step 3: Inspect the exact legacy diff**

```powershell
git status --short --branch
git diff --check
git diff --stat
```

Expected: the user's pre-existing dirty files are still present and unchanged unless their owner explicitly assigned them to a commit. Shutdown commits contain only the files listed in Tasks 8–11.

- [ ] **Step 4: Commit the runbook**

```powershell
git add README.md docs/BOT_API.md docs/BOT_IMPLEMENTATION.md apps/api/railway.json apps/bot/railway.json
git commit -m "docs: add legacy read-only cutover runbook"
```

### Task 12: Provision and cut over without service overlap

**Files:**
- No committed secret files.
- Verify deployment configuration against `README.md` and both environment examples.

**Interfaces:**
- Consumes: verified NReport `main`, verified legacy shutdown commits, fresh infrastructure credentials.
- Produces: running isolated NReport services and a read-only legacy deployment that continues existing-report updates.

- [ ] **Step 1: Provision isolated NReport resources**

Create new Railway API and bot services, two new PostgreSQL databases, independent encryption keys, API-key pepper, administrator key, provider/search secrets, webhook secrets, a new Discord application, and the new Cloudflare Worker/email route. Confirm every service ID and hostname differs from legacy.

- [ ] **Step 2: Deploy the new API with lifecycle workers disabled**

Run database migrations and `/healthz`. Fetch `/openapi.json` and assert the title and namespaced paths. Confirm a legacy API key receives 401 and the new test key cannot read another account.

- [ ] **Step 3: Configure and deploy the new Worker and bot**

Set the Worker's new API ingestion URL and secret. Route only the new email domain/subdomain to it. Configure the new bot with the new Discord application, API URL, destination secret, database, and encryption key.

- [ ] **Step 4: Validate recovery and lifecycle behavior before enabling real workers**

Using mocks, verify AI success, manual success, preparation failure/refund, verification failure/refund, submission ambiguity/consumption, denial/appeal, reuse retry, regenerate retry, webhook failure with event-feed recovery, and DM-card deduplication.

- [ ] **Step 5: Run one explicitly authorized end-to-end lifecycle**

Enable workers for the controlled account only, confirm the new email reaches only the new API, and verify the report reaches a terminal or expected decision-wait state with one credit entitlement and a recoverable event timeline.

- [ ] **Step 6: Enable the NReport workers, then disable legacy mutations**

After the controlled flow passes, enable normal new workers. Deploy the legacy API first with `ACCEPT_NEW_REPORTS=false`, verify HTTP 410 and continued reads/email processing, then deploy the legacy bot with `BOT_MODE=legacy_read_only` and synchronize its reduced commands.

- [ ] **Step 7: Perform post-cutover acceptance checks**

Confirm an old report receives a webhook/reconciliation update and edits its existing DM card. Confirm stale old create/retry interactions and direct API calls fail. Confirm a new account can connect and create through NReport. Confirm logs contain no keys, email codes, raw mail, report text, or submitting Discord identity at the API boundary.

- [ ] **Step 8: Retain and later retire legacy infrastructure deliberately**

Monitor legacy non-terminal reports and delayed decisions. After all are terminal and the operator-approved grace period expires, disable the old email route and mutation-only secrets. Archive services only through a separate approved retirement change; do not delete legacy databases as part of this plan.
