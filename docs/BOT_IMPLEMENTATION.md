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
/report message [message-link]
/report profile username [server-id]
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
```

Admin commands are visible in every supported context but authorize against the exact
IDs in `DISCORD_ADMIN_USER_IDS`. All command responses, errors, forms, reviews, and
administrative results are ephemeral. Lifecycle DMs are ordinary private bot DMs.

## Report lifecycle

1. Enforce access or configured-admin bypass.
2. Use the saved country or show the paged authoritative country list.
3. Collect the flow-specific reason, elements, target, and context.
4. Encrypt the draft at rest with a 30-minute expiry.
5. Show a final review with submit, edit, country, and cancel controls.
6. Atomically reserve one credit and create the API report with the interaction ID.
7. Consume the reservation after HTTP 202 or idempotent HTTP 200.
8. Release it after a definite pre-creation rejection; reconcile ambiguous responses with
   the exact body and idempotency key.
9. Poll briefly in the interaction, then let the durable worker continue.
10. DM safe summaries for submission, failure, received, actioned, closed, or rejected review.

DMs include report IDs, flow, reason, country, attempt, status, and timestamp. They omit
the generated reporter identity/email, target identifiers, selected evidence details, and
free-text context. A Discord 50007 response permanently disables DM attempts for that
tracked report; `/reports` remains available.

## Access credits

- Whitelisting is enabled unless `WHITELIST_ENABLED=false`.
- Normal users begin with zero credits; configured admins are unlimited.
- A one-use key grants 1-100 credits and may have a redemption deadline.
- Plaintext key values are displayed once; only a peppered HMAC and safe prefix are stored.
- Report creation consumes one credit. Status checks and lifecycle retries are free.
- Revoking a redeemed key suspends its user, clears every remaining credit, and deletes
  unsubmitted drafts. Existing reports and lifecycle notifications continue.
- A suspended user cannot redeem a new key. Admin reinstatement returns them with zero credits.

## Operations

The notification worker uses leased PostgreSQL rows and `SKIP LOCKED`, so restarts do not
duplicate work and additional replicas remain safe. Pending reports poll approximately
every 30 seconds; submitted reports awaiting Discord decisions poll every five minutes.
DMs use a unique `(tracking_id, event_key)` outbox key and bounded exponential retry.

Do not register production commands or enable production reporting workers in pull-request
environments. Use a separate Discord application and mocked API for staging.
