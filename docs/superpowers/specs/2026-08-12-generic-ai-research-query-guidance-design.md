# Generic AI Research Query Guidance Design

## Goal

Improve planner instructions so optional Brave research uses a generic, reusable query rather than a query that describes a particular Discord incident.

## Scope

Update the planning prompt only. Keep the existing deterministic privacy validator and its sensitive-draft-value matching behavior unchanged.

## Prompt behavior

The planning prompt will state that research queries must be generic standalone searches. It will give two concrete formats:

- Legal research: `Germany laws on online threats`
- Terminology research: `what does [slang] mean in online context`

The prompt will clarify that a query must describe the law or concept, never the individual reported incident.

## Validation and testing

The existing query validator remains the hard enforcement boundary for private identifiers and metadata. A report-writer regression test will inspect the request prompt and assert that the generic-query instruction and both examples are present.
