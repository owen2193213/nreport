# Admin User Mentions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render Discord user IDs in every admin-facing access-key and user-management response as clickable mentions.

**Architecture:** Add one UI formatter for Discord mentions and route both access-key/user-access embeds and administrative suspension/reinstatement copy through it. No command parsing, database, or authorization behavior changes.

**Tech Stack:** TypeScript, discord.js EmbedBuilder, Vitest.

## Global Constraints

- Preserve the bot/API boundary and avoid database changes.
- Keep all interaction replies ephemeral.
- Do not change raw user-ID command input validation or stored user IDs.
- Do not edit protected scripts in `scripts/`.

---

### Task 1: Render administrative user IDs as mentions

**Files:**
- Modify: `apps/bot/test/bot.test.ts:288-337`
- Modify: `apps/bot/src/ui.ts:866-892,1290-1323`
- Modify: `apps/bot/src/interactions.ts:1201-1210`

**Interfaces:**
- Produces: `discordUserMention(userId: string): string`, returning `<@${userId}>`.
- Consumes: existing `AccessKeyView.redeemed_by` and validated `user-id` command option values.

- [ ] **Step 1: Write the failing tests**

```ts
expect(list).toContain("Redeemed by: <@100000000000000002>");
expect(detail).toContain("<@100000000000000002>");
expect(JSON.stringify(accessEmbed(access, false, "100000000000000002").toJSON()))
  .toContain("Discord user: <@100000000000000002>");
```

Add interaction tests that assert suspension and reinstatement replies contain `<@123456789012345678>`.

- [ ] **Step 2: Run the focused test to verify it fails**

Run: `npm.cmd test -w @discord-dsa/bot -- bot.test.ts`

Expected: FAIL because user IDs are still rendered within Markdown code brackets.

- [ ] **Step 3: Write the minimal implementation**

```ts
export function discordUserMention(userId: string): string {
  return `<@${userId}>`;
}
```

Use `discordUserMention` in `accessEmbed`, `accessKeysEmbed`, `accessKeyEmbed`, and the suspension/reinstatement success-response copy.

- [ ] **Step 4: Run the focused test to verify it passes**

Run: `npm.cmd test -w @discord-dsa/bot -- bot.test.ts`

Expected: PASS with all bot UI tests green.

- [ ] **Step 5: Run required repository verification**

Run: `npm.cmd run lint`, `npm.cmd run typecheck`, `npm.cmd test`, `npm.cmd run build`, and `npm.cmd run audit:high`.

Expected: all commands succeed without lint, type, test, build, or high-severity audit failures.

- [ ] **Step 6: Commit the scoped change**

Stage only the three bot files and these two documentation files, then commit with `fix(bot): mention users in admin embeds`.
