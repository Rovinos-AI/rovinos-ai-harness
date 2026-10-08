# Epic #8: Leak sentinel

**Goal:** a fail-closed last check that no raw value the vault knows about leaves the process through telemetry. Unlike detectors, the sentinel matches **exact known values**, so it has near-perfect recall for those values. Read `docs/engineering/CONVENTIONS.md` first, then epics 4 and 12.
**Tasks:** 8.1 to 8.6, all size S.

Shared design for this epic:

- The sentinel is a **gate**, not a cleaner: on a hit it drops the payload; it never edits content.
- It is deliberately independent of the PII detectors. Its only input is the vault's list of raw values for the relevant runs.
- Scope per payload: spans and logs carry `harness.run.id`, so the sentinel scans against that run's values. Payloads without a run id are scanned against the values of all runs active in this process (plus recently finished ones for a short grace period).
- Fail closed: scan error, timeout, or matcher unavailable all mean **drop**.
- Code location: `packages/telemetry/src/sentinel/`. It depends only on the `VaultReader` interface from `@harness/vault` types re-exported through `@harness/schemas` (the interface file has no implementation dependencies).

---

## 8.1 Run value sets from a read-only vault view

**Parent:** #8 Leak sentinel
**Task Description:** Give the sentinel a cached, versioned, read-only view of each run's raw values, with value-length filtering and a test implementation.
**Expected Inputs:** `VaultReader` (12.1).
**Expected Output:** `VaultReader.version(runId)` added to the interface and implemented in `InMemoryVault` and the SQLite vault; `packages/telemetry/src/sentinel/run-values.ts` (`RunValueSet`, `VaultRunView`), `StaticVaultReader` for tests.
**Dependencies:** none.
**Items it depends on:** 12.1, 12.2.
**Implementation guidance:**

1. Extend `VaultReader` with `version(runId: Id): Promise<number>`; the version increases whenever a new entry is added for that run (use the entry count or a per-run counter column; in SQLite reuse `vault_counters` sum).
2. `VaultRunView(reader, options)`: `valuesFor(runId): Promise<RunValueSet>` caches per run and refreshes when `version` changed since the cached copy. `RunValueSet = { version: number; values: string[]; skippedShort: number }`.
3. Filter values shorter than `minValueLength` (default 6 characters, configurable via `telemetry.sentinel.minValueLength`) because very short values cause unacceptable false positives; count them in `skippedShort` and expose via a counter metric `harness.sentinel.short_values_skipped` (no attributes).
4. Trim and de-duplicate values; do not log them anywhere. `RunValueSet` must override `toJSON`/`inspect` to print only counts.
5. `StaticVaultReader(map)` for tests.
6. Cache eviction: LRU of at most 64 runs; `forgetRun(runId)` for completed runs after the grace period.
**Tests to write:** cache hit when version unchanged; refresh when a new value is added; short-value filtering and counter; de-duplication; LRU eviction; stringifying a `RunValueSet` never prints values (canary); `version` monotonic in both vault implementations.
**Acceptance Criteria:**

- [ ] The sentinel can only read values, never write (interface-level).
- [ ] Newly added vault values are picked up on the next scan.
- [ ] Value sets never print their contents.

---

## 8.2 Aho-Corasick matcher with an empty-vault fast path

**Parent:** #8 Leak sentinel
**Task Description:** Implement an in-house multi-pattern string matcher (no dependency) with early exit and bounded memory.
**Expected Inputs:** Patterns (raw values and their variants), text to scan.
**Expected Output:** `packages/telemetry/src/sentinel/aho-corasick.ts` (`AhoCorasick`), `packages/telemetry/src/sentinel/matcher.ts` (`SentinelMatcher`).
**Dependencies:** none.
**Items it depends on:** 8.1.
**Implementation guidance:**

1. `AhoCorasick.build(patterns: string[]): AhoCorasick`: trie with `Map<number, number>` transitions over UTF-16 code units stored in typed arrays/arrays of node objects; BFS to compute failure links and dictionary (output) links. Reject empty patterns. Enforce `maxTotalPatternChars` (default 1,000,000; throw `sentinel_patterns_too_large`).
2. `hasMatch(text): boolean` exits on the first match; `findAll(text): { patternIndex: number; start: number; end: number }[]` for diagnostics (tests only; production uses `hasMatch` and never returns matched text).
3. `SentinelMatcher.forValues(values, variantFn?)`: builds the automaton; when `values` is empty returns a matcher whose `hasMatch` returns `false` immediately without scanning (fast path).
4. Matching is case-sensitive in this task; variants (lowercase, encodings) arrive in 8.6.
5. Scanning must be linear in text length. Do not use regex for matching.
**Tests to write:** correctness against a naive `text.includes` oracle with `fast-check` (random patterns and texts, 1,000+ cases); overlapping and nested patterns; unicode surrogate pairs; empty vault fast path (spy that no automaton is built); performance guard (10,000 patterns of 12 chars and a 1 MB text complete under 500 ms in CI, generous budget); pattern-size limit.
**Acceptance Criteria:**

- [ ] Matches the naive oracle on random inputs.
- [ ] Linear-time scanning verified by the performance guard.
- [ ] No match text is ever returned in production APIs.

---

## 8.3 Export-pipeline gate: drop on hit, error, or timeout

**Parent:** #8 Leak sentinel
**Task Description:** Insert the sentinel into the span and log processors so no payload leaves without passing it, failing closed.
**Expected Inputs:** Sanitized spans and log records from 4.2/4.3.
**Expected Output:** `packages/telemetry/src/sentinel/gate.ts` (`SentinelGate`), updates to `AllowlistSpanProcessor` and `AllowlistLogRecordProcessor` to call the gate last, `ActiveRuns` registry.
**Dependencies:** none.
**Items it depends on:** 8.2, 4.3.
**Implementation guidance:**

1. `SentinelGate.check({ runId?: Id; text: string }): { ok: true } | { ok: false; reason: "hit" | "error" | "timeout" }`. `text` is a canonical serialization of the payload: span name, all attribute keys and values, link trace ids, resource attributes, joined with `\u0000`.
2. Matcher selection: if `runId` is present use that run's matcher (cached by `RunValueSet.version`); otherwise use the combined matcher of `ActiveRuns` (runs started in this process, registered by the run loop, kept for `graceMs` = 300000 after termination). If the combined set exceeds `maxCombinedValues` (default 100,000), fall back to per-run only and count `sentinel_scope_reduced`.
3. Timeout budget `maxScanMs` (default 5) measured with an injected high-resolution clock; exceeding it or any exception returns `ok: false` with `timeout` or `error`.
4. Processors call the gate after allowlist sanitization; on `ok: false` they drop the payload, increment `harness.telemetry.dropped{reason="leak_sentinel"}`, and enqueue a trip (8.4). They never forward partially sanitized data.
5. Make the gate mandatory: constructing the SDK pipeline (4.4) without a gate throws `sentinel_required` unless `telemetry.sentinel.enabled === false` AND `NODE_ENV !== "production"`.
6. Metrics are not scanned (their attributes are closed enums per CONVENTIONS §5); add a test asserting no metric instrument in the repo uses a non-enum string attribute.
**Tests to write:** hit drops span and log; scan error and timeout drop (inject failing matcher and slow fake clock); run-scoped vs combined matcher selection; mandatory-gate construction error; counters incremented; value set refresh during a run.
**Acceptance Criteria:**

- [ ] A payload containing a known raw value is never exported.
- [ ] Errors and timeouts drop the payload.
- [ ] The SDK cannot be built without the gate in production mode.

---

## 8.4 Metadata-only alert on a trip

**Parent:** #8 Leak sentinel
**Task Description:** When the sentinel drops something, record a metadata-only alert in the run's log without racing the run loop.
**Expected Inputs:** Trip notifications (run id, entity type counts).
**Expected Output:** `TripQueue` in `packages/telemetry/src/sentinel/trips.ts`, new boundary value `telemetry_export` in the `pii_action` schema, `harness.sentinel.trip` logger event, run-loop drain in `packages/core/src/recorder.ts`.
**Dependencies:** none.
**Items it depends on:** 8.3, 2.2, 7.10.
**Implementation guidance:**

1. `TripQueue.enqueue({ runId?: Id, entities: { type: Code; count: number }[] })`: entity types come from the vault entry types of the matched values (the matcher exposes `patternIndex`; the gate maps it to the entity type through `RunValueSet`; never expose the value or token).
2. The run loop calls `recorder.drainTrips()` at each step boundary and appends a `pii_action { boundary: "telemetry_export", action: "blocked", entities }` event for trips belonging to its run. This avoids appending from the telemetry thread and the resulting `seq_conflict`.
3. Add `telemetry_export` to the boundary enum, `classification.ts`, the `SafeEvent` mapping, and update goldens and docs.
4. Always log `leak_sentinel_trip` via the sanctioned logger with `runId` (Id) and an integer `count`.
5. Trips without a run id (global scan) are logged and counted only.
**Tests to write:** trip enqueued on hit; drained into a `pii_action` event by the loop without conflicts (concurrent trip while the loop appends); event contains no values or tokens (canary); global trips are logged only; schema updates covered by existing exhaustiveness tests.
**Acceptance Criteria:**

- [ ] Trips surface as metadata-only events in the run log.
- [ ] No `seq_conflict` is caused by sentinel activity.
- [ ] Alert payloads contain only entity types and counts.

---

## 8.5 Canary suite release gate

**Parent:** #8 Leak sentinel
**Task Description:** Build the end-to-end suite that plants synthetic PII in every input path and asserts no plaintext appears in any observable sink.
**Expected Inputs:** Full runtime assembled with fakes and capturing sinks.
**Expected Output:** `test/canary/canaries.ts`, `test/canary/harness.ts` (`CanaryHarness`), `test/canary/pipeline.canary.test.ts`, `docs/canary-checklist.md`, `gates` stage step `yarn test:canary`, PR template line.
**Dependencies:** none.
**Items it depends on:** 8.4, 13.7, 13.8, 7.9, 2.10.
**Implementation guidance:**

1. `canaries.ts` generates unique values per run from a seed: `email` (`c<hex>@example.test`), `phone`, a Luhn-valid card number, an API-key-shaped string, a person name from a fixed list plus hex suffix. Provide encoded variants (percent-encoded, base64) of each for 8.6.
2. `CanaryHarness` assembles the real pipeline (SQLite event store with AES codec, vault, tokenizer, `PiiToolPort`, allowlist processors with sentinel, logger) with fake model and tools, and captures: exported spans and logs (in-memory exporters), stdout/stderr, CLI outputs for `inspect` and `context`, workspace and offload files, and file bytes of the event-store DB and the vault DB.
3. Scenarios (each plants canaries via a different path): goal input; tool output; model output echoing a raw value; approval payload; tool exception message and stack; log call with a bad field; a registered span with a deliberately buggy attribute (bypassing registry via test hook); offloaded file; snapshot context; cassette recording.
4. Assertions per scenario: zero plaintext (and zero encoded-variant) canary occurrences in every captured sink **except** the in-memory raw handling inside the tool boundary; the vault DB contains **no plaintext** either (encrypted), and `resolve` still returns the raw value (proving the pipeline stored it).
5. Also scan committed fixtures: a test walks `test/**/*.cassette.json` and `**/__fixtures__/**` for canary-like patterns and fails on matches.
6. `docs/canary-checklist.md` states the rule: any new sink, boundary, or log path must add a canary scenario in the same PR; add a checkbox to the PR template.
**Tests to write:** the scenario matrix itself, plus a negative control that deliberately disables the sentinel and a processor and proves the suite fails.
**Acceptance Criteria:**

- [ ] All scenarios show zero plaintext in every sink.
- [ ] The negative control fails the suite.
- [ ] Suite runs in the Azure `gates` stage and blocks release on failure.

---

## 8.6 Encoded and obfuscated variant fuzzing

**Parent:** #8 Leak sentinel
**Task Description:** Extend matching to common encodings and obfuscations and fuzz-test the gate against them.
**Expected Inputs:** Raw values; transform pipeline config.
**Expected Output:** `packages/telemetry/src/sentinel/variants.ts` (`variantsOf`, `normalizeForScan`), fuzz tests, `docs/telemetry/guarantees.md` section "Known gaps".
**Dependencies:** `fast-check`.
**Items it depends on:** 8.2, 8.3.
**Implementation guidance:**

1. Normalize the **scanned text** (`normalizeForScan`): Unicode NFKC, remove zero-width and bidi control characters (`\u200B-\u200F`, `\u202A-\u202E`, `\u2060`, `\uFEFF`), then also produce a second scan string with all whitespace and `-` removed (for digit groupings).
2. `variantsOf(raw)` returns the de-duplicated set: raw (normalized), lowercased, whitespace and dash stripped, digits-only (when the value has at least 7 digits), percent-encoded (`encodeURIComponent`), `base64` and `base64url` of the UTF-8 bytes **at all three byte alignments** (use the standard trimmed forms of base64 of `raw` with 0, 1, and 2 leading bytes of padding text so embedding at any offset still matches; document the technique), hex of UTF-8 bytes (lowercase and uppercase), and HTML numeric-entity encoding of non-alphanumerics.
3. Variants multiply patterns (about 12 per value); enforce the pattern-size limit and drop variants shorter than `minValueLength` after transformation.
4. The gate scans both normalized scan strings against the automaton.
5. Document known gaps explicitly: arbitrary encryption, compression, steganography, translations, and values split across multiple attributes are not detected.
**Tests to write:** table tests per transform (value embedded in surrounding text is detected); fuzz with `fast-check`: random PII-like values, random transform chains drawn from the supported list, random prefixes/suffixes, detection rate 100 percent; negative test for unsupported transforms asserting they are **not** claimed (guards documentation honesty); performance guard with variants enabled.
**Acceptance Criteria:**

- [ ] Every supported transform detected in 100 percent of fuzz cases.
- [ ] Known gaps documented in `guarantees.md`.
- [ ] Performance budget still met with variants.
