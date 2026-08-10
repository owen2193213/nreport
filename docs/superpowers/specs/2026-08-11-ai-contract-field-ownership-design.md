# AI Contract Field Ownership Design

## Goal

Prevent AI stages from repeating or changing fields that are already fixed or resolved. Each field
has one owner, and later stages cannot output fields they do not own.

## Ownership

- The application owns reporter-supplied country, category, and explanation values.
- Planning owns only missing Auto values plus the decision to perform terminology or legal
  research and the associated sanitized queries.
- After planning, the application combines fixed and selected values into immutable resolved state.
- Synthesis owns follow-up-search requests, the law reference, the research summary, and the final
  report text.
- Refinement and repair own only revised report text.

## Planner contract

The planner schema is built from the unresolved inputs. A fixed country, category, or explanation
is supplied as context but omitted from the output schema. An Auto field is required in the output
schema and validated against its allowed values. The application merges the returned choices with
the fixed inputs. The planner continues to return research flags and queries. It returns a
provisional law reference only when legal research is not required.

This makes fixed-field drift impossible: there is no JSON property for the model to repeat.

## Synthesis contract

Synthesis receives immutable resolved state as context but cannot output country, category, or
reporter explanation. A completed response contains only the law reference, research summary, and
report. A follow-up response contains only the follow-up type and sanitized query. The application
attaches immutable resolved state to the completed result.

Reasoning-enabled synthesis continues to receive its schema in the prompt. Non-reasoning synthesis
continues to use Fireworks JSON Schema. Neither schema contains resolved application fields.

## Repair and refinement

Synthesis repair corrects only model-owned synthesis fields and cannot rewrite immutable state.
Report-length repair and refinement return only `{ "report": "..." }`. The existing single-repair
and single-follow-up limits remain unchanged.

## Error handling

Local validation remains strict for every field the AI owns. Unsupported Auto selections,
inconsistent research flags, unsafe queries, malformed JSON, missing legal content, and overlength
reports still fail safely. Errors for synthesis changing country, category, or explanation are
removed because those fields no longer exist in the synthesis response.

## Testing

Tests inspect actual outbound schemas and prompts to prove:

- fixed planner fields are absent from planner output schemas;
- Auto planner fields are present and resolved correctly;
- synthesis schemas never contain country, category, or reporter explanation;
- a completed synthesis succeeds without echoing resolved fields;
- follow-up research still works with the smaller response shape;
- repair and refinement remain report-only;
- immutable values in the final result come from application state.

All existing workflow, configuration, privacy, usage accounting, and provider retry behavior remain
unchanged.
