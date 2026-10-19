# Epic #14: Model gateway

**Goal:** a provider-neutral gateway that implements the run loop's `ModelPort`, enforces Zod-validated structured outputs across providers, preserves provider-specific blobs for rehydration, and applies retries, fallbacks, and cost accounting. Read `docs/engineering/CONVENTIONS.md` first.
**Tasks:** 14.1 to 14.20, all size S.

Shared design for this epic:

- Package `packages/models` exports `ModelGateway implements ModelPort` (port defined in 2.3). Providers plug in through `ProviderAdapter`. The gateway owns enforcement, repair, retry, routing, and accounting; adapters only translate to and from one provider's wire format.
- **No PII logic here.** The PII tokenizer (epic 13) wraps the gateway at the `model_input` boundary. The gateway only receives already-tokenized messages and exposes a provider `trust` level for epic 13 to use.
- **Serializable requests.** `ModelRequest` must be JSON-serializable (Zod schema objects are passed separately as `outputSchema`; the request carries only its JSON Schema and `schemaHash`). This keeps cassettes and replay deterministic.
- Never hardcode prices or model capabilities as truth. Ship conservative defaults and let config override.

---

## 14.1 Decision record: provider adapters (AI SDK vs thin adapters)

**Parent:** #14 Model gateway
**Task Description:** Run a time-boxed spike and record an architecture decision on how provider adapters are built.
**Expected Inputs:** Requirements in this epic; API keys for a spike (local only, never committed).
**Expected Output:** `docs/decisions/0001-model-adapter-strategy.md`, spike script `scripts/spikes/model-adapter-roundtrip.ts` (kept under `scripts/spikes`, excluded from builds).
**Dependencies:** `ai` plus `@ai-sdk/anthropic`, `@ai-sdk/openai` (Vercel AI SDK) and the official `@anthropic-ai/sdk`, `openai` (spike only; verify current package names and licenses).
**Items it depends on:** none.
**Implementation guidance:**

1. Time-box to one day. Implement the same three scenarios in each approach for Anthropic and OpenAI: (a) plain text; (b) forced tool call with Zod-derived schema; (c) multi-turn with tool use where the second request is rebuilt **only from stored JSON** of the first response.
2. Score each approach on: round-trip fidelity of raw provider blobs (reasoning blocks, tool-call IDs, signatures), access to raw responses, abort signal support, usage reporting, retry control (must be disable-able), forced tool choice, native structured output access, dependency weight and license, stability.
3. Decision rule: if the AI SDK cannot expose and re-send raw provider blobs byte-for-byte, choose thin adapters over the official SDKs. Otherwise pick the lower maintenance option.
4. ADR format: Context, Options, Decision, Consequences, and a list of tasks whose guidance changes. Guidance in 14.4 to 14.6 assumes thin adapters; if the ADR chooses the AI SDK, add an "ADR adjustments" section to those tasks in the PR rather than rewriting them.
**Tests to write:** None shipped. The spike script prints a pass/fail table for the three scenarios, copied into the ADR.
**Acceptance Criteria:**

- [ ] ADR merged with a clear decision and the evidence table.
- [ ] Spike code is not part of any published package.
- [ ] Tasks 14.4 to 14.6 reviewed against the decision.

---

## 14.2 Normalized message, tool-call and usage types plus capability matrix

**Parent:** #14 Model gateway
**Task Description:** Define the provider-neutral message and request/response schemas and the capability matrix, and tighten the event schemas to use them.
**Expected Inputs:** `JsonValue`, `Id`, `Code` primitives.
**Expected Output:** `packages/schemas/src/messages.ts`, `packages/schemas/src/capabilities.ts`, updated `model_request.messages` and `model_response.content` types in `events.ts`, updated golden files.
**Dependencies:** `zod`.
**Items it depends on:** 7.1, 2.3.
**Implementation guidance:**

1. `Part` discriminated union on `type`: `text {text: string}`, `tool_call {callId: Id, toolId: Code, args: JsonValue}`, `tool_result {callId: Id, result: JsonValue, isError: boolean}`, `opaque {provider: Code, blob: JsonValue}`. `Message = { role: "system"|"user"|"assistant"|"tool", parts: Part[] }`.
2. `ModelRef = { provider: Code, model: Code }`. `ToolSpec = { toolId: Code, description: string, inputSchema: JsonValue }`. `ModelRequest = { requestId: Id, model: ModelRef, role?: Code, messages: Message[], tools?: ToolSpec[], output?: { name: Code, schema: JsonValue, schemaHash: Sha256Hex }, toolChoice?: "auto"|"none"|{ forced: Code }, maxOutputTokens?: int, temperature?: number }`.
3. `ModelResponse = { parts: Part[], usage: { inputTokens: int, outputTokens: int, costMicros?: int }, finishReason: Code, provider: Code, model: Code, latencyMs: int, schemaValid: boolean, repairAttempts: int, rungUsed?: Code, fallbackDepth: int }`.
4. `capabilities.ts`: `Capabilities = { structuredOutput: "native"|"tool"|"json_mode"|"none", forcedToolChoice: boolean, parallelToolCalls: boolean, maxContextTokens: int, opaqueRoundTrip: boolean }`; `lookupCapabilities(ref, overrides)` returns provider defaults merged with config overrides; unknown model returns the provider default and `source: "default"`.
5. Update events: `model_request.messages` becomes `z.array(Message)` (content), `model_response.content` becomes `z.array(Part)` (content), add `rungUsed?` and `fallbackDepth` as meta fields in `model_response` and `classification.ts`. Update the 2.3 `ModelPort` types and goldens accordingly.
**Tests to write:** schema round-trips for each part type; invalid parts rejected; capability merge precedence; event golden tests regenerated and reviewed; classification exhaustiveness test still passes.
**Acceptance Criteria:**

- [ ] One set of message types shared by core, events, and gateway.
- [ ] Event classification still exhaustive.
- [ ] Run loop tests pass with the tightened types.

---

## 14.3 Provider adapter interface, error taxonomy, fake provider, contract suite

**Parent:** #14 Model gateway
**Task Description:** Define `ProviderAdapter`, the provider error taxonomy, a scripted `FakeProvider`, a minimal `ModelGateway`, and the reusable provider contract test suite.
**Expected Inputs:** `ModelRequest`.
**Expected Output:** `packages/models/src/{types.ts,errors.ts,gateway.ts,registry.ts,testing/fake-provider.ts,contract.ts}`, package scaffold.
**Dependencies:** `undici` (for contract HTTP mocks, `MockAgent`).
**Items it depends on:** 14.2.
**Implementation guidance:**

1. `interface ProviderAdapter { readonly provider: Code; complete(req: ModelRequest, ctx: { signal: AbortSignal; ids: IdGenerator; clock: Clock }): Promise<ProviderResult> }` with `ProviderResult = { parts: Part[]; usage; finishReason: Code; latencyMs: number }`. Adapters never retry, repair, or enforce schemas.
2. Errors extend `HarnessError`: `ProviderError { code, retryable: boolean, retryAfterMs?: number, status?: number }` with codes `provider_rate_limited` (retryable), `provider_timeout` (retryable), `provider_unavailable` (retryable), `provider_bad_request`, `provider_auth`, `provider_content_filtered`, `provider_unknown`.
3. `AdapterRegistry` maps provider code to adapter; unknown provider throws `provider_not_registered`.
4. `ModelGateway.complete(req, ctx)` in this task only selects the adapter and maps `ProviderResult` to the `ModelPort` result (`schemaValid: true`, `repairAttempts: 0`, `fallbackDepth: 0`).
5. `contract.ts` exports `runProviderContract(name, makeAdapter, fixtures)`: scenarios `text_only`, `tool_call`, `usage_mapping`, `error_429`, `error_500`, `error_401`, `abort_signal`, each driven by HTTP fixtures served via `undici` `MockAgent` (adapters accept an injected `fetch`/dispatcher). Define the fixture format `{ scenario, request, httpResponse }`.
6. `FakeProvider` replays scripted `ProviderResult`s and records requests.
**Tests to write:** gateway selects adapters; unknown provider error; fake provider scripting; contract suite runs against `FakeProvider` through a trivial HTTP shim to prove the suite works.
**Acceptance Criteria:**

- [ ] Contract suite reusable by every adapter task.
- [ ] Error taxonomy documented with retryability.
- [ ] Gateway satisfies the `ModelPort` type.

---

## 14.4 Anthropic adapter

**Parent:** #14 Model gateway
**Task Description:** Implement the Anthropic Messages API adapter with lossless blob round trip.
**Expected Inputs:** `ModelRequest`, API key `Secret`.
**Expected Output:** `packages/models/src/providers/anthropic.ts`, fixtures in `packages/models/src/providers/__fixtures__/anthropic/`, contract test, optional `LIVE` test.
**Dependencies:** `@anthropic-ai/sdk` (verify API surface and current model parameter names).
**Items it depends on:** 14.3, 20.3.
**Implementation guidance:**

1. Construct the client with `maxRetries: 0` and an injected `fetch`. System messages become the `system` parameter; other roles map to `user`/`assistant`.
2. Request building: for assistant messages containing an `opaque` part with `provider === "anthropic"`, use `blob.content` (the raw content blocks, including thinking blocks and signatures) verbatim instead of the normalized parts. Otherwise map `text` to a text block and `tool_call` to `{type:"tool_use", id, name, input}`.
3. Tool IDs: Anthropic ids are not ULIDs. When parsing a response, generate our `callId` via `ids.next()` and record `{ [callId]: toolu_id }` in the opaque blob as `toolUseIdByCallId`. `tool_result` parts map `callId` back through the blob map (searching the previous assistant `opaque` part); if no map exists (provider switch), use the deterministic id `toolu_` + `callId`.
4. Response: `parts = [...normalized text/tool_call parts, { type: "opaque", provider: "anthropic", blob: { content: <raw blocks>, toolUseIdByCallId } }]`. Usage from `usage.input_tokens/output_tokens`. `finishReason`: `end_turn`, `tool_use`, `max_tokens`, `stop_sequence`, else `other`.
5. Forced tool: `tool_choice: { type: "tool", name }`; `toolChoice: "none"` omits tools. Capabilities default: `structuredOutput: "tool"`, `forcedToolChoice: true`, `opaqueRoundTrip: true`.
6. Map SDK errors by HTTP status to `ProviderError` (429 with `retry-after` header seconds to `retryAfterMs`, 5xx/529 to `provider_unavailable`, 401/403 to `provider_auth`, 400 to `provider_bad_request`); abort to `provider_timeout` or rethrow abort per contract.
**Tests to write:** `runProviderContract` with recorded fixtures (text, tool use, thinking blocks); round-trip test: serialize a response through JSON, rebuild the next request, assert assistant blocks byte-equal; header-driven `retryAfterMs`; `LIVE`-tagged test skipped without `ANTHROPIC_API_KEY`.
**Acceptance Criteria:**

- [ ] Contract suite passes with fixtures.
- [ ] Thinking blocks and signatures survive a JSON round trip unchanged.
- [ ] The SDK's internal retries are disabled.

---

## 14.5 OpenAI adapter

**Parent:** #14 Model gateway
**Task Description:** Implement the OpenAI Chat Completions adapter, sharing a mapper that 14.6 reuses.
**Expected Inputs:** `ModelRequest`, API key `Secret`.
**Expected Output:** `packages/models/src/providers/chat-completions-mapper.ts`, `packages/models/src/providers/openai.ts`, fixtures, contract test.
**Dependencies:** `openai` SDK (verify parameter names such as `max_completion_tokens`).
**Items it depends on:** 14.3, 20.3.
**Implementation guidance:**

1. Client with `maxRetries: 0` and injected `fetch`.
2. Mapper (pure, reusable): `toChatRequest(req, quirks)` and `fromChatResponse(res, ids)`. Messages: system/user/assistant/tool; assistant tool calls become `tool_calls: [{id, type: "function", function: {name, arguments: JSON.stringify(args)}}]`; `tool_result` parts become `role: "tool"` messages with `tool_call_id`.
3. Call ids: store `{ [callId]: openaiCallId }` in an opaque blob together with the raw assistant `message`; reuse the blob for the same provider like 14.4. Parse `function.arguments` with `JSON.parse` guarded by try/catch; invalid JSON yields a `text`-less response with finishReason `tool_args_invalid` and the raw string in the blob so the repair loop (14.10) can react.
4. Native structured output: when `output` is set and capability is `native`, set `response_format: { type: "json_schema", json_schema: { name, schema, strict: true } }` (schemas must be lowered by 14.7).
5. Usage from `prompt_tokens`/`completion_tokens`. Finish reasons: `stop`, `tool_calls`, `length`, `content_filter` to Codes.
6. Capabilities default: `structuredOutput: "native"`, `forcedToolChoice: true`, `parallelToolCalls: true`. Error mapping as in 14.4.
**Tests to write:** contract suite with fixtures; mapper unit tests (tool call round trip, invalid arguments JSON path, multi-tool-call response); `LIVE`-tagged test.
**Acceptance Criteria:**

- [ ] Contract suite passes.
- [ ] Mapper is shared and covered independently of HTTP.
- [ ] Invalid tool arguments produce a recoverable, typed result, not an exception.

---

## 14.6 OpenAI-compatible local endpoint adapter

**Parent:** #14 Model gateway
**Task Description:** Support OpenAI-compatible servers (Ollama, vLLM, LM Studio) with configurable capabilities and a trust level.
**Expected Inputs:** Provider config with `baseUrl`, optional key, `capabilities` overrides, `trust`.
**Expected Output:** `packages/models/src/providers/openai-compatible.ts`, models config fragment `packages/schemas/src/config/models.ts` (providers list), fixtures, `docs/models/local-endpoints.md`.
**Dependencies:** none beyond 14.5.
**Items it depends on:** 14.5.
**Implementation guidance:**

1. Reuse the mapper; the adapter takes `quirks` (for example `useMaxTokens: true` instead of `max_completion_tokens`, `supportsStrictSchema: false`).
2. Provider config fragment: `{ id: Code, kind: "anthropic"|"openai"|"openai_compatible", baseUrl?: url, apiKey?: SecretRef, trust: "hosted"|"local", requestsPerMinute?: int, capabilities?: Partial<Capabilities>, quirks?: {...} }`. `trust` is consumed by epic 13 (13.9).
3. Conservative defaults for compatible endpoints: `structuredOutput: "json_mode"`, `forcedToolChoice: false`, `opaqueRoundTrip: false`.
4. Reject non-HTTPS `baseUrl` unless host is `localhost`, `127.0.0.1`, `::1`, or `trust: "local"` is explicitly set.
5. Document recommended settings for Ollama and vLLM.
**Tests to write:** contract suite with local-style fixtures; HTTPS rule table; capability defaults and overrides; quirk handling of token parameter names.
**Acceptance Criteria:**

- [ ] A local endpoint works through the same contract suite.
- [ ] Plain-HTTP remote hosts rejected unless explicitly trusted.
- [ ] `trust` flows into the provider registry for later use.

---

## 14.7 Zod to JSON Schema conversion with per-provider subset compatibility

**Parent:** #14 Model gateway
**Task Description:** Convert Zod schemas to JSON Schema and lower them to what each provider accepts, with a record of dropped constraints.
**Expected Inputs:** Zod schema, provider id.
**Expected Output:** `packages/models/src/json-schema.ts` (`toJsonSchema`, `lowerForProvider`, `schemaHash`), `packages/models/src/provider-schema-rules.ts`.
**Dependencies:** Zod's built-in JSON Schema conversion if the installed major provides it, otherwise `zod-to-json-schema` (verify).
**Items it depends on:** 14.2.
**Implementation guidance:**

1. `toJsonSchema(schema)` returns a draft-2020-12 compatible object, `$ref`-inlined, with no `$schema` key. Recursive schemas throw `schema_recursive_unsupported`.
2. `provider-schema-rules.ts` encodes per provider: allowed keywords, whether `additionalProperties:false` and all-required is mandatory (OpenAI strict mode), handling of optional fields (convert optional to required nullable when mandatory), unsupported keywords (`pattern`, `format`, numeric bounds, `minLength`, `default`, `oneOf`) as data. Mark the table "verify against current provider docs" and cover it with a regression test fixture so changes are deliberate.
3. `lowerForProvider(schema, provider) -> { schema, dropped: Code[] }` removes unsupported keywords, rewrites optional fields when required, and records dropped keyword names. Dropped constraints are still enforced by the Zod parse after the call (14.8).
4. `schemaHash(jsonSchema)` = SHA-256 of canonical JSON (sorted keys, no whitespace).
5. Only pass Id/Code-like regex constraints through where a provider supports `pattern`.
**Tests to write:** table of schemas (objects, arrays, enums, unions, nullable, optional, defaults, regex strings, numeric bounds, recursive) times providers, asserting the lowered schema matches golden JSON; hash stability across key orders; dropped list correctness; lowered schema validates every sample that the original accepts (using `ajv` in tests).
**Acceptance Criteria:**

- [ ] Recursive schemas rejected with a clear code.
- [ ] Lowering never produces keywords outside the provider's allowed set.
- [ ] Hash is stable and independent of property order.

---

## 14.8 Enforcement rungs 1 and 2: native structured output, then forced tool call

**Parent:** #14 Model gateway
**Task Description:** Implement the top two rungs of the structured-output ladder inside the gateway.
**Expected Inputs:** `ModelRequest` with `output`, Zod `outputSchema`, capabilities.
**Expected Output:** `packages/models/src/enforce/{rung-native.ts,rung-tool.ts,index.ts}`, gateway integration `complete(req, { outputSchema })`.
**Dependencies:** none.
**Items it depends on:** 14.4, 14.5, 14.7.
**Implementation guidance:**

1. Rung choice: `native` if `structuredOutput === "native"`, else `tool` if `forcedToolChoice` is true, else defer to 14.9. Config `models.enforcement.maxRung` can cap it.
2. Native rung: pass the lowered schema via the adapter-specific option on `ModelRequest.output`; read the output from the single `text` part, `JSON.parse`, then `outputSchema.safeParse`.
3. Tool rung: add a synthetic tool `emit_result` (`toolId` Code) whose `inputSchema` is the lowered schema, set `toolChoice: { forced: "emit_result" }`, read the `tool_call.args`, then `safeParse`. Strip the synthetic call from the returned parts and expose the validated value as a `text` part containing canonical JSON plus metadata `rungUsed`.
4. Return `{ value, valid: true, rungUsed }` or `{ valid: false, issues }` (issues are Zod paths and codes only). No repair yet.
5. Reject requests that combine `output` with real `tools` (`output_with_tools_unsupported`) in this task.
**Tests to write:** fake provider scripts for both rungs with valid and invalid outputs; rung selection table by capability; `maxRung` cap; synthetic tool stripped; combination rejection.
**Acceptance Criteria:**

- [ ] Valid output returns a typed value and `rungUsed`.
- [ ] Invalid output returns structured issues, not exceptions.
- [ ] Synthetic tool never leaks into returned parts.

---

## 14.9 Rung 3: prompt-and-validate fallback

**Parent:** #14 Model gateway
**Task Description:** Support providers with neither native structured output nor forced tools by prompting for JSON and validating.
**Expected Inputs:** Request, Zod schema, capabilities with `json_mode` or `none`.
**Expected Output:** `packages/models/src/enforce/rung-prompt.ts`, tolerant JSON extractor `packages/models/src/enforce/extract-json.ts`.
**Dependencies:** none.
**Items it depends on:** 14.8.
**Implementation guidance:**

1. Add an instruction to the system message: respond with a single JSON value matching the provided JSON Schema, no commentary. Embed the lowered schema as compact JSON. If capability is `json_mode`, also request the provider's JSON mode via an adapter option.
2. `extractJson(text)`: strip optional markdown code fences; find the first balanced `{...}` or `[...]` using a character scanner that tracks string state and escapes (no regex); `JSON.parse` that slice. Return `{ ok: false, code: "no_json" | "invalid_json" }` on failure.
3. Then `outputSchema.safeParse`. Same return shape as 14.8 with `rungUsed: "prompt"`.
4. Never include user content in error codes.
**Tests to write:** extractor cases (fenced, leading prose, trailing prose, nested braces in strings, escaped quotes, arrays, truncated JSON, no JSON); end-to-end with fake provider for valid and invalid outputs.
**Acceptance Criteria:**

- [ ] Extractor handles all listed formats without regex.
- [ ] Truncated or missing JSON yields typed failure.
- [ ] Rung selection falls through to prompt only when higher rungs are unavailable.

---

## 14.10 Bounded repair loop

**Parent:** #14 Model gateway
**Task Description:** On validation failure, feed structured errors back to the model a bounded number of times.
**Expected Inputs:** Failed enforcement result, `maxRepairs` (default 2).
**Expected Output:** `packages/models/src/enforce/repair.ts`, `ModelOutputInvalidError` (`model_output_invalid`), aggregate usage and `repairAttempts` on the response.
**Dependencies:** none.
**Items it depends on:** 14.8, 14.9.
**Implementation guidance:**

1. Repair message is built **only from issue paths and expected-type descriptors** (for example `"$.items[2].count: expected integer"`), never from echoed values.
2. Each repair attempt appends the model's previous output as an assistant message and the repair instruction as a user message, then re-runs the same rung. Cap attempts at `models.enforcement.maxRepairs`.
3. Aggregate usage and latency across attempts; `repairAttempts` equals the number of repair calls; `schemaValid` true only if a final attempt validated.
4. After exhaustion throw `ModelOutputInvalidError` carrying attempt count and issue paths. The routing layer (14.13) may fall back.
5. Repair calls are separate adapter calls but one logical `model_call` span with attribute `harness.model.repair_attempts`.
**Tests to write:** valid after 1 repair; exhausted after N; repair message contains no echoed values (property test using canary values in invalid output); usage aggregation; span attribute set.
**Acceptance Criteria:**

- [ ] Never more than `maxRepairs` repair calls.
- [ ] Repair prompts contain no model output values.
- [ ] Aggregated usage and attempts reported accurately.

---

## 14.11 Opaque provider blobs stored and round-tripped through rehydration

**Parent:** #14 Model gateway
**Task Description:** Guarantee that reasoning blocks and provider ids survive storage and resume, and degrade cleanly when the provider changes mid-run.
**Expected Inputs:** Messages containing `opaque` parts, target provider.
**Expected Output:** `packages/models/src/blobs.ts` (`prepareMessagesForProvider`), tests across the store, docs section `docs/models/rehydration.md`.
**Dependencies:** none.
**Items it depends on:** 14.4, 14.5, 7.9.
**Implementation guidance:**

1. `prepareMessagesForProvider(messages, provider): Message[]` pure function: keep `opaque` parts whose `provider` matches; drop others; for assistant messages left without a matching blob keep their normalized `text` and `tool_call` parts so any provider can continue.
2. Ensure tool-result id mapping stays consistent after dropping blobs: tool results always reference our `callId`, adapters derive provider ids deterministically when no map exists (see 14.4 step 3).
3. Rehydration test pipeline: run fake conversation, persist response events through the real SQLite store with the AES codec (7.9), read back, build the next request, and assert the adapter's outgoing payload for blob-backed messages is identical to the original response blocks.
4. Document the rule for adapter authors: every new adapter must set `opaqueRoundTrip` in capabilities honestly and pass this test.
**Tests to write:** unit tests for `prepareMessagesForProvider` (match, mismatch, mixed); integration test through store and codec for Anthropic thinking blocks and OpenAI raw message; provider-switch continuation works with normalized parts.
**Acceptance Criteria:**

- [ ] Blob-backed requests are byte-identical after a store round trip.
- [ ] Provider switch continues without error.
- [ ] Documented for adapter authors.

---

## 14.12 Retry, timeout, and rate-limit handling under run budgets

**Parent:** #14 Model gateway
**Task Description:** Add retries with backoff, per-attempt timeouts, provider rate limiting, and deadline awareness.
**Expected Inputs:** Retry policy, provider `requestsPerMinute`, run deadline.
**Expected Output:** `packages/models/src/resilience/{retry.ts,limiter.ts,semaphore.ts}`, config fragment `models.retry`, gateway integration, span attribute `harness.model.attempts`.
**Dependencies:** none.
**Items it depends on:** 14.3, 2.12.
**Implementation guidance:**

1. `RetryPolicy { maxAttempts: 3, baseDelayMs: 500, maxDelayMs: 20_000, timeoutMs: 120_000 }`. Delay = full jitter: `random(0, min(maxDelay, base * 2^attempt))`, replaced by `retryAfterMs` when larger. Inject `Random` and `sleep` for tests.
2. Retry only `ProviderError.retryable`. Never retry `model_output_invalid`.
3. Per attempt: `AbortSignal.any([ctx.signal, AbortSignal.timeout(timeoutMs)])`.
4. Deadline: `ctx.deadlineTs` (from the budget tracker). If `now + delay >= deadlineTs`, stop and throw the last error with code `deadline_exceeded`.
5. Token-bucket limiter per provider (`requestsPerMinute`, burst equals one minute rate capped at 10) and a concurrency semaphore (`maxConcurrent` default 4), both using the injected clock.
6. Count attempts into the `harness.model_call` span attribute (`attr.int`).
**Tests to write:** backoff schedule with fake random/sleep; honors `retryAfterMs`; non-retryable fails fast; deadline stops retries; limiter enforces rate with fake clock; semaphore bounds concurrency; abort cancels waits.
**Acceptance Criteria:**

- [ ] Retries never exceed `maxAttempts` or the run deadline.
- [ ] Rate and concurrency limits enforced per provider.
- [ ] Abort interrupts sleeping retries immediately.

---

## 14.13 Cross-model fallback, routing policy, and runtime wiring

**Parent:** #14 Model gateway
**Task Description:** Route requests by role with ordered fallbacks, and wire the real gateway into `createRuntime`.
**Expected Inputs:** Routing config, role per request.
**Expected Output:** `packages/models/src/routing.ts`, config fragment `models.routing`, `createRuntime` wiring in `packages/core/src/runtime.ts`, docs `docs/models/routing.md`.
**Dependencies:** none.
**Items it depends on:** 14.10, 14.11, 14.12, 2.10.
**Implementation guidance:**

1. Config: `routing: { default: ModelRef[]; roles: Record<Code, ModelRef[]> }`. First entry is primary; the rest are fallbacks in order.
2. Fallback triggers: retries exhausted on retryable errors, `provider_unavailable`, `model_output_invalid`. Never fall back on `provider_bad_request`, `provider_auth`, `provider_content_filtered` (configurable via `fallbackOn: Code[]`).
3. On fallback, prepare messages for the new provider with `prepareMessagesForProvider` (14.11), increment `fallbackDepth`, and report the provider/model actually used in the response.
4. `createRuntime` builds adapters from `models.providers` (secrets via 20.3), constructs the gateway with enforcement, retry, routing configs, and injects it as the `ModelPort`. Keep `--fake-model` override for tests.
5. Fail startup if routing references an unknown provider (`routing_provider_unknown`).
**Tests to write:** primary failure falls to secondary; non-fallback errors surface; role routing; opaque parts dropped on switch; startup validation; end-to-end run with two fake providers where the first fails.
**Acceptance Criteria:**

- [ ] Fallback order respected and reported via `fallbackDepth`.
- [ ] Misconfigured routing fails at startup.
- [ ] A CLI run uses the configured gateway.

---

## 14.14 Cost and token accounting

**Parent:** #14 Model gateway
**Task Description:** Compute cost from configured prices and report tokens and cost on events, spans, and metrics.
**Expected Inputs:** Usage, pricing config.
**Expected Output:** `packages/models/src/pricing.ts`, config fragment `models.pricing`, `examples/pricing.example.yaml`, span attributes `harness.model.input_tokens`, `harness.model.output_tokens`, `harness.model.cost_micros`, metrics `harness.model.tokens` and `harness.model.cost_micros` counters.
**Dependencies:** none.
**Items it depends on:** 14.3, 2.12, 4.1.
**Implementation guidance:**

1. Pricing config: `pricing: Record<"provider/model", { inputMicrosPerMTok: int, outputMicrosPerMTok: int }>`. Do not ship real prices; the example file is clearly marked as an illustration and must be reviewed by the operator.
2. `costMicros = Math.round(inputTokens * inputMicrosPerMTok / 1_000_000 + outputTokens * outputMicrosPerMTok / 1_000_000)`, computed with integers (use `BigInt` internally if intermediate values may exceed 2^53).
3. If no price is configured omit `costMicros` and log `pricing_missing` once per model.
4. Populate `model_response.costMicros` (field added in 2.12), the three span attributes (define them in the registry), and OTel counters whose only attributes are `provider` and `model` (Codes from config, thus bounded).
5. Sum repair-attempt and retry usage (only successful attempts return usage; failed attempts with usage in error payloads are added if present).
**Tests to write:** cost arithmetic table including large token counts; missing price behavior; aggregation across repairs; span attributes present; metric attributes bounded to provider/model.
**Acceptance Criteria:**

- [ ] Cost is integer micros and matches hand-computed cases.
- [ ] Budgets (2.12) trigger from the reported cost in an end-to-end test.
- [ ] No prices hardcoded in source.

---

## 14.15 Cassette provider for record and replay

**Parent:** #14 Model gateway
**Task Description:** Record real provider responses and serve them back deterministically, including from the event log for replay.
**Expected Inputs:** Requests, real adapter or stored responses.
**Expected Output:** `packages/models/src/cassette/{cassette-provider.ts,file-store.ts,event-log-store.ts,hash.ts}`.
**Dependencies:** none.
**Items it depends on:** 14.3, 14.11, 7.2.
**Implementation guidance:**

1. `requestHash(req)`: SHA-256 of canonical JSON of the request with volatile fields removed (`requestId`) and keys sorted.
2. `CassetteProvider(mode: "record" | "replay" | "auto", store, inner?)`. Record: call `inner`, save `{ hash, response }`. Replay: look up by hash, throw `cassette_miss` (with the hash) if absent. Auto: replay when present, record otherwise (disabled in CI by an env guard `HARNESS_CASSETTE_AUTO=0`).
3. `FileCassetteStore`: one JSON file per scenario, entries sorted by hash, stable formatting, committed to the repo. Content must be tokenized or synthetic; a header comment field `containsRealData: false` is required and checked on load. The file format is a Zod schema (`CassetteFile`, including `containsRealData: z.literal(false)`) read with `parseJson` (CONVENTIONS 3.10).
4. `EventLogCassetteStore(events)`: serves responses in **order** from `model_request`/`model_response` pairs in an event log (used by replay, 9.2). It verifies the hash of each incoming request equals the recorded request's hash and throws `cassette_divergence` otherwise.
5. Cassette provider registers as a normal `ProviderAdapter` with provider code `cassette`.
**Tests to write:** record then replay identical; hash ignores `requestId` and key order; miss error; ordered mode divergence detection; auto mode disabled by env guard; file format stability (golden).
**Acceptance Criteria:**

- [ ] Replayed responses are byte-identical to recorded ones.
- [ ] Divergence is detected, not silently served.
- [ ] Cassette files require the `containsRealData: false` declaration.

---

## 14.16 Streaming responses with idle timeouts and progress

**Parent:** #14 Model gateway
**Task Description:** Let adapters stream responses so long generations do not hit total-request timeouts, and report progress counts to subscribers, while the recorded response stays identical to a non-streamed one.
**Expected Inputs:** `ModelRequest`, provider streaming APIs.
**Expected Output:** optional `ProviderAdapter.stream(req, ctx): AsyncIterable<ProviderDelta>` plus `assembleDeltas`, gateway integration, config `models.providers[].streaming: boolean` (default true where supported), `onProgress` hook on the gateway context.
**Dependencies:** none beyond the adapter SDKs (verify streaming event shapes).
**Items it depends on:** 14.4, 14.5, 14.12.
**Implementation guidance:**

1. `ProviderDelta` is a provider-neutral union (text delta, tool-call argument delta, opaque block delta, usage, finish). `assembleDeltas` builds a `ProviderResult` equal to the non-streamed result for the same fixture, including opaque blobs byte-for-byte.
2. Timeouts: with streaming, apply a total deadline (`models.retry.streamTimeoutMs`, default 10 min and at least `timeoutMs`) and an idle timeout between deltas (`models.retry.idleTimeoutMs`, default 60 s) after the first delta; abort cancels the stream.
3. `onProgress({ requestId, outputTokens })` carries counts only (never text) and feeds live run updates (24.5).
4. Enforcement, repair, events, and cassettes operate on the assembled result only; partial output is never recorded. A stream that fails midway is retried like a failed request (retryable errors only).
**Tests to write:** assembled stream equals non-stream fixtures for each adapter (text, tool calls, thinking blocks); idle timeout; abort mid-stream; progress callback receives counts only (canary text absent); failure midway records nothing partial.
**Acceptance Criteria:**

- [ ] Streamed and non-streamed responses record identically.
- [ ] Long generations are bounded by idle timeouts, not total timeouts.
- [ ] Progress reporting carries no content.

---

## 14.17 Prompt caching

**Parent:** #14 Model gateway
**Task Description:** Use provider prompt caching on the stable prefix of each request and account for cached tokens in usage and cost.
**Expected Inputs:** `ModelRequest`, the context result's stable-prefix boundary, pricing config.
**Expected Output:** `cacheReadTokens` and `cacheWriteTokens` (meta ints, optional) on `model_response` and `ModelResponse.usage`, pricing fields `cacheReadMicrosPerMTok` and `cacheWriteMicrosPerMTok`, Anthropic cache breakpoints, `ContextResult.stablePrefixMessages`, cache-aware dropping in the sliding window, span attributes and metrics for cached tokens.
**Dependencies:** none (verify current provider caching parameters and limits).
**Items it depends on:** 14.4, 14.5, 14.14, 15.2.
**Implementation guidance:**

1. Context strategies report `stablePrefixMessages`: the count of leading messages unchanged since the previous build (system prompt, pinned run input, older kept groups). The plan message is pinned at the end, so it does not break the prefix.
2. Anthropic adapter: place `cache_control` breakpoints on the tools block, the system prompt, and the last stable-prefix message, within the provider's breakpoint limit (verify). OpenAI-style providers cache automatically; map their reported cached input tokens.
3. Sliding window: optional `cacheAware: true` drops old groups in chunks (`dropChunkGroups`, default 4) instead of one at a time, so the prefix changes less often. Record the option in the strategy version.
4. Cost: cached reads and writes use their own prices when configured; otherwise fall back to the input price and log `pricing_cache_missing` once.
5. Request hashing for cassettes (14.15) includes the breakpoint placement so replays stay deterministic.
6. Metrics `harness.model.cache_read_tokens` and `harness.model.cache_write_tokens` (attributes `provider`, `model`); span attributes on `harness.model_call`; update `METRIC_ALLOWLIST`, catalog, and collector allowlist.
**Tests to write:** breakpoint placement per request shape; usage mapping from recorded fixtures for both providers; cost arithmetic with cache prices; cache-aware dropping keeps the prefix stable across consecutive builds; schema and catalog updates covered by drift checks.
**Acceptance Criteria:**

- [ ] Cached tokens are reported and priced correctly.
- [ ] Repeated steps in a run reuse the cached prefix (fixture shows cache reads).
- [ ] Caching never changes recorded content.

---

## 14.18 Azure OpenAI adapter

**Parent:** #14 Model gateway
**Task Description:** Support Azure OpenAI deployments with API-key or Microsoft Entra ID authentication.
**Expected Inputs:** Provider config with endpoint, deployment mapping, API version, auth settings.
**Expected Output:** `packages/models/src/providers/azure-openai.ts`, provider kind `azure_openai` in the models config fragment, fixtures and contract test, docs `docs/models/azure-openai.md`.
**Dependencies:** `openai` SDK Azure client or plain `fetch` with the shared mapper, `@azure/identity` (verify current API surface and API versions).
**Items it depends on:** 14.5, 14.6, 12.4.
**Implementation guidance:**

1. Config: `{ kind: "azure_openai", endpoint: https url, apiVersion: string, deployments: Record<model Code, deployment name>, auth: { kind: "api_key", apiKey: SecretRef } | { kind: "entra" } }`. Entra uses `DefaultAzureCredential` with the Cognitive Services scope (verify), cached and refreshed before expiry.
2. Reuse the chat-completions mapper (14.5) with Azure quirks (deployment in the path, `api-version` query parameter).
3. Map Azure content-filter responses to `provider_content_filtered` and throttling to `provider_rate_limited` with `retryAfterMs`.
4. Capabilities default per deployment come from config; do not guess model features from deployment names.
**Tests to write:** contract suite with Azure-shaped fixtures; Entra token acquisition with a fake credential; content-filter mapping; `LIVE` test skipped without credentials.
**Acceptance Criteria:**

- [ ] Azure OpenAI deployments pass the provider contract suite.
- [ ] Both API-key and Entra authentication work.
- [ ] Content filtering maps to a typed error.

---

## 14.19 Amazon Bedrock adapter

**Parent:** #14 Model gateway
**Task Description:** Support models on Amazon Bedrock through the Converse API, including lossless round trip of reasoning content.
**Expected Inputs:** Provider config with region and model ids; AWS credentials from the default provider chain.
**Expected Output:** `packages/models/src/providers/bedrock.ts`, provider kind `bedrock`, fixtures, contract test, docs `docs/models/bedrock.md`.
**Dependencies:** `@aws-sdk/client-bedrock-runtime` (verify the Converse API shapes and reasoning-content fields).
**Items it depends on:** 14.3, 14.7, 14.11.
**Implementation guidance:**

1. Use Converse with the client's retries disabled; credentials from the default chain (never from config literals).
2. Map messages, tool use, and tool results; store raw content blocks (including reasoning content and signatures) as `opaque` parts with provider `bedrock` and re-send them verbatim, per 14.11.
3. Structured output uses the tool rung (forced tool choice) unless the model supports more (configurable capabilities).
4. Map throttling, validation, access-denied, and service errors to the provider taxonomy.
**Tests to write:** contract suite with recorded fixtures; reasoning-content round trip; error mapping; `LIVE` test gated on AWS credentials.
**Acceptance Criteria:**

- [ ] Bedrock models pass the contract suite.
- [ ] Reasoning blocks survive a store round trip byte-for-byte.
- [ ] No AWS credentials appear in config files.

---

## 14.20 Google Vertex AI adapter

**Parent:** #14 Model gateway
**Task Description:** Support Gemini models on Vertex AI with native function calling, schema-constrained output, and round trip of thought signatures.
**Expected Inputs:** Provider config with project, location, and model ids; Application Default Credentials.
**Expected Output:** `packages/models/src/providers/vertex.ts`, provider kind `vertex`, schema-lowering rules for Vertex in `provider-schema-rules.ts`, fixtures, contract test, docs `docs/models/vertex.md`.
**Dependencies:** `@google/genai` (verify package, Vertex mode, and response fields such as thought signatures).
**Items it depends on:** 14.3, 14.7, 14.11.
**Implementation guidance:**

1. Authenticate with Application Default Credentials; disable SDK retries.
2. Map messages and function calls; keep raw parts (including thought signatures) as `opaque` blobs with provider `vertex`.
3. Native structured output uses the provider's response schema with the Vertex lowering rules; record dropped keywords.
4. Map quota, permission, and safety-block responses to the provider taxonomy (`provider_content_filtered` for safety blocks).
**Tests to write:** contract suite with fixtures; schema lowering table; thought-signature round trip; error mapping; `LIVE` test gated on credentials.
**Acceptance Criteria:**

- [ ] Vertex Gemini models pass the contract suite.
- [ ] Structured output works natively with recorded dropped constraints.
- [ ] Provider blobs round-trip losslessly.
