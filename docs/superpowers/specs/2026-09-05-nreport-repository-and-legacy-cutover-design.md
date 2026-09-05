# NReport Repository and Legacy Cutover Design

**Date:** 2026-09-05

**Status:** Approved in chat

## Objective

Split the current Discord DSA system into two independent repositories and deployments. The completed account-owned automatic-reporting overhaul becomes the new `nreport` repository, while the existing repository remains available as a read-only legacy system that continues processing and displaying reports already created but cannot accept any new report or retry.

## Repository boundaries

The local repositories are siblings:

```text
C:\Users\Zhuoxuan\Documents\
├── Discord DSA\     # existing origin/main; legacy read-only system
└── nreport\         # github.com/owen2193213/nreport; new platform
```

The new repository preserves the existing Git history. The original repository keeps its current remote and is never repointed to the new GitHub repository. Before transferring the overhaul, inspect the new remote for existing commits and inspect all dirty files in the original checkout. In particular, preserve the existing low-level client changes and determine the ownership of the current `apps/api/.env.example` change. Never force-push, discard, or silently include those changes.

## Product and API namespace

The product is `NReport`. `Discord` is a service category and `DSA` is the implemented service type. The stable machine identifier is `discord.dsa` and the public base path is `/v1/discord/dsa`.

Ordinary account routes live below `/v1/discord/dsa`, including account, catalog, reports, retries, events, analytics, action history, and digest activity. Administration lives below `/v1/admin/discord/dsa`. The health endpoint and Cloudflare email-ingestion webhook remain infrastructure endpoints outside the service namespace.

The OpenAPI title is `NReport API`. Operations are tagged as `Discord / DSA / Reports`, `Discord / DSA / Account`, `Discord / DSA / Analytics`, or `Administration / Discord / DSA`. The catalog response includes:

```json
{
  "service": {
    "category": "discord",
    "type": "dsa",
    "version": "v1"
  }
}
```

The platform-facing npm packages become `@nreport/api`, `@nreport/contracts`, and `@nreport/discord-dsa-bot`. The internal low-level transport remains `@discord-dsa/client` because the protected diagnostic scripts depend on that protocol-specific name and must not be edited as part of this migration. The public client classes remain `DsaApi` and `DsaAdminApi` because they describe the service being called. Consumer configuration uses `NREPORT_API_URL`, `NREPORT_API_KEY`, and `NREPORT_ADMIN_KEY`. Current database tables and credits remain DSA-specific in behavior; the change does not create a speculative multi-service entitlement framework.

Because the new API has not launched, it does not retain aliases for the unqualified `/v1/reports` routes. All new consumers and documentation use the namespaced routes from their first deployment.

## New email worker

The new deployment uses a separate Cloudflare Email Worker named `nreport-discord-dsa-email`, a separate route or domain/subdomain, a fresh ingestion secret, and an ingestion URL pointing only to the new NReport API. It accepts an envelope sender only when it is exactly `noreply@discord.com`, validates the generated alias pattern, forwards untouched RFC 822 content, signs the exact payload, and retains no message content.

The old Worker and email route remain active while any legacy report can receive verification, decision, or appeal mail. The old and new systems never share an email route, alias domain, Worker name, ingestion secret, or API destination.

## Legacy bot behavior

The original bot runs with `BOT_MODE=legacy_read_only`. Its registered commands retain only read operations required to inspect existing information: report list/status, access status, notification settings, analytics, action history, and digest views that already exist. Report creation, Quick Report, message-report context commands, report retry, access redemption, administrative mutations, experiments, and simulations are removed from registration.

Command deletion is not the security boundary. A centralized interaction policy rejects stale commands, buttons, selects, and already-open modals that could create, retry, regenerate, refine, resubmit, redeem, adjust credits, or otherwise mutate reporting state. Rejections are ephemeral and use stable code `legacy_read_only` with directions to the new NReport bot.

The legacy bot keeps signed lifecycle webhook ingestion, event reconciliation, necessary active-report polling, DM card updates, notification preferences, history, analytics, digests, health checks, and safe logging. It does not instantiate the report writer, call AI or Brave, or start experimental batch/simulation workers. Its presence and report views identify it as a read-only legacy archive.

## Legacy API behavior

The old API runs with `ACCEPT_NEW_REPORTS=false`. Production requires this variable explicitly; it has no implicit production default that could silently re-enable or disable reports. When false, client-created reports, report retries, appeal retries requested by a client, and any draft/refinement path capable of creating a submission fail before validation side effects, identity creation, credit work, report insertion, or job insertion. The stable response is HTTP 410 with code `legacy_read_only`.

The gate does not block infrastructure or lifecycle work for existing reports. Health checks, report/event/analytics reads, Cloudflare email ingestion, queued verification and submission jobs, Discord decision processing, existing automatic appeals, lifecycle events, and bot webhook delivery continue normally.

The bot guard and API gate are both required: Discord registrations are eventually consistent and the old shared API credential may still be callable.

## Data and user migration

Legacy reports, users, encrypted state, and credits are not copied. They remain readable through the original bot and databases. NReport starts with fresh API and bot databases, encryption material, API-key pepper, administrator key, webhook secrets, Discord application, report email domain, and Cloudflare route. Administrators deliberately create new NReport accounts and issue new personal keys.

## Deployment sequence

1. Back up both legacy databases and record the existing Railway and Cloudflare configuration.
2. Inspect the new GitHub repository and all dirty local files.
3. Commit the verified overhaul on its feature branch and transfer it without force-push.
4. Clone and verify `C:\Users\Zhuoxuan\Documents\nreport` as an independent checkout.
5. Apply and verify NReport naming, namespaced routes, package metadata, documentation, and Worker isolation.
6. Create fresh Railway API/bot services and databases, a new Discord application, and the new Cloudflare route.
7. Deploy the new API with Discord lifecycle workers disabled; migrate and health-check it.
8. Configure a test account, destination, credits, new bot, and new email Worker.
9. Validate mocked flows and one explicitly authorized end-to-end lifecycle, then enable the new workers.
10. Only after NReport is healthy, deploy the legacy API mutation gate and legacy bot command/interaction restrictions.
11. Confirm existing legacy reports continue receiving lifecycle and DM updates.
12. Retain the old Worker and services until all legacy reports are terminal and a documented grace period has elapsed.

If NReport validation fails before cutover, leave the old system writable and disable the new lifecycle workers. After cutover, rollback requires deliberately restoring both the old API mutation setting and the old command registration; no database restoration is necessary because read-only conversion deletes no records.

## Acceptance criteria

- The two local folders have independent `origin` remotes and clean checkouts after migration.
- A fresh clone of `nreport` passes install, lint, typecheck, tests, build, and high-severity audit.
- Every new public DSA route is below `/v1/discord/dsa` or `/v1/admin/discord/dsa`.
- OpenAPI and the typed client use the same paths and NReport naming.
- The new Worker accepts only `noreply@discord.com` and can target only the new API through its deployment configuration.
- The old bot exposes no report mutation command and rejects every stale mutation interaction.
- The old API rejects direct create/retry calls before creating any durable state.
- Existing legacy lifecycle jobs, email correlation, webhooks, reconciliation, history, analytics, digests, and DM updates continue working.
- The systems share no database, Discord application, email route, or secret.
- The original dirty files are preserved and no existing remote or Railway service is overwritten.

## Simplicity decisions

Do not create a general plugin framework, service registry, multi-service credit system, compatibility routes, legacy-data importer, or static archival replacement. The namespace and package names establish the future boundary; deeper abstractions wait for a concrete second service. The legacy shutdown adds only two operational controls—`BOT_MODE=legacy_read_only` and `ACCEPT_NEW_REPORTS=false`—plus the command and interaction enforcement necessary to make them real.
