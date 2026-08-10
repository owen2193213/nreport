# Admin User Mentions Design

## Goal

Make every admin-facing bot embed that displays a Discord user ID render it as a Discord user mention, so administrators can click or ping the user from the embed.

## Scope

- Access-key list and detail embeds will show a key redeemer as `<@userId>`.
- The admin user-access embed will show its selected user as `<@userId>`.
- Suspension and reinstatement confirmations will refer to the affected user as `<@userId>`.
- User-ID command inputs, database values, audit data, and non-admin-facing diagnostic displays remain raw IDs.

## Design

`apps/bot/src/ui.ts` will expose a focused user-mention formatter and use it wherever UI builders display an admin-targeted Discord user ID. Interaction confirmation copy will use the same formatter. The existing ID validation remains the boundary that ensures the formatter only receives Discord snowflakes.

## Verification

Focused bot tests will serialize each affected embed or interaction response and assert the `<@...>` form. Existing test and workspace validation commands will confirm no behavior outside display formatting changes.
