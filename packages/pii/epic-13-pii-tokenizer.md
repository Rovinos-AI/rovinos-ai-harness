# Epic #13: PII tokenizer

**Goal:** detect sensitive values and replace them with run-scoped tokens at every trust boundary (model input, tool input, tool output, storage), with policy-driven behavior per destination and careful, audited detokenization. Read `docs/engineering/CONVENTIONS.md` first, and epic 12 (the vault) for the token format.
**Tasks:** 13.1 to 13.11, all size S.

Shared design for this epic:

- **Boundaries** (`model_input`, `tool_input`, `tool_output`, `storage`, `ui`) and **destinations** (`hosted`, `local`, or `{ tool: Code }`) determine the action for a detected entity: `tokenize`, `redact`, `block`, `allow`.
- **Fail closed.** If a detector or the vault fails, the operation fails; raw text is never passed through "just in case".
- **Detection is imperfect.** Detectors reduce risk; the structural guarantees come from the telemetry closed schemas (epic 4) and the leak sentinel (epic 8). Never claim 100 percent detection in docs.
- Package `packages/pii` depends on `schemas`, `telemetry`, `vault` only.
- Pipeline order for a tool call (implemented across 13.5 to 13.7, 15.4, 17.3): model args -> detect and tokenize (`tool_input`) -> policy decision on tokenized args -> detokenize allowlisted args -> execute -> tokenize result (`tool_output`) -> offload large outputs -> record events (storage boundary as a final safety net).

---

## 13.1 Entity taxonomy and Zod policy schema

**Parent:** #13 PII tokenizer
**Task Description:** Define the entity types, policy schema, and a pure policy evaluator.
**Expected Inputs:** Policy config, `(entity, boundary, destination)` triples.
**Expected Output:** `packages/schemas/src/pii-policy.ts`, `packages/schemas/src/config/pii.ts` (config fragment), `packages/pii/src/policy.ts` (`evaluatePiiPolicy`, `explainPiiPolicy`), package scaffold `packages/pii`.
**Dependencies:** none.
**Items it depends on:** 7.1.
**Implementation guidance:**

1. Entity Codes (initial set): `email`, `phone`, `credit_card`, `iban`, `national_id`, `ip_address`, `person_name`, `location`, `api_key`, `url_credentials`, `custom_<name>` (custom names must match `^custom_[a-z0-9_]{1,40}$`).
2. `Destination = "hosted" | "local" | { tool: Code } | "any"`. `PiiAction = "tokenize" | "redact" | "block" | "allow"`.
3. `PiiPolicy = { defaultAction: PiiAction (default "tokenize"), rules: Rule[] }`, `Rule = { entities: Code[] | "*", boundaries: Boundary[] | "*", destinations: Destination[] | "*", action: PiiAction }`.
4. `evaluatePiiPolicy(policy, { entity, boundary, destination })`: first matching rule wins, else `defaultAction`. Pure.
5. Validation rules (Zod `superRefine`): `allow` is forbidden for `boundary: "storage"` (always tokenize at rest) with error code `pii_policy_storage_allow`; `allow` for `api_key` and `credit_card` requires an explicit tool destination (never `hosted`/`any`); a rule with `entities: "*"` and `action: "allow"` is rejected.
6. `explainPiiPolicy(...)` returns `{ action, ruleIndex | "default" }` for the CLI in 13.9.
**Tests to write:** table-driven evaluation (precedence, wildcard, default); each validation rejection; explain output; schema round-trip with a sample config in `examples/pii-policy.yaml`.
**Acceptance Criteria:**

- [ ] Policy evaluation is pure and deterministic.
- [ ] Unsafe policies (allow at storage, allow secrets to hosted) rejected at load.
- [ ] Example policy committed and tested.

---

## 13.2 Regex detectors with validators

**Parent:** #13 PII tokenizer
**Task Description:** Implement built-in detectors for structured identifiers, with checksum validation to reduce false positives.
**Expected Inputs:** Text strings.
**Expected Output:** `packages/pii/src/detectors/{types.ts,email.ts,phone.ts,credit-card.ts,iban.ts,ip.ts,secrets.ts,custom.ts,index.ts}`, `resolveOverlaps`.
**Dependencies:** none.
**Items it depends on:** 13.1.
**Implementation guidance:**

1. `interface Detector { id: Code; entityTypes: Code[]; detect(text: string): Detection[] }`, `Detection = { entityType: Code; start: number; end: number; confidence: number; detectorId: Code }` (UTF-16 offsets, `end` exclusive).
2. Detectors: email (simplified RFC 5322 local part and domain with at least one dot; bounded quantifiers), phone (E.164 and common separated formats; require 7 to 15 digits), credit card (13 to 19 digits allowing spaces or dashes, must pass Luhn), IBAN (country-length table plus mod-97), IP (IPv4 octet range check; IPv6 via `node:net` `isIPv6`), secrets (`AKIA[0-9A-Z]{16}`, `ghp_[A-Za-z0-9]{36}`, JWT three base64url segments, `-----BEGIN ... PRIVATE KEY-----`), `url_credentials` (`scheme://user:pass@host`).
3. `custom`: from config `pii.custom: { name, pattern, flags?, validator?: "luhn"|"mod97" }[]`; compile once; reject patterns that fail a ReDoS screen (nested quantifiers) with `pii_pattern_unsafe`.
4. `resolveOverlaps(detections)`: sort by `start`; when ranges overlap keep the longer, then higher confidence, then lower detector id order. Output is non-overlapping and sorted.
5. **Linear-time guarantee:** every built-in regex must avoid catastrophic backtracking; add a test running each detector over 1 MB pathological strings with a time budget.
6. Ship no country-specific national-ID patterns; document how to add them as custom entries.
**Tests to write:** positive and negative table per detector (valid Luhn card detected, 16 random digits not detected, valid and invalid IBAN, IPv4 `999.1.1.1` rejected); overlap resolution cases; unicode and surrogate-pair offsets; pathological-input timing test; custom pattern unsafe rejection.
**Acceptance Criteria:**

- [ ] Checksum validators eliminate listed false positives.
- [ ] Detector run time stays within budget on pathological input.
- [ ] Offsets map back to the exact original substring.

---

## 13.3 Detector plugin interface and Presidio sidecar adapter

**Parent:** #13 PII tokenizer
**Task Description:** Allow additional detectors, including a Presidio analyzer sidecar for names and locations, with explicit failure behavior.
**Expected Inputs:** Presidio base URL, language, score threshold.
**Expected Output:** `packages/pii/src/detectors/registry.ts`, `packages/pii/src/detectors/presidio.ts`, `presidio-analyzer` compose service, doctor check.
**Dependencies:** Docker image `mcr.microsoft.com/presidio-analyzer` (verify tag and port), `undici`.
**Items it depends on:** 13.2, 1.8, 20.4.
**Implementation guidance:**

1. `DetectorRegistry` composes detectors, runs them (regex ones synchronously, async ones concurrently), merges and resolves overlaps.
2. `PresidioDetector`: `POST {baseUrl}/analyze` with `{ text, language, score_threshold }` (verify request shape); map entity names: `PERSON` -> `person_name`, `EMAIL_ADDRESS` -> `email`, `PHONE_NUMBER` -> `phone`, `CREDIT_CARD` -> `credit_card`, `IBAN_CODE` -> `iban`, `IP_ADDRESS` -> `ip_address`, `LOCATION` -> `location`, `US_SSN` -> `national_id`, others ignored. Confidence = Presidio score.
3. Timeout default 2000 ms; simple circuit breaker (open after 5 consecutive failures for 30 s, using injected clock).
4. Config `pii.failMode: "closed" | "regex_only"` (default `closed`): `closed` throws `pii_detector_unavailable`; `regex_only` continues with regex detectors and increments a counter (`harness.telemetry.dropped` is not reused; add a separate counter `harness.pii.detector_degraded` with no attributes).
5. Send only the text, no run ids or metadata. The sidecar must be reachable only on the internal compose network (no published port in prod profiles).
6. Register a `presidio_reachable` doctor check (20.4).
**Tests to write:** mocked HTTP: mapping, threshold, timeout, breaker open/half-open with fake clock, both fail modes; integration test (`*.int.test.ts`) against the compose service detecting a synthetic name; doctor check.
**Acceptance Criteria:**

- [ ] `closed` mode never passes text through when Presidio is down.
- [ ] Integration test passes in the Azure integration stage.
- [ ] Sidecar port is not published outside the compose network.

---

## 13.4 Tokenize text and JSON idempotently using the vault

**Parent:** #13 PII tokenizer
**Task Description:** Core tokenizer: detect, apply policy, and replace values with tokens, for strings and arbitrary JSON.
**Expected Inputs:** `runId`, text or `JsonValue`, `{ boundary, destination }`, detector registry, policy, vault writer.
**Expected Output:** `packages/pii/src/tokenizer.ts` (`Tokenizer`), `PiiBlockedError` (`pii_blocked`), `PiiActionSummary`.
**Dependencies:** none.
**Items it depends on:** 13.1, 13.2, 12.1.
**Implementation guidance:**

1. `tokenizeText(runId, text, ctx): Promise<{ text: string; actions: PiiActionSummary[] }>`: detect, then for each detection evaluate the policy. `tokenize` -> `vault.put(runId, entityType, raw)` token; `redact` -> `[REDACTED:<entityType>]` (no vault entry); `allow` -> unchanged; `block` -> collect and throw `PiiBlockedError` after evaluating all detections (error carries only counts per entity type).
2. Apply replacements from the end of the string to the start so offsets stay valid.
3. Leave existing tokens (matching the token pattern) untouched; do not re-detect inside them.
4. `tokenizeJson(runId, value, ctx)`: recursively process string **values** (not object keys), preserving structure, with depth limit 64 (`pii_depth_exceeded`) and a total size limit (default 2 MiB, `pii_input_too_large`).
5. `PiiActionSummary = { boundary, action, entities: { type: Code; count: number }[] }`, aggregated per call, for the caller to record as a `pii_action` event (the tokenizer itself does not write events).
6. Idempotence: tokenizing already-tokenized output yields identical output and no actions.
**Tests to write:** each action; block aggregates all detections before throwing; same value gets the same token across calls in one run and different runs differ; replacement offsets with adjacent and multiple entities; JSON structure preserved; keys untouched; idempotence; limits; errors contain no raw values.
**Acceptance Criteria:**

- [ ] Output of `tokenize*` never contains a value that policy says must be tokenized.
- [ ] Idempotent on already-tokenized input.
- [ ] Errors and summaries contain no raw values.

---

## 13.5 Detokenize at the tool boundary with a per-tool, per-argument allowlist

**Parent:** #13 PII tokenizer
**Task Description:** Safely restore raw values into specific tool arguments only, with auditing and fail-closed behavior.
**Expected Inputs:** Tokenized args, tool id, allowlist config, vault resolver.
**Expected Output:** `packages/pii/src/detokenize.ts` (`detokenizeArgs`), config schema `pii.detokenize: { toolId: Code; args: JsonPointer[]; onUnresolvable?: "fail" | "leave" }[]`.
**Dependencies:** none.
**Items it depends on:** 13.1, 12.7.
**Implementation guidance:**

1. `JsonPointer` validated by RFC 6901 syntax (`/to`, `/attachments/0/name`). Wildcard `*` segments are allowed for array indexes only (`/recipients/*`).
2. `detokenizeArgs(runId, toolId, args, config, resolver): Promise<{ args: JsonValue; resolvedCount: number }>`: locate the allowlist entry for `toolId` (none -> return args unchanged); for each allowed pointer that points to a string, replace tokens (`findTokens`) with raw values via `resolver.resolveMany` (audited as boundary `tool_input`, 12.7). Strings elsewhere are untouched even if they contain tokens.
3. Unresolvable token (unknown or purged): default `fail` throws `pii_token_unresolvable` (the tool call becomes an `error` result); `leave` keeps the token text.
4. The returned structure is a deep copy; it exists only in memory for `execute` and is never recorded (the recorded `tool_intent.args` keep tokens).
5. Never log the returned args.
**Tests to write:** allowlisted pointer replaced; non-allowlisted pointer with token left as token; wildcard arrays; missing tool entry; unresolvable with both modes; audit called with counts only; returned copy does not mutate the input; pointer syntax validation.
**Acceptance Criteria:**

- [ ] Only allowlisted pointers are ever detokenized.
- [ ] Unresolvable tokens fail closed by default.
- [ ] Every detokenization is audited.

---

## 13.6 Model-input boundary integration

**Parent:** #13 PII tokenizer
**Task Description:** Apply policy to messages before they reach a provider, per the provider's trust level, including the fallback case.
**Expected Inputs:** A provider request (messages, tool descriptions and schemas, output schema), routed provider (`trust`), detector registry, policy.
**Expected Output:** `packages/pii/src/model-sanitizer.ts` (`PiiMessageSanitizer`), a request-sanitizer hook in the gateway (`packages/models/src/gateway.ts`) invoked once per provider attempt, wiring in `createRuntime`.
**Dependencies:** none.
**Items it depends on:** 13.4, 13.5, 14.13.
**Implementation guidance:**

1. Gateway hook: sanitize the full request for **each** provider attempt (including fallbacks) after `prepareMessagesForProvider` (14.11), using the selected provider's trust.
2. `PiiMessageSanitizer`: apply `tokenize*` with `boundary: "model_input"` to message text, tool-call arguments/results, tool descriptions and JSON schemas. For `local` destinations whose policy action is `allow`, detokenize allowed tokens (audited, boundary `model_input`), re-check expanded values, then pass raw values; for `hosted`, tokens stay tokens.
3. `opaque` parts are provider blobs produced by the model; they are passed through unchanged but scanned in tests for canaries (a model should never contain raw PII it was never given; if scanning finds some, count `harness.pii.blob_hit` and fail closed with `pii_blob_contains_pii`).
4. `PiiBlockedError` aborts the model call and surfaces as a failed step with code `pii_blocked`.
5. Emit `pii_action` summaries through a callback that the run loop records.
**Tests to write:** hosted target sees only tokens (canary absent from the request captured by `FakeProvider`); local target with `allow` gets raw values; fallback from local to hosted re-sanitizes; blocked entity aborts; opaque blob scanning; summaries emitted.
**Acceptance Criteria:**

- [ ] No canary reaches a hosted fake provider in any scenario.
- [ ] Fallback to a less-trusted provider re-applies policy.
- [ ] `pii_action` summaries are recorded.

---

## 13.7 Tool-input and tool-output boundary integration

**Parent:** #13 PII tokenizer
**Task Description:** Compose the full tool pipeline as a `ToolPort` decorator.
**Expected Inputs:** Tool calls from the model, inner `ToolPort`, detokenize config.
**Expected Output:** `packages/pii/src/pii-tool-port.ts` (`PiiToolPort`), integration with the run loop ordering contract.
**Dependencies:** none.
**Items it depends on:** 13.4, 13.5, 2.4, 15.4.
**Implementation guidance:**

1. `PiiToolPort(inner, deps)` implements `ToolPort`. `prepare(call)` (new optional step used by the loop before recording `tool_intent`): `tokenizeJson(args, { boundary: "tool_input", destination: { tool: toolId } })`, producing the tokenized args to record; `PiiBlockedError` yields a denied result with `errorCode: "pii_blocked"` and no execution.
2. `execute(call)`: receives the tokenized args, runs `detokenizeArgs`, calls `inner.execute` with the raw copy, then `tokenizeJson(result, { boundary: "tool_output", destination: { tool: toolId } })` and returns the tokenized result. Exceptions from `inner` are mapped to `errorCode` only.
3. Ordering relative to offloading (15.4): the offloading decorator wraps **outside** `PiiToolPort`, so offloaded files and previews contain tokens only. Document the decorator order in `createRuntime`: `Offloading( Pii( Policy( Tools ) ) )` (policy decorator arrives in 17.3).
4. Record `pii_action` summaries for input and output boundaries.
5. Large outputs: respect the tokenizer size limit; over-limit outputs are offloaded **without** tokenization only if they are binary (flag from the tool); text outputs over the limit fail with `pii_input_too_large`.
**Tests to write:** full pipeline test with a fake tool: raw email in model args becomes a token in the recorded intent, tool receives the raw value only at an allowlisted pointer, tool output with a raw card number is tokenized before it returns; blocked entity prevents execution; summaries recorded for both boundaries; canary absent from every recorded event.
**Acceptance Criteria:**

- [ ] Recorded events contain tokens only.
- [ ] Tools see raw values only through the allowlist.
- [ ] Output tokenization happens before offloading and recording.

---

## 13.8 Storage boundary: tokenize event content before write

**Parent:** #13 PII tokenizer
**Task Description:** Add a defense-in-depth decorator so nothing sensitive is ever persisted, even if an upstream step forgot to tokenize.
**Expected Inputs:** Events with content fields, classification map.
**Expected Output:** `packages/pii/src/pii-event-store.ts` (`PiiEventStore` decorator), `markSanitized(event)` helper.
**Dependencies:** none.
**Items it depends on:** 13.4, 7.1, 7.2.
**Implementation guidance:**

1. `PiiEventStore(inner, tokenizer, onSummary)` implements `EventStore`. In `append`/`appendWithSnapshot`, for each event use `splitEvent` (7.1) and run `tokenizeJson` over **content** fields only with `boundary: "storage"`, destination `"any"` (policy forbids `allow` at storage).
2. Skip scanning for events or fields already marked sanitized (`markSanitized` stores references in a `WeakSet`), so the common path is cheap; unmarked content is always scanned.
3. Fail closed: any tokenizer or vault error rejects the append with `pii_storage_failed`; nothing is written.
4. If scanning changes content, emit a `pii_action` summary via `onSummary` (the run loop appends it as a normal event; `pii_action` has no content fields, so it is not rescanned).
5. Snapshots (`context`, `plan`) are scanned the same way.
6. Reads pass through unchanged.
**Tests to write:** unsanitized event with a raw email is stored tokenized; sanitized-marked event skips scanning (spy counts detector calls); tokenizer failure rejects append and leaves store unchanged; snapshot content scanned; `pii_action` not rescanned; conformance suite still passes through the decorator.
**Acceptance Criteria:**

- [ ] DB file grep for planted canaries finds nothing, even when upstream tokenization is bypassed in a test.
- [ ] Failures reject the write.
- [ ] Overhead is limited to unsanitized content.

---

## 13.9 Per-destination trust resolution and `harness pii explain`

**Parent:** #13 PII tokenizer
**Task Description:** Resolve destinations for each boundary from config and expose the policy matrix to developers.
**Expected Inputs:** Provider `trust` (14.6), tool metadata, policy.
**Expected Output:** `packages/pii/src/destination.ts` (`resolveDestination`), config `pii.allowRawToLocalModels` (default false), CLI `harness pii explain`.
**Dependencies:** none.
**Items it depends on:** 13.6, 13.7, 14.6, 20.2.
**Implementation guidance:**

1. `resolveDestination({ boundary, provider?, toolId? })`: `model_input` -> provider's `trust`; `tool_input`/`tool_output` -> `{ tool: toolId }`; `storage` -> `"any"`; `ui` -> `"any"`.
2. Safety net: when `allowRawToLocalModels` is false, any policy `allow` for destination `local` at `model_input` is downgraded to `tokenize` and a startup warning code `pii_local_allow_ignored` is logged.
3. `harness pii explain --boundary <b> --destination <hosted|local|tool:<id>> --entity <type>` prints the resulting action and matching rule (uses `explainPiiPolicy`); `--matrix` prints every entity by boundary by destination as a table (and JSON).
4. Cross-check at startup: every `detokenize` allowlist tool (13.5) must exist in the tool registry, else `pii_detokenize_tool_unknown`.
**Tests to write:** resolution table; downgrade behavior and warning; CLI explain and matrix output snapshots; startup cross-check failure.
**Acceptance Criteria:**

- [ ] The full policy matrix is printable and tested.
- [ ] Local raw-value access requires an explicit opt-in.
- [ ] Misconfigured detokenize allowlists fail at startup.

---

## 13.10 Tokens inside Zod-validated structured outputs

**Parent:** #13 PII tokenizer
**Task Description:** Let schemas with format constraints (such as email) validate model outputs that contain tokens, without persisting raw values.
**Expected Inputs:** Zod schema, model output JSON containing tokens, vault resolver.
**Expected Output:** `packages/pii/src/validate-with-tokens.ts` (`validateWithTokens`), integration into the enforcement path (14.8 to 14.10) through an optional `valueTransform` hook.
**Dependencies:** none.
**Items it depends on:** 13.4, 14.10.
**Implementation guidance:**

1. `validateWithTokens(schema, tokenizedValue, { runId, resolver, wantRaw?: boolean })`: deep-copy the value, replace tokens in string values with raw values **in memory**, run `schema.safeParse`; on success return `{ ok: true, tokenized: tokenizedValue, raw?: parsedRaw }` where `raw` is only populated when `wantRaw` is true (that path is audited with boundary `tool_input` via 12.7). On failure return issues (paths and codes only).
2. The value that continues through the system (events, context) is always the **tokenized** original.
3. Gateway hook: enforcement accepts `valueTransform` so `validateWithTokens` runs instead of plain `safeParse` when the PII layer is enabled. Unresolvable tokens produce a validation failure code `pii_token_unresolvable` so the repair loop can react (14.10 sends issue paths only).
4. Raw copies are created per call and dropped immediately; never cached.
5. Document that `wantRaw` consumers (for example a tool needing a typed raw value) must use the detokenize allowlist instead whenever possible.
**Tests to write:** schema with `z.string().email()` accepts `<EMAIL_1>` when the vault resolves to a valid email; invalid underlying value fails; unresolvable token fails with the code; returned `tokenized` equals input; `wantRaw` audited; no raw values in errors (canary).
**Acceptance Criteria:**

- [ ] Format-constrained schemas work with tokenized outputs.
- [ ] Persisted and contextual values stay tokenized.
- [ ] Raw access is opt-in and audited.

---

## 13.11 Synthetic detection corpus with precision and recall report

**Parent:** #13 PII tokenizer
**Task Description:** Measure detector quality on a deterministic synthetic corpus and fail CI on regressions.
**Expected Inputs:** Seeded generator, detectors.
**Expected Output:** `scripts/gen-pii-corpus.ts`, `test/pii-corpus/corpus.jsonl`, `test/pii-corpus/thresholds.json`, `scripts/pii-report.ts`, CI step publishing `pii-report.json` and `pii-report.md` as artifacts.
**Dependencies:** none.
**Items it depends on:** 13.2, 13.3.
**Implementation guidance:**

1. Generator with a fixed seed (own tiny PRNG such as mulberry32, no dependency) produces labeled samples `{ id, text, spans: { start, end, entityType }[] }`: synthetic emails (`@example.test` domains), phones in several formats, Luhn-valid test card numbers (for example the standard `4111111111111111` family), valid IBANs, IPv4/IPv6, API-key-shaped strings, URLs with credentials, names and locations from small built-in lists embedded in sentences. Negatives: order numbers, timestamps, version strings, Luhn-invalid digit runs, invalid IPs.
2. Commit the generated corpus; CI regenerates and fails if it differs (determinism check).
3. `pii-report.ts` runs the detector registry, computes per-entity precision, recall, and F1 using exact span match with a 0.5 IoU fallback column, writes JSON and Markdown.
4. `thresholds.json` sets minimums for regex-covered entities (for example email and card recall at least 0.99, precision at least 0.98) and none for `person_name` and `location` in the regex-only run; Presidio thresholds apply in the integration job.
5. Unit stage runs regex-only; integration stage runs with Presidio. Both publish the report artifact.
**Tests to write:** generator determinism (same seed same output, hash asserted); report math on a tiny hand-labeled set; threshold failure produces a non-zero exit code.
**Acceptance Criteria:**

- [ ] CI fails when a detector regresses below thresholds.
- [ ] Corpus contains only synthetic data.
- [ ] Reports are published as pipeline artifacts.
