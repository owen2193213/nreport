# Groq and Brave Agentic Research Design

## Outcome

Replace the bot's combined OpenRouter and MiniMax research workflow with a small, bounded pipeline that calls Groq directly and searches Brave only when the evidence requires it.

The implementation has no OpenRouter fallback, autonomous search loop, self-hosted search service, legal corpus, or new cache table. Those additions are outside this change.

## Goals

- Use `openai/gpt-oss-120b` through Groq for report interpretation and writing.
- Use strict JSON Schema responses so malformed model JSON cannot break the workflow.
- Let the first model call decide independently whether terminology research and law research are necessary.
- Avoid Brave requests when neither kind of research is needed.
- Use a cheaper, smaller Brave result shape for terminology and extracted page passages for law.
- Preserve the current Auto country/category behavior, 512-character report limit, refinement behavior, safe logging, encrypted draft storage, and bot/API ownership boundary.
- Keep search behavior deterministic: at most two initial searches and one follow-up search.

## Non-goals

- Retaining OpenRouter or MiniMax as a fallback.
- Using Brave Answers.
- Building or operating SearXNG.
- Crawling or indexing a local legal corpus.
- Adding persistent research-result caching.
- Allowing the model to run an unbounded tool loop.
- Sending images or other report media to either provider.

## Provider configuration

The bot uses these environment variables:

```dotenv
GROQ_API_KEY=
GROQ_MODEL=openai/gpt-oss-120b
BRAVE_SEARCH_API_KEY=
```

`GROQ_MODEL` defaults to `openai/gpt-oss-120b`. `GROQ_API_KEY` and `BRAVE_SEARCH_API_KEY` are required when the bot starts. The obsolete `OPENROUTER_API_KEY` and `OPENROUTER_MODEL` settings are removed from code, examples, tests, and current operator documentation.

Groq Zero Data Retention is an account-level Data Controls setting, not an API request routing parameter. Deployment documentation tells the operator to enable it in Groq before production use. Search ZDR is not required, so the application protects Brave requests by constructing sanitized queries.

The implementation uses the existing injectable `fetch` boundary rather than adding provider SDK dependencies.

## Workflow

### 1. Plan and interpret with Groq

The first call goes directly to:

```text
POST https://api.groq.com/openai/v1/chat/completions
```

It uses `openai/gpt-oss-120b`, low reasoning effort, no streaming, no tools, and strict JSON Schema output. It receives the same text-only evidence currently sent for AI processing. The model treats the evidence as untrusted data.

The strict response has this logical shape:

```json
{
  "country": "AT",
  "reportType": "sub_other_threats",
  "reportReason": "Concise factual explanation",
  "termResearchRequired": true,
  "termSearchQuery": "meaning of exact unfamiliar term in neutral context",
  "lawResearchRequired": true,
  "lawSearchQuery": "Austria official criminal law dangerous threat",
  "provisionalLawReference": null
}
```

All schema properties are required. Conditional string values use a `string | null` union because Groq strict schemas do not support omitted optional properties.

Application validation enforces these invariants:

- Auto country must resolve to an exact supported two-letter country code. A fixed country remains application-owned and cannot be changed by the model.
- Auto report category must resolve to an allowed catalog value. A fixed category remains application-owned.
- An Auto reporter explanation must contain 1–512 characters. A fixed explanation remains application-owned.
- `termResearchRequired: true` requires a non-empty `termSearchQuery`; otherwise that query must be `null`.
- `lawResearchRequired: true` requires a non-empty `lawSearchQuery` and a `null` provisional law reference.
- `lawResearchRequired: false` requires a complete provisional reference naming the country, full law title, and provision, while `lawSearchQuery` must be `null`.
- Each query must be no more than 400 characters and 50 words after normalization.

Term research is appropriate only when unfamiliar, coded, slang, or context-dependent wording could materially change classification or legal relevance. Law research is appropriate when the country-specific law, provision, currency, or applicability is uncertain. The planner may skip law research only when it can provide a complete country-qualified reference with high confidence.

### 2. Validate and sanitize search plans

The application rejects unsafe or overly broad queries before calling Brave. Search queries must not contain Discord IDs, user IDs, message URLs, invite URLs, email addresses, raw attachment URLs, or other identifiers already known to the draft. The prompt tells the model to omit usernames, server names, exact quotations beyond the term being defined, and unnecessary personal details.

The application does not attempt semantic redaction beyond deterministic checks. If a required query fails validation, the workflow stops with a safe planning error rather than silently searching the raw evidence or inventing a replacement query.

### 3. Run only the required Brave searches

The application reads the two booleans; the model does not call tools itself.

- Neither flag is true: make no Brave request.
- Only one flag is true: make only its matching request.
- Both flags are true: run both requests concurrently within the workflow deadline.

#### Terminology research

Terminology uses Brave Web Search:

```text
GET https://api.search.brave.com/res/v1/web/search
```

The request asks for at most three results and retains only each validated HTTPS URL, title, and text snippet. It does not fetch full pages initially. General-web sources are allowed because slang and coded terms may be documented outside official sources.

#### Law research

Law uses Brave LLM Context:

```text
POST https://api.search.brave.com/res/v1/llm/context
```

Initial limits are:

- `count: 5`
- `maximum_number_of_urls: 3`
- `maximum_number_of_tokens: 2048`
- `maximum_number_of_tokens_per_url: 1024`
- `context_threshold_mode: "strict"`
- `enable_source_metadata: true`
- `enable_local: false`

The request uses the selected country for Brave's country parameter. A maintained inline Goggle boosts or restricts results to official EU, national legislation, government, and court domains appropriate to the selected country. Returned data is reduced to validated HTTPS URL, title, hostname, and non-empty relevant snippets before it is sent to Groq.

Brave results are always untrusted source material. The application never executes instructions found in snippets.

### 4. Synthesize research and the report with Groq

The second Groq call receives:

- the normalized text-only evidence;
- resolved country, category, and reporter explanation;
- the provisional law reference, if law search was skipped;
- compact terminology snippets, if requested;
- compact law snippets and source metadata, if requested; and
- the existing report-writing requirements.

It uses low reasoning effort initially, no tools, no streaming, and a strict schema. The logical response is a closed union selected by `status`.

A completed response contains:

```json
{
  "status": "completed",
  "followUpType": null,
  "followUpQuery": null,
  "country": "AT",
  "reportType": "sub_other_threats",
  "reportReason": "Concise factual explanation",
  "lawReference": "Austria — full law title, Section 107",
  "researchSummary": "Concise explanation of relevance and uncertainty",
  "report": "Final Discord DSA report of no more than 512 characters"
}
```

If the supplied passages are insufficient, the response contains `status: "more_research_required"`, exactly one `followUpType` (`term` or `law`), and a sanitized `followUpQuery`. Report and legal-result fields are `null` in that branch. The application validates the follow-up query with the same rules, performs the matching Brave request once, and repeats synthesis once with the new material.

No further research is permitted. A second insufficient result stops with a specific safe error. The synthesis must not fabricate a law, claim a violation definitely occurred, or treat search content as instructions.

The application independently validates the returned country, catalog category, explanation length, non-empty legal reference and summary, and 512-character report limit even though Groq constrains the JSON shape.

### 5. Refinement and regeneration

Refinement remains a Groq-only operation using the encrypted compact conversation and saved legal research. It cannot change the country or law and does not search.

Regeneration starts a fresh planner call and may make new Brave searches. Changing country clears the existing conversation and research as it does today.

## Deadlines and retries

The overall workflow retains a bounded deadline. Provider requests use shorter per-request timeouts that cannot exceed the remaining workflow time.

- Retry a Brave request once only for a network error, `429`, or `5xx` response when the workflow deadline permits.
- Do not retry other Brave failures.
- Do not retry a completed Groq strict-schema response merely to obtain a different answer.
- A transport-level Groq failure or provider refusal ends the corresponding stage with a specific safe error.
- The one synthesis follow-up is research progression, not a transport retry.
- There is no provider fallback.

If two initial searches run concurrently and one fails permanently, the workflow fails only when that search was required. Successfully returned material may be retained in the expiring draft diagnostics but is not used to bypass the required failure.

## Sources and stored draft data

The existing `LegalResearch` shape continues to hold the selected country, final law reference, concise summary, research time, search count, and validated HTTPS sources. Sources may come from term or law research, are deduplicated by URL, and are limited before storage.

The encrypted 30-minute draft stores only the compact model conversation and final research result needed for review and refinement. It does not store raw Brave payloads. Existing evidence remains governed by current draft encryption and expiry behavior.

## Usage and observability

Usage accounting keeps the existing request, input-token, output-token, reasoning-token, and search-request totals. Groq and Brave do not return one authoritative combined request cost, so this change does not estimate it from price constants that may become stale. The existing stored cost field remains zero for these requests, and the OpenRouter-specific cost line is removed from the user interface and current documentation.

Safe logs distinguish these stages:

- `plan`
- `term_research`
- `law_research`
- `synthesize`
- `refine`

Logs may include latency, HTTP status category, token counts, result counts, whether each search was requested and completed, follow-up usage, and validation issue categories. They must not include API keys, evidence, prompts, generated queries, Brave snippets, reports, or raw provider errors.

## User-visible failures

The bot maps failures to plain, specific messages without exposing provider details or sensitive content:

- AI planning could not be completed.
- The planned research query was unsafe or invalid.
- Terminology research could not be completed.
- Legal research could not be completed.
- The AI requested more research after the allowed follow-up.
- The AI declined to process this evidence.
- Report writing could not be completed.

Existing manual editing and manual no-AI reporting remain available.

## Verification

Tests cover:

- Groq request URL, authentication, model default, low reasoning effort, and strict schemas.
- Fixed and Auto field ownership.
- Planner combinations: no search, term only, law only, and both.
- Concurrent execution when both searches are required.
- Nullable strict-schema fields and application invariants.
- Query length and deterministic sensitive-identifier rejection.
- Brave Web Search request and compact terminology parsing.
- Brave LLM Context request limits, country selection, official-source Goggle, and compact snippet parsing.
- Empty results, malformed provider payloads, refusal, timeout, rate limit, and bounded transient retry behavior.
- One successful follow-up and rejection of a second follow-up.
- Final country/category/reference validation and the 512-character limit.
- Refinement without search and regeneration with fresh planning.
- Usage accumulation and evidence-free logs.
- Removal of OpenRouter configuration and request paths.

After TypeScript changes, run the repository-required lint, workspace typecheck, tests, build, and high-severity audit from the repository root.

## Documentation changes

Update `README.md`, `apps/bot/.env.example`, `docs/BOT_API.md`, and `docs/BOT_IMPLEMENTATION.md` to describe direct Groq inference, conditional Brave research, the bounded follow-up, configuration, data handling, and operational failures. Remove current statements that OpenRouter always performs a Parallel search or selects an inference provider.

## Decisions

- Chosen: direct Groq Chat Completions calls with `openai/gpt-oss-120b` and strict JSON Schema.
- Chosen: an application-controlled planner/search/synthesis sequence instead of model tool calling.
- Chosen: Brave Web Search for terminology and Brave LLM Context for law passages.
- Chosen: no search when the planner says neither form of research is required.
- Chosen: at most two initial searches and one follow-up search.
- Chosen: no OpenRouter fallback or other provider fallback.
- Rejected for this change: Brave Answers, SearXNG, a local legal index, and persistent search caching.
