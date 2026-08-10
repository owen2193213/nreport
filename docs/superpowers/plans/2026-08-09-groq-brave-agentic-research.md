# Groq and Brave Agentic Research Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace OpenRouter/MiniMax with direct Groq GPT-OSS inference and bounded, conditional Brave terminology and law research.

**Architecture:** `ReportWriter` remains the workflow owner but delegates provider HTTP details to focused `GroqClient` and `BraveResearchClient` modules. A strict Groq planning call resolves missing report fields and emits two research decisions; the application conditionally runs Brave Web Search and/or Brave LLM Context, then a strict Groq synthesis call either completes the report or requests one bounded follow-up search.

**Tech Stack:** TypeScript 6, Node.js `fetch`, Vitest, Groq OpenAI-compatible Chat Completions, Brave Web Search API, Brave LLM Context API, PostgreSQL-backed existing usage counters.

## Global Constraints

- Do not add an OpenRouter, MiniMax, or secondary-provider fallback.
- Do not add a provider SDK, SearXNG deployment, local legal index, persistent research cache, or autonomous tool loop.
- Use `openai/gpt-oss-120b` as the default Groq model.
- Use Groq strict JSON Schema with every property required and nullable unions for conditional values.
- Permit at most two initial Brave searches and one follow-up Brave search.
- Use Brave Web Search for terminology and Brave LLM Context for law.
- Never send report images, media URLs, Discord identifiers, invite URLs, email addresses, or unnecessary personal details to Brave.
- Keep the existing 90-second workflow deadline and bound every provider request by its remaining time.
- Preserve fixed-field ownership, Auto field behavior, encrypted 30-minute drafts, no-AI mode, 512-character final reports, safe logs, and bot/API service boundaries.
- Keep `AiUsage.costCredits` for database compatibility, record zero for Groq/Brave requests, and remove the OpenRouter cost line from user-visible UI.
- After every TypeScript change set, run lint, workspace typecheck, tests, build, and `npm.cmd run audit:high` before claiming completion.

## File structure

- Create `apps/bot/src/groq-client.ts`: Groq request/response types, strict-completion transport, refusal detection, token usage, safe errors, and request telemetry.
- Create `apps/bot/src/brave-research.ts`: query validation, Brave term/law requests, bounded transient retry, payload compaction, source validation, and search telemetry.
- Create `apps/bot/test/groq-client.test.ts`: direct Groq request and failure-contract tests.
- Create `apps/bot/test/brave-research.test.ts`: sanitization, endpoint, parsing, retry, and source tests.
- Modify `apps/bot/src/report-writer.ts`: planner and synthesis schemas/prompts, conditional orchestration, one follow-up, and Groq-only refinement.
- Modify `apps/bot/test/report-writer.test.ts`: replace OpenRouter/plugin expectations with planner/search/synthesis/refinement behavior.
- Modify `apps/bot/src/config.ts`, `apps/bot/src/main.ts`, `apps/bot/.env.example`, and `apps/bot/test/config.test.ts`: direct provider configuration and construction.
- Modify `apps/bot/src/ui.ts` and `apps/bot/test/bot.test.ts`: remove the stale OpenRouter cost display while preserving counters.
- Modify `README.md`, `docs/BOT_API.md`, and `docs/BOT_IMPLEMENTATION.md`: canonical configuration, lifecycle, privacy, failure, and operational behavior.

---

### Task 1: Replace OpenRouter configuration with Groq and Brave configuration

**Files:**
- Modify: `apps/bot/test/config.test.ts`
- Modify: `apps/bot/src/config.ts`
- Modify: `apps/bot/src/main.ts`
- Modify: `apps/bot/.env.example`

**Interfaces:**
- Produces: `BotConfig.groqApiKey: string`
- Produces: `BotConfig.groqModel: string`
- Produces: `BotConfig.braveSearchApiKey: string`
- Consumes later: `new ReportWriter(groqApiKey, groqModel, braveSearchApiKey, countries, options)` in Task 4

- [ ] **Step 1: Rewrite the configuration tests to require both direct-provider keys**

Replace the OpenRouter assertions in `apps/bot/test/config.test.ts` with tests equivalent to:

```ts
function environment(): NodeJS.ProcessEnv {
  return {
    DISCORD_BOT_TOKEN: "discord-token",
    DISCORD_APPLICATION_ID: "123456789012345678",
    DISCORD_ADMIN_USER_IDS: "223456789012345678",
    ACCESS_KEY_PEPPER: "p".repeat(32),
    BOT_DATA_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
    BOT_DATABASE_URL: "postgresql://localhost/bot",
    DSA_API_BASE_URL: "https://api.example.test",
    DSA_API_KEY: "a".repeat(32),
    GROQ_API_KEY: "groq-secret",
    BRAVE_SEARCH_API_KEY: "brave-secret"
  };
}

it("requires Groq and Brave keys and defaults to GPT-OSS 120B", () => {
  expect(loadBotConfig(environment()).groqModel).toBe("openai/gpt-oss-120b");

  const withoutGroq = environment();
  delete withoutGroq.GROQ_API_KEY;
  expect(() => loadBotConfig(withoutGroq)).toThrow(/GROQ_API_KEY is required/);

  const withoutBrave = environment();
  delete withoutBrave.BRAVE_SEARCH_API_KEY;
  expect(() => loadBotConfig(withoutBrave)).toThrow(/BRAVE_SEARCH_API_KEY is required/);
});

it("allows the Groq model to be configured", () => {
  expect(loadBotConfig({ ...environment(), GROQ_MODEL: "openai/gpt-oss-20b" }).groqModel)
    .toBe("openai/gpt-oss-20b");
});
```

- [ ] **Step 2: Run the focused configuration test and verify the expected failure**

Run:

```powershell
npm.cmd test -w @discord-dsa/bot -- config.test.ts
```

Expected: FAIL because `BotConfig` still exposes OpenRouter settings and does not require Groq/Brave keys.

- [ ] **Step 3: Implement the new configuration fields and startup wiring**

Change `BotConfig` and `loadBotConfig` to expose:

```ts
braveSearchApiKey: string;
groqApiKey: string;
groqModel: string;
```

Load them with:

```ts
braveSearchApiKey: required(env, "BRAVE_SEARCH_API_KEY"),
groqApiKey: required(env, "GROQ_API_KEY"),
groqModel: env.GROQ_MODEL?.trim() || "openai/gpt-oss-120b",
```

Remove `openRouterApiKey` and `openRouterModel`. Keep the current constructor shape compiling during this configuration-only task by updating `main.ts` to construct:

```ts
const reportWriter = new ReportWriter(
  config.groqApiKey,
  config.groqModel,
  countries,
  { recordUsage: (userId, usage) => database.recordAiUsage(userId, usage) }
);
```

Task 4 adds the Brave constructor argument when the new writer orchestration consumes it.

Replace the OpenRouter block in `.env.example` with the three exact environment names and a comment instructing production operators to enable Groq ZDR in Groq Data Controls.

- [ ] **Step 4: Run the configuration test and typecheck**

Run:

```powershell
npm.cmd test -w @discord-dsa/bot -- config.test.ts
npm.cmd run typecheck -w @discord-dsa/bot
```

Expected: configuration tests and bot typecheck PASS.

- [ ] **Step 5: Commit the configuration boundary**

```powershell
git add -- apps/bot/test/config.test.ts apps/bot/src/config.ts apps/bot/src/main.ts apps/bot/.env.example
git commit -m "refactor(bot): configure Groq and Brave providers"
```

### Task 2: Add the direct Groq strict-completion client

**Files:**
- Create: `apps/bot/test/groq-client.test.ts`
- Create: `apps/bot/src/groq-client.ts`
- Modify: `apps/bot/src/types.ts`

**Interfaces:**
- Consumes: `AiUsage` and injectable `fetch`
- Produces: `GroqStage = "plan" | "synthesize" | "refine"`
- Produces: `GroqCompletion { content: string; finishReason: string; usage: AiUsage }`
- Produces: `GroqClient.complete(body, deadline, actor, stage): Promise<GroqCompletion>`
- Produces: `GroqClientError` with safe `kind` values `network`, `rate_limited`, `refusal`, `provider`, `malformed`, and `timeout`

- [ ] **Step 1: Write failing Groq transport tests**

Create tests that instantiate a client with an injected fetch mock and assert:

```ts
const request = vi.fn().mockResolvedValue(new Response(JSON.stringify({
  choices: [{ finish_reason: "stop", message: { content: "{\"ok\":true}" } }],
  usage: {
    prompt_tokens: 120,
    completion_tokens: 35,
    completion_tokens_details: { reasoning_tokens: 12 }
  }
}), { status: 200, headers: { "Content-Type": "application/json" } }));

const client = new GroqClient("groq-secret", "openai/gpt-oss-120b", {
  request: request as unknown as typeof fetch
});
const result = await client.complete({
  messages: [{ role: "user", content: "Return JSON" }],
  response_format: strictBooleanSchema()
}, Date.now() + 5_000, ACTOR, "plan");

expect(request.mock.calls[0]?.[0]).toBe("https://api.groq.com/openai/v1/chat/completions");
expect(requestHeaders(request, 0).Authorization).toBe("Bearer groq-secret");
expect(requestBody(request, 0)).toMatchObject({
  model: "openai/gpt-oss-120b",
  reasoning_effort: "low",
  stream: false
});
expect(result.usage).toEqual({
  costCredits: 0,
  inputTokens: 120,
  outputTokens: 35,
  reasoningTokens: 12,
  searchRequests: 0
});
```

Add separate tests for an empty choice, non-JSON HTTP payload, `429`, `500`, an exhausted deadline, aborted fetch, and a response message carrying a refusal instead of content. Spy on `botLog` or its established test seam and assert raw error text and response bodies are absent.

- [ ] **Step 2: Run the Groq client test and verify it fails**

```powershell
npm.cmd test -w @discord-dsa/bot -- groq-client.test.ts
```

Expected: FAIL because `groq-client.ts` does not exist.

- [ ] **Step 3: Implement the minimal Groq transport**

Implement these exported types and class:

```ts
export type GroqStage = "plan" | "synthesize" | "refine";

export interface GroqCompletion {
  content: string;
  finishReason: string;
  usage: AiUsage;
}

export class GroqClientError extends Error {
  public constructor(
    public readonly kind:
      | "network"
      | "rate_limited"
      | "refusal"
      | "provider"
      | "malformed"
      | "timeout",
    message: string
  ) {
    super(message);
    this.name = "GroqClientError";
  }
}

export class GroqClient {
  public constructor(
    private readonly apiKey: string,
    private readonly model: string,
    options: { request?: typeof globalThis.fetch } = {}
  ) {}

  public async complete(
    body: Record<string, unknown>,
    deadline: number,
    actor: AiRequestContext,
    stage: GroqStage
  ): Promise<GroqCompletion> {}
}
```

`complete` must add `model`, `reasoning_effort: "low"`, and `stream: false`, use `AbortSignal.timeout(Math.min(45_000, remaining))`, parse only allowlisted fields, detect refusal before accepting content, log safe stage/status/latency/token fields, and never log request bodies or provider error bodies.

Keep `AiUsage.costCredits` unchanged in `types.ts`; Groq completions set it to zero.

- [ ] **Step 4: Run focused tests and bot typecheck**

```powershell
npm.cmd test -w @discord-dsa/bot -- groq-client.test.ts
npm.cmd run typecheck -w @discord-dsa/bot
```

Expected: Groq tests and bot typecheck PASS.

- [ ] **Step 5: Commit the Groq client**

```powershell
git add -- apps/bot/src/groq-client.ts apps/bot/src/types.ts apps/bot/test/groq-client.test.ts
git commit -m "feat(bot): add direct Groq completion client"
```

### Task 3: Add bounded Brave terminology and law retrieval

**Files:**
- Create: `apps/bot/test/brave-research.test.ts`
- Create: `apps/bot/src/brave-research.ts`

**Interfaces:**
- Produces: `ResearchKind = "term" | "law"`
- Produces: `ResearchSource { title: string; url: string; hostname: string; snippets: string[] }`
- Produces: `ResearchMaterial { kind: ResearchKind; query: string; sources: ResearchSource[]; searchRequests: number }`
- Produces: `validateResearchQuery(query, draft): string`
- Produces: `BraveResearchClient.search(kind, query, country, deadline, actor): Promise<ResearchMaterial>`
- Produces: `BraveResearchError` with safe `kind` values `invalid_query`, `network`, `rate_limited`, `provider`, `malformed`, `empty`, and `timeout`

- [ ] **Step 1: Write failing query-validation tests**

Cover valid normalized text and rejection of each sensitive form:

```ts
expect(validateResearchQuery("  Austrian   dangerous threat law  ", draft))
  .toBe("Austrian dangerous threat law");
expect(() => validateResearchQuery("x".repeat(401), draft)).toThrow(/400 characters/);
expect(() => validateResearchQuery(Array.from({ length: 51 }, () => "word").join(" "), draft))
  .toThrow(/50 words/);
expect(() => validateResearchQuery("user 123456789012345678", draft))
  .toThrow(/identifier/);
expect(() => validateResearchQuery("https://discord.com/channels/1/2/3", draft))
  .toThrow(/URL/);
expect(() => validateResearchQuery("contact person@example.test", draft))
  .toThrow(/email/);
```

Also assert rejection when the query contains a known draft username, server name, invite code, or attachment URL, compared case-insensitively after trimming.

- [ ] **Step 2: Write failing endpoint and compaction tests**

For `term`, assert a GET to `/res/v1/web/search` with `count=3`, the selected country, and an `X-Subscription-Token` header. Mock `web.results` with valid, duplicate, credential-bearing, HTTP, and malformed URLs; expect only deduplicated credential-free HTTPS sources and non-empty descriptions.

For `law`, assert a POST to `/res/v1/llm/context` with:

```json
{
  "q": "Germany official Basic Law Article 1",
  "country": "DE",
  "count": 5,
  "maximum_number_of_urls": 3,
  "maximum_number_of_tokens": 2048,
  "maximum_number_of_tokens_per_url": 1024,
  "context_threshold_mode": "strict",
  "enable_source_metadata": true,
  "enable_local": false,
  "goggles": "$boost=5,site=eur-lex.europa.eu\n$boost=5,site=e-justice.europa.eu\n$boost=5,site=n-lex.europa.eu"
}
```

Mock `grounding.generic` and `sources`, then assert only three URLs and bounded non-empty snippets survive compaction. Assert snippets are truncated to a fixed per-snippet character ceiling before reaching the writer.

- [ ] **Step 3: Write failing retry and error tests**

Use fake timers or sequential mocked responses to verify:

- one retry after network failure, `429`, or `5xx`;
- no retry after `400` or `401`;
- no retry when the remaining workflow deadline cannot accommodate it;
- an empty compacted source list raises `BraveResearchError("empty", ...)`;
- response/error bodies, queries, and snippets never appear in logs; and
- each actual HTTP attempt increments `searchRequests`, including a retry.

- [ ] **Step 4: Run the Brave tests and verify they fail**

```powershell
npm.cmd test -w @discord-dsa/bot -- brave-research.test.ts
```

Expected: FAIL because `brave-research.ts` does not exist.

- [ ] **Step 5: Implement query validation, retrieval, compaction, and bounded retry**

Implement the interfaces listed above. Build term URLs with `URL` and `searchParams`; send law parameters as JSON. Use the exact inline Goggle from Step 2 so no external Goggle registration is required.

Use a single retry helper that retries only `network`, `429`, and `5xx`, without sleeping past the workflow deadline. Count HTTP attempts and return that count in `ResearchMaterial.searchRequests`. Set a 30-second per-request timeout capped by remaining workflow time.

Convert Brave payloads to the common `ResearchSource` shape, cap results at three, cap snippets per source, deduplicate by normalized URL, and reject non-HTTPS or credential-bearing URLs. Never expose raw provider payloads to `ReportWriter`.

- [ ] **Step 6: Run Brave tests and typecheck**

```powershell
npm.cmd test -w @discord-dsa/bot -- brave-research.test.ts
npm.cmd run typecheck -w @discord-dsa/bot
```

Expected: Brave tests and bot typecheck PASS.

- [ ] **Step 7: Commit Brave retrieval**

```powershell
git add -- apps/bot/src/brave-research.ts apps/bot/test/brave-research.test.ts
git commit -m "feat(bot): add bounded Brave research client"
```

### Task 4: Implement strict planning and conditional search orchestration

**Files:**
- Modify: `apps/bot/test/report-writer.test.ts`
- Modify: `apps/bot/src/report-writer.ts`

**Interfaces:**
- Consumes: `GroqClient.complete(...)`
- Consumes: `BraveResearchClient.search(...)`
- Produces internal: `ResearchPlan`
- Produces internal: `plannedResearchResponseFormat(draft, countries)`
- Preserves: `ReportWriter.generate(draft, actor, onProgress?): Promise<WriterResult>`

- [ ] **Step 1: Replace OpenRouter test helpers with direct-provider helpers**

Change `fixedWriter` to construct:

```ts
return new ReportWriter("groq-secret", "openai/gpt-oss-120b", "brave-secret", COUNTRIES, {
  recordUsage: recordUsage as (userId: string, usage: AiUsage) => Promise<void>,
  request: request as unknown as typeof globalThis.fetch
});
```

Add response helpers for Groq planner completions, Groq synthesis completions, Brave Web Search, and Brave LLM Context. Each helper must return only its provider's documented fields so tests cannot accidentally depend on OpenRouter annotations, routing metadata, plugin usage, or cost.

- [ ] **Step 2: Write failing planner schema and ownership tests**

Assert the first HTTP call targets Groq and contains no `tools`, `plugins`, OpenRouter `provider`, or OpenRouter metadata header. Assert `response_format.json_schema.strict` is `true`, every property is in `required`, and both search queries plus `provisionalLawReference` accept `null`.

Cover an Auto draft and a fixed draft. For fixed fields, require the planner to echo the selected values and reject any changed country, category, or reporter explanation. For Auto fields, validate the returned country against `COUNTRIES`, category against `reportReasons(flow)`, and explanation at 1–512 characters.

- [ ] **Step 3: Write failing branch and concurrency tests**

Add these four cases:

```text
term=false, law=false -> Groq plan + Groq synthesis; no Brave URL
term=true,  law=false -> Groq plan + Brave Web Search + Groq synthesis
term=false, law=true  -> Groq plan + Brave LLM Context + Groq synthesis
term=true,  law=true  -> Groq plan + both Brave calls + Groq synthesis
```

In the fourth case, return unresolved promises from both Brave mocks and assert both fetch calls have started before resolving either promise. This proves `Promise.all` concurrency rather than relying on elapsed time.

Assert a no-law-search plan is rejected unless it supplies a complete provisional law reference. Assert inconsistent boolean/query/null combinations fail before any Brave request.

- [ ] **Step 4: Run the focused writer tests and verify they fail**

```powershell
npm.cmd test -w @discord-dsa/bot -- report-writer.test.ts
```

Expected: FAIL on the former OpenRouter/plugin workflow.

- [ ] **Step 5: Replace the research prompt/schema with the strict planner**

Define:

```ts
interface ResearchPlan {
  country: string;
  reportType: string;
  reportReason: string;
  termResearchRequired: boolean;
  termSearchQuery: string | null;
  lawResearchRequired: boolean;
  lawSearchQuery: string | null;
  provisionalLawReference: string | null;
}
```

Build a closed strict schema in which every property is required. Use `type: ["string", "null"]` for nullable values and enums for supported countries and report categories. The prompt must state the term/law decision rules, fixed-field ownership, query privacy rules, and the exact invariant between each boolean and nullable field.

Delete OpenRouter plugin prompts, routing preferences, server-tool accounting, annotations, and malformed JSON retry logic. Parse the strict Groq content once, then apply the independent semantic validations from the spec.

- [ ] **Step 6: Implement conditional search execution**

Construct `GroqClient` and `BraveResearchClient` inside `ReportWriter` from constructor values. In `generate`, execute:

```ts
const plan = await this.plan(normalizedDraft, deadline, actor);
const searches = [
  ...(plan.termResearchRequired
    ? [this.brave.search("term", validateResearchQuery(plan.termSearchQuery!, normalizedDraft), plan.country, deadline, actor)]
    : []),
  ...(plan.lawResearchRequired
    ? [this.brave.search("law", validateResearchQuery(plan.lawSearchQuery!, normalizedDraft), plan.country, deadline, actor)]
    : [])
];
const research = await Promise.all(searches);
```

Translate `GroqClientError` and `BraveResearchError` into stage-specific `ReportWriterError` messages without copying raw error bodies. Record Brave search attempts through the existing usage recorder with token counts zero and `costCredits: 0`.

- [ ] **Step 7: Run writer, config, and provider tests**

```powershell
npm.cmd test -w @discord-dsa/bot -- report-writer.test.ts config.test.ts groq-client.test.ts brave-research.test.ts
npm.cmd run typecheck -w @discord-dsa/bot
```

Expected: all focused tests and bot typecheck PASS.

- [ ] **Step 8: Commit the planner and routing workflow**

```powershell
git add -- apps/bot/src/report-writer.ts apps/bot/test/report-writer.test.ts apps/bot/src/main.ts
git commit -m "feat(bot): plan conditional legal research"
```

### Task 5: Implement strict synthesis, one follow-up, and Groq refinement

**Files:**
- Modify: `apps/bot/test/report-writer.test.ts`
- Modify: `apps/bot/src/report-writer.ts`

**Interfaces:**
- Produces internal: `SynthesisCompletion`
- Produces internal: `synthesisResponseFormat(draft, countries)`
- Preserves: `WriterResult`, `LegalResearch`, `WriterConversationMessage[]`, `refine(...)`, and `ReportWriterError.candidateReport`

- [ ] **Step 1: Write failing completed-synthesis tests**

Assert the synthesis request includes compact evidence, resolved fields, provisional law or Brave snippets, and validated source titles/URLs. Assert it excludes country catalogs, category catalogs, raw Brave payloads, failed responses, search instructions, media URLs, and OpenRouter fields.

Use a completed response with:

```json
{
  "status": "completed",
  "followUpType": null,
  "followUpQuery": null,
  "country": "DE",
  "reportType": "sub_other_hate_speech",
  "reportReason": "The profile imagery contains unlawful hate speech.",
  "lawReference": "Germany's Basic Law (Grundgesetz), Article 1",
  "researchSummary": "Article 1 protects human dignity; applicability requires review.",
  "report": "The profile imagery may contain hate speech affecting human dignity under Germany's Basic Law, Article 1. I request review and appropriate action."
}
```

Assert the returned `WriterResult`, encrypted compact conversation, deduplicated `LegalResearch.sources`, timestamp, and accumulated search-attempt count.

- [ ] **Step 2: Write failing follow-up tests**

Cover:

- law follow-up calls only LLM Context;
- term follow-up calls only Web Search;
- the follow-up query passes the same sanitization checks;
- synthesis is called exactly twice;
- the second synthesis receives initial and follow-up material;
- a second `more_research_required` result throws the specific bounded-research error; and
- an invalid follow-up type/query fails before Brave is called.

- [ ] **Step 3: Write failing validation and refusal tests**

Even under strict schema, assert application rejection of unsupported country/category, changed fixed fields, empty legal reference, empty summary, report over 512 characters, and a completed branch containing non-null follow-up fields. Assert a Groq refusal becomes `The AI declined to process this evidence.` and is not treated as malformed JSON.

- [ ] **Step 4: Write failing refinement tests**

Assert `refine` makes exactly one Groq request, sends the saved compact conversation and instruction, uses the strict one-property report schema, performs no Brave request, cannot alter country/law, and retains the existing one repair attempt only for a semantically invalid report candidate such as over 512 characters.

- [ ] **Step 5: Run the focused writer tests and verify they fail**

```powershell
npm.cmd test -w @discord-dsa/bot -- report-writer.test.ts
```

Expected: FAIL until synthesis and refinement use Groq.

- [ ] **Step 6: Implement the strict synthesis union and compact prompt**

Define all synthesis properties as required and nullable where branch-specific. Parse to:

```ts
type SynthesisCompletion =
  | {
      status: "completed";
      followUpType: null;
      followUpQuery: null;
      country: string;
      reportType: string;
      reportReason: string;
      lawReference: string;
      researchSummary: string;
      report: string;
    }
  | {
      status: "more_research_required";
      followUpType: "term" | "law";
      followUpQuery: string;
      country: null;
      reportType: null;
      reportReason: null;
      lawReference: null;
      researchSummary: null;
      report: null;
    };
```

Use one closed object schema with every property required. Make branch-specific values nullable with `type: ["string", "null"]`, and enforce the two status branches with the TypeScript parser rather than embedding a nested `anyOf` union in the provider schema.

- [ ] **Step 7: Implement exactly one follow-up and assemble the result**

Call synthesis once. On `more_research_required`, validate and perform exactly one matching Brave search, append its compact material, and call synthesis once more. Reject another follow-up. On completion, create `LegalResearch`, compact conversation, and `WriterResult` while preserving existing progress callbacks and candidate-report recovery behavior.

- [ ] **Step 8: Migrate refinement and repair to Groq**

Replace `openRouter(...)` calls with `GroqClient.complete(...)`. Use `max_completion_tokens: 4096`, `reasoning_effort: "low"`, strict report schema, and no tools. Preserve the existing conversational repair cap and 512-character application validation.

- [ ] **Step 9: Run all bot tests and typecheck**

```powershell
npm.cmd test -w @discord-dsa/bot
npm.cmd run typecheck -w @discord-dsa/bot
```

Expected: all bot tests PASS with no OpenRouter expectations remaining.

- [ ] **Step 10: Commit synthesis and refinement**

```powershell
git add -- apps/bot/src/report-writer.ts apps/bot/test/report-writer.test.ts
git commit -m "feat(bot): synthesize reports with Groq"
```

### Task 6: Update UI wording and canonical operator documentation

**Files:**
- Modify: `apps/bot/test/bot.test.ts`
- Modify: `apps/bot/src/ui.ts`
- Modify: `README.md`
- Modify: `docs/BOT_API.md`
- Modify: `docs/BOT_IMPLEMENTATION.md`

**Interfaces:**
- Preserves: existing access view database fields and `AiUsage` storage shape
- Changes: user-visible AI usage omits provider cost
- Documents: required deployment variables and Groq ZDR operator action

- [ ] **Step 1: Write the failing access-embed assertion**

Update the existing access embed test to expect:

```text
Requests: **4**
Input tokens: **2,400**
Output tokens: **650**
Reasoning tokens: **180**
Web searches: **3**
```

Assert the value does not contain `OpenRouter`, `cost`, or `credits`.

- [ ] **Step 2: Run the focused UI test and verify it fails**

```powershell
npm.cmd test -w @discord-dsa/bot -- bot.test.ts
```

Expected: FAIL because the embed still renders OpenRouter cost.

- [ ] **Step 3: Remove the stale cost line without changing database compatibility**

Delete only this entry from `accessEmbed`:

```ts
`OpenRouter cost: **${access.aiCostCredits.toFixed(6)} credits**`
```

Do not migrate or delete the existing database column and do not remove `AiUsage.costCredits` in this change.

- [ ] **Step 4: Rewrite current documentation around the implemented workflow**

Update all three canonical documents with these exact operational facts:

- Groq is called directly with default model `openai/gpt-oss-120b`.
- Production operators must enable Groq ZDR in Data Controls.
- The planner independently decides whether term and law research are required.
- Term research uses Brave Web Search; law research uses Brave LLM Context.
- Both initial searches run concurrently when needed.
- The system permits one follow-up search and has no provider fallback.
- Brave queries are sanitized and never contain the prohibited identifiers/media.
- Refinement reuses research and does not search; regeneration starts fresh.
- Required variables are `GROQ_API_KEY`, `GROQ_MODEL`, and `BRAVE_SEARCH_API_KEY`.
- AI usage reports requests/tokens/reasoning/searches without an estimated provider cost.

Remove statements describing OpenRouter provider routing, Parallel plugins, OpenRouter annotations, MiniMax reasoning, OpenRouter balance, or OpenRouter-specific failures. Preserve unrelated API/bot lifecycle documentation.

- [ ] **Step 5: Search for stale provider references**

Run:

```powershell
rg -n "OPENROUTER|OpenRouter|openrouter|MiniMax|minimax|Parallel web|server_tool_use" README.md apps/bot docs/BOT_API.md docs/BOT_IMPLEMENTATION.md
```

Expected: no current-runtime references remain. Historical design/spec/plan documents outside the searched current documentation may retain historical decisions.

- [ ] **Step 6: Run focused tests and documentation-adjacent typecheck**

```powershell
npm.cmd test -w @discord-dsa/bot -- bot.test.ts config.test.ts report-writer.test.ts groq-client.test.ts brave-research.test.ts
npm.cmd run typecheck -w @discord-dsa/bot
```

Expected: PASS.

- [ ] **Step 7: Commit UI and documentation changes**

```powershell
git add -- apps/bot/src/ui.ts apps/bot/test/bot.test.ts README.md apps/bot/.env.example docs/BOT_API.md docs/BOT_IMPLEMENTATION.md
git commit -m "docs: document Groq Brave report research"
```

### Task 7: Run repository-wide verification and review the final diff

**Files:**
- Verify: all files changed in Tasks 1–6

**Interfaces:**
- Produces: a fully verified direct Groq + conditional Brave implementation

- [ ] **Step 1: Run formatting and whitespace checks**

```powershell
git diff --check
```

Expected: no output and exit code 0.

- [ ] **Step 2: Run every repository-required validation command**

```powershell
npm.cmd run lint
npm.cmd run typecheck
npm.cmd test
npm.cmd run build
npm.cmd run audit:high
```

Expected: every command exits 0. Do not run the protected Discord transport diagnostics.

- [ ] **Step 3: Verify scope and secrets**

```powershell
git status --short
git diff --stat ff769d9..HEAD
git diff --name-only ff769d9..HEAD
rg -n "sk-|gsk_|OPENROUTER_API_KEY=.+|GROQ_API_KEY=.+|BRAVE_SEARCH_API_KEY=.+" apps README.md docs packages
```

Expected: only the plan plus planned source, test, environment-example, and documentation files changed; example variables contain placeholders; no real key-like value appears.

- [ ] **Step 4: Review behavioral invariants from tests**

Confirm the passing suite demonstrates:

```text
strict Groq planning JSON
zero/term/law/both conditional branches
parallel dual-search start
sanitized Brave queries
compact extracted law passages
one bounded follow-up
strict final JSON and 512-character enforcement
Groq-only refinement
no OpenRouter runtime path
safe logs and preserved usage counters
```

- [ ] **Step 5: Commit any verification-only corrections explicitly**

If verification required a correction, stage only its exact files and commit with a message describing that correction. If no correction was needed, create no empty commit.
