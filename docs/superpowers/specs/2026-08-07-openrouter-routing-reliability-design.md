# OpenRouter Routing Reliability Design

## Goal

Stop throughput-first provider cascades during DeepSeek research while keeping fast providers preferred and preserving ZDR for report text.

## Routing behavior

Research calls will send:

```json
{
  "data_collection": "deny",
  "require_parameters": true,
  "preferred_min_throughput": { "p90": 50 }
}
```

Research will no longer require ZDR because the ZDR endpoint restriction reduced the compatible provider pool for strict structured output plus web search. It will continue to deny providers that collect request data and require every request parameter to be supported.

Writing, refinement, and repair calls will send the same preferences plus `"zdr": true`. These stages contain the final report text and do not require the web-search plugin, so they retain the stronger privacy restriction.

## Reliability behavior

Remove `sort: "throughput"` from every stage. That explicit sort disables OpenRouter's normal uptime-aware load balancing and caused sequences of failed provider attempts. `preferred_min_throughput.p90: 50` keeps providers that reliably deliver at least 50 tokens per second in the preferred group without excluding slower fallbacks or disabling normal load balancing.

Keep provider fallbacks, the 45-second per-request timeout, the 90-second workflow limit, DeepSeek V4 Flash, strict schemas, and `max_completion_tokens: 4096` unchanged.

## Testing and documentation

Update report-writer tests first so research rejects both ZDR and hard sorting while report-producing stages retain ZDR. Every stage must assert the p90 throughput preference. Update the README and bot documentation to describe the split privacy policy and uptime-aware routing. Run lint, workspace typecheck, all tests, build, audit, and `git diff --check`.
