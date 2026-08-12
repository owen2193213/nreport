# YAGNI Review Fixes Design

## Goal

Correct the confirmed analytics, notification, and digest issues with the smallest maintainable
changes. Do not introduce new persistence, distributed locks, or exactly-once delivery machinery.

## Changes

### Action History

Remove Action History pagination from the Discord UI and request at most 25 records, the existing API
page limit. Custom date results remain tied to the submitted date range because there is no follow-up
cursor control that can accidentally fall back to a preset period. The API cursor contract remains
available for future clients, but the bot does not expose it.

### Notification Preferences

Reload current notification preferences for each claimed lifecycle job immediately before evaluating
its category. Claimed preference snapshots remain harmless implementation data, but are no longer the
delivery decision source.

### Digest Delivery

Retain durable at-least-once delivery. Discord DM creation and PostgreSQL completion cannot be made
atomic, and adding reconciliation or delivery-token infrastructure is outside this fix. Document the
small duplicate-delivery window after a successful Discord send followed by process or database
failure.

### Reply-Time Charts

Treat a null median reply time as missing data. Draw separate line segments for consecutive known
points and do not render missing points at zero hours.

## Error Handling

Preference reload failures use the existing notification retry path. Digest failures retain the
existing bounded retry behavior. Empty or entirely missing reply-time series render the chart's
existing no-data message.

## Testing

Add focused regression coverage for the non-paginated 25-item history request, delivery-time
preference reload, missing reply-time points, and the documented digest delivery guarantee. Run lint,
workspace typecheck, all tests, build, high-severity dependency audit, and `git diff --check`.
