# Epic #4: Span allowlist (registry and processor)

**Goal:** make it impossible to export an attribute nobody registered. Telemetry attributes can only be Ids, Codes, enums, integers, booleans or finite numbers, and anything else is dropped before it leaves the process. Read `docs/engineering/CONVENTIONS.md` first (especially §5).
**Tasks:** 4.1 to 4.7, all size S.

Shared design for this epic:

- **Version-agnostic safety marker.** Attribute schemas must be created with helpers from `packages/telemetry/src/attr.ts` (`attr.id()`, `attr.code()`, `attr.hash()`, `attr.enum([...])`, `attr.int()`, `attr.num()`, `attr.bool()`, `attr.optional(s)`). Each helper registers the returned Zod schema in a module-level `WeakMap<object, AttrMeta>` (`{ kind, values?, pattern? }`). `defineSpan` accepts only schemas present in that map. This avoids inspecting Zod internals, which differ between Zod majors.
- **Drop, never mutate-in-place.** Processors build a new sanitized copy; unregistered or invalid data is counted (bounded reason enum) and discarded, never exported.
- Spans from auto-instrumentation have unregistered names and are therefore dropped wholesale.

---

## 4.1 `defineSpan` registry API with Zod attribute schemas

**Parent:** #4 Span allowlist
**Task Description:** Create the closed span registry: the only API for starting spans, with schemas that restrict attribute types.
**Expected Inputs:** Span name and an attribute shape built from `attr.*` helpers.
**Expected Output:** `packages/telemetry/src/{attr.ts,registry.ts,tracer.ts,index.ts}`, package scaffold `packages/telemetry`.
**Dependencies:** `@opentelemetry/api`, `zod`.
**Items it depends on:** 1.1, 7.1.
**Implementation guidance:**

1. `attr.ts`: implement the helpers above. `attr.id()` uses `Id` from `@harness/schemas`; `attr.code()` uses `Code`; `attr.hash()` uses `Sha256Hex`; `attr.enum(values)` uses `z.enum`; `attr.int()` is `z.number().int()`; `attr.num()` is finite number; `attr.bool()`. Export `getAttrMeta(schema)` and `isSafeAttr(schema)`.
2. `registry.ts`:

   ```ts
   export interface SpanDefinition<S extends Record<string, ZodTypeAny>> {
     readonly name: Code; readonly shape: S; readonly schema: ZodObject<S>;
     start(attrs: z.infer<ZodObject<S>>, opts?: { parent?: Context; links?: Link[] }): Span;
   }
   export function defineSpan<S>(name: string, shape: S): SpanDefinition<S>;
   export function listSpanDefinitions(): readonly SpanDefinition<any>[];
   export function lookupSpanDefinition(name: string): SpanDefinition<any> | undefined;
   ```

3. `defineSpan` throws `span_name_invalid` unless `name` matches `^harness\.[a-z0-9_.]{1,60}$` (the `mcp.*`/`gen_ai.*` span names are registered through an explicit `defineSemconvSpan` exception added in 4.7), throws `span_attr_unconstrained` if any shape member is not a safe attr, throws `span_duplicate` if the name exists. The schema is `z.object(shape).strict()`.
4. `start(attrs)` parses attrs with the schema (throws `span_attr_invalid` with issue paths only), then `getTracer().startSpan(name, { attributes, links })`. `getTracer()` uses `trace.getTracer("@harness/telemetry")`.
5. Provide `withSpan(def, attrs, fn)` that ends the span in `finally`, sets status `ERROR` with no message on throw, and sets attribute `harness.error.code` only if the thrown error is a `HarnessError` and the definition declares that attribute (it is declared as optional on every span by `defineSpan` automatically: add `harness.error.code: attr.optional(attr.code())`).
6. Export a `__resetRegistryForTests()` available only under `process.env.NODE_ENV === "test"`.
**Tests to write:** definitions with safe attrs succeed; raw `z.string()` rejected; duplicate and invalid names rejected; `start` with extra key or invalid value throws; `withSpan` ends span on throw and never records the error message (use `InMemorySpanExporter`); `listSpanDefinitions` returns definitions in registration order.
**Acceptance Criteria:**

- [ ] A span cannot be defined with an unconstrained string attribute.
- [ ] Starting a span with an invalid attribute throws before anything is created.
- [ ] Error messages never reach spans.

---

## 4.2 Allowlist `SpanProcessor`

**Parent:** #4 Span allowlist
**Task Description:** Add a processor that sanitizes every finished span against the registry before passing it to the exporter pipeline.
**Expected Inputs:** `ReadableSpan` objects from the SDK.
**Expected Output:** `packages/telemetry/src/processors/allowlist-span-processor.ts` (`AllowlistSpanProcessor`), `sanitizeSpan()`, drop counters in `packages/telemetry/src/metrics.ts`.
**Dependencies:** `@opentelemetry/sdk-trace-base`, `@opentelemetry/api` (metrics).
**Items it depends on:** 4.1.
**Implementation guidance:**

1. `class AllowlistSpanProcessor implements SpanProcessor` constructed with a `next: SpanProcessor` (for example `BatchSpanProcessor`). `onStart` delegates; `onEnd(span)` calls `sanitizeSpan(span)`; if it returns `undefined`, call nothing (dropped), else `next.onEnd(sanitized)`. `forceFlush`/`shutdown` delegate.
2. `sanitizeSpan(span)`: look up `lookupSpanDefinition(span.name)`; if absent, drop the span and count `unregistered_span`. Otherwise build a new object satisfying the SDK's `ReadableSpan` interface (inspect the installed version's fields: `name, kind, spanContext(), parentSpanContext/parentSpanId, startTime, endTime, status, attributes, links, events, duration, ended, resource, instrumentationScope, droppedAttributesCount, droppedEventsCount, droppedLinksCount`) with:
   - `attributes`: only keys present in the definition shape whose values pass `schema.shape[key].safeParse`; each rejected key counts `unregistered_attr` or `invalid_attr`.
   - `events`: always `[]` (this strips `exception` events); count `event_stripped` when any existed.
   - `status`: keep `code` only; set `message` to `undefined`.
   - `links`: keep `context`, drop link attributes.
   - `resource`: rebuild with only allowlisted keys: `service.name`, `service.version`, `harness.policy.version`, `telemetry.sdk.name`, `telemetry.sdk.language`, `telemetry.sdk.version`.
3. `metrics.ts` creates counter `harness.telemetry.dropped` with the single attribute `reason` (enum `unregistered_span | unregistered_attr | invalid_attr | event_stripped | leak_sentinel | processor_error`). Counter attributes are the only attributes on this metric.
4. Any exception inside the processor drops the span and counts `processor_error`; the processor never throws into the SDK.
**Tests to write:** registered span passes with only allowed attrs; unregistered span dropped; extra attribute dropped and counted; invalid value dropped; exception event stripped; status message removed; resource filtered; processor never throws on malformed input (fuzz with weird `ReadableSpan` stubs); output object satisfies `ReadableSpan` shape (type-level test).
**Acceptance Criteria:**

- [ ] The exporter never receives an attribute outside the registry.
- [ ] Events and status messages never reach the exporter.
- [ ] Drops are counted with a bounded reason set.

---

## 4.3 Log-record equivalent of the processor

**Parent:** #4 Span allowlist
**Task Description:** Apply the same closed-registry approach to OTel log records, and emit `SafeEvent`s as log records.
**Expected Inputs:** `SafeEvent` objects (7.10), `LogRecord`s from the logs SDK.
**Expected Output:** `packages/telemetry/src/log-registry.ts` (`defineLogRecord`), `packages/telemetry/src/processors/allowlist-log-processor.ts`, `emitSafeEvent(logger, safeEvent)`.
**Dependencies:** `@opentelemetry/api-logs`, `@opentelemetry/sdk-logs`.
**Items it depends on:** 4.2, 7.10.
**Implementation guidance:**

1. `defineLogRecord(name, shape)` mirrors `defineSpan` (same safe-attr rule, name pattern `^harness\.[a-z0-9_.]{1,60}$`).
2. Define one log record definition per `SafeEvent` kind (`harness.safe.model_call`, `harness.safe.tool_call`, etc.), whose attributes are the safe event fields (map field names to `harness.*` attribute names in one table kept next to the definitions).
3. `emitSafeEvent(logger, e)` sets `body` to the event kind (a Code), `severityNumber` INFO, attributes from the table, plus `trace_id`/`span_id` from the event so logs correlate with traces.
4. `AllowlistLogRecordProcessor implements LogRecordProcessor`: `onEmit(record)` replaces `body` with the registered name, filters attributes exactly like 4.2, drops unregistered records, counts via `harness.telemetry.dropped`. Never forward original body text.
5. Both processors share the sanitizing core (`sanitizeAttributes(def, attrs)`), extracted in this task from 4.2.
**Tests to write:** each safe kind emits the expected attribute set; free-text body replaced; unregistered record dropped; correlation ids present; shared sanitizer unit tests.
**Acceptance Criteria:**

- [ ] No log body text can reach an exporter.
- [ ] Every `SafeEvent` kind has a registered log definition.
- [ ] Spans and logs share one sanitizing implementation.

---

## 4.4 Strip auto-instrumentation leaks

**Parent:** #4 Span allowlist
**Task Description:** Configure the SDK so auto-instrumentation and exception recording cannot leak URLs, messages, stack traces, or GenAI content.
**Expected Inputs:** SDK construction options.
**Expected Output:** `packages/telemetry/src/sdk.ts` (`createTelemetrySdk(opts)`), `safeRecordError(span, code)`, leak fixture test.
**Dependencies:** `@opentelemetry/sdk-node` or the individual SDK packages (verify the lightest sufficient set), `@opentelemetry/sdk-metrics`.
**Items it depends on:** 4.2, 4.3.
**Implementation guidance:**

1. `createTelemetrySdk` builds a `NodeTracerProvider` with the `AllowlistSpanProcessor` wrapping the batch processor and a `LoggerProvider` with the log allowlist processor. No default instrumentations are enabled; explicitly document that HTTP/undici instrumentation, if added later, produces unregistered spans that are dropped.
2. Set `process.env.OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT = "false"` (verify variable name in the pinned conventions) before SDK start if unset, and fail startup (`telemetry_content_capture_enabled`) if it is set to `true`.
3. `safeRecordError(span, error)`: sets status `ERROR` with no message and sets `harness.error.code` from `HarnessError.code` or `unknown_error`. Never call `span.recordException`.
4. A deny-list of attribute keys for defense in depth, applied in the processors before the allowlist check and counted separately in tests only: `exception.message`, `exception.stacktrace`, `http.url`, `url.full`, `url.query`, `http.target`, `db.statement`, any key starting `gen_ai.prompt`, `gen_ai.completion`, `gen_ai.input`, `gen_ai.output`, `gen_ai.system_instructions`.
5. Resource detection is disabled except for the allowlisted keys (no hostname, no process command line, no environment variables).
**Tests to write:** `leak-fixture.test.ts`: create registered and unregistered spans carrying canary strings in URL query, exception message, stack, status message, and `gen_ai.prompt`; run through the full processor chain into `InMemorySpanExporter`; assert no canary appears anywhere in the serialized export; startup fails when content capture env is `true`; resource contains only allowlisted keys.
**Acceptance Criteria:**

- [ ] The leak fixture finds zero canaries in exported data.
- [ ] Enabling content capture aborts startup.
- [ ] `recordException` is never used by library code.

---

## 4.5 ESLint rule banning raw tracer use

**Parent:** #4 Span allowlist
**Task Description:** Add a custom lint rule that forbids creating spans or recording exceptions outside the registry module.
**Expected Inputs:** Source files.
**Expected Output:** `tools/eslint-plugin-harness/src/rules/no-raw-tracer.ts`, config wiring, rule docs.
**Dependencies:** `eslint` RuleTester (`@typescript-eslint/rule-tester`).
**Items it depends on:** 1.2, 4.1.
**Implementation guidance:**

1. Rule `harness/no-raw-tracer` reports: member calls named `startSpan`, `startActiveSpan`, `recordException`, `updateName`; imports of `@opentelemetry/sdk-*` and of `trace.getTracer` outside allowed files; `span.setAttribute(s)` calls outside allowed files (attributes must come from the registry's `start`).
2. Option `allowedFiles: string[]` globs; default allows `packages/telemetry/src/registry.ts`, `packages/telemetry/src/log-registry.ts`, `packages/telemetry/src/tracer.ts`, `packages/telemetry/src/sdk.ts`, and `**/*.test.ts`.
3. Report message must tell the developer the correct API (`defineSpan(...).start(...)` / `withSpan`).
4. Enable the rule as `error` in the root config for all packages.
**Tests to write:** `RuleTester` valid cases (calls inside allowed files, `withSpan` use, reading `trace.getActiveSpan()`) and invalid cases (each banned call, banned imports) with message assertions.
**Acceptance Criteria:**

- [ ] Banned constructs are rejected in every package except allowed files.
- [ ] The repo lints clean with the rule enabled.
- [ ] Error messages explain the fix.

---

## 4.6 CI schema lint and random-string property test

**Parent:** #4 Span allowlist
**Task Description:** Add automated guarantees that no registry or `SafeEvent` schema can carry free text, and that the processors drop random strings.
**Expected Inputs:** Registered spans, log records, `SafeEvent` schemas.
**Expected Output:** `packages/telemetry/src/registry.lint.test.ts`, `yarn lint:telemetry` script in the `static` stage, refactor of `safe-event.ts` (7.10) to build field schemas with `attr.*` helpers.
**Dependencies:** `fast-check`.
**Items it depends on:** 4.2, 4.3, 7.10.
**Implementation guidance:**

1. Lint test: iterate `listSpanDefinitions()`, `listLogDefinitions()`, and every `SafeEvent` schema field; assert `isSafeAttr(field)`. Fail with the span or kind name and field name.
2. Refactor `safe-event.ts` so each field is created via `attr.*` (this makes the check uniform); keep the 7.10 tests green.
3. Property test with `fast-check`: for each registered span definition, generate arbitrary strings (including unicode, long strings, emails, JWT-like strings) and assign them to every attribute key via a raw `ReadableSpan` stub; run `sanitizeSpan`; assert surviving string attributes always satisfy their attr pattern or enum membership. Same for log records.
4. Add `yarn lint:telemetry` running this test file alone; wire into the `static` stage so it fails fast.
**Tests to write:** The lint and property tests above, plus a negative control that registers a deliberately unsafe definition via an internal test hook and asserts the lint fails.
**Acceptance Criteria:**

- [ ] Introducing `z.string()` into a safe-event schema fails CI.
- [ ] Property test runs at least 500 cases per definition.
- [ ] The negative control proves the lint can fail.

---

## 4.7 Pin semantic-convention versions and generate the attribute catalog

**Parent:** #4 Span allowlist
**Task Description:** Pin the OpenTelemetry semantic-convention versions the project relies on and generate a documentation catalog of every allowed attribute, kept in sync by CI.
**Expected Inputs:** Registry contents.
**Expected Output:** `packages/telemetry/src/semconv.ts`, `scripts/gen-attribute-catalog.ts`, `docs/telemetry/attribute-catalog.md`, `yarn docs:catalog` and `docs:catalog --check`.
**Dependencies:** `@opentelemetry/semantic-conventions` (exact version, verify).
**Items it depends on:** 4.1, 4.6.
**Implementation guidance:**

1. `semconv.ts`: export `SEMCONV_VERSION` (the pinned package version string) and typed constants only for attributes we actually emit (for example `MCP_METHOD_NAME = "mcp.method.name"`; confirm names against the pinned version). Note in a comment that the MCP and GenAI conventions are in development and may change; any bump is a deliberate PR.
2. Add `defineSemconvSpan(name, shape)` to the registry for the few spans that must use semconv names (for example MCP client call spans in 6.x). It enforces the name appears in an explicit `SEMCONV_SPAN_NAMES` allowlist.
3. Pin `OTEL_SEMCONV_STABILITY_OPT_IN` explicitly in the SDK bootstrap (document the chosen value).
4. `gen-attribute-catalog.ts` imports all registering modules, reads `listSpanDefinitions()`/log definitions and `getAttrMeta`, and writes a markdown table per span: attribute, type (id/code/enum values/int/bool), required or optional, owning package (derived from a `ownerTask` field passed to `defineSpan` as an optional third argument; make it required in this task and update existing definitions).
5. `--check` regenerates in memory and fails with a diff hint if `docs/telemetry/attribute-catalog.md` differs.
**Tests to write:** snapshot test of the generated catalog for a fixture registry; `--check` fails on drift and passes when current; `SEMCONV_VERSION` equals the version in `package.json` (guards drift).
**Acceptance Criteria:**

- [ ] Catalog committed and CI fails when it is stale.
- [ ] Semconv version pinned and asserted by a test.
- [ ] Every span definition declares an owner task.
