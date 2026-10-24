# Epic #7: Event store

**Goal:** the authoritative, tokenized, encrypted, append-only log that every resume, replay, and telemetry export depends on. Read `docs/engineering/CONVENTIONS.md` first.
**Tasks:** 7.1 to 7.14, all size S.

Shared design for this epic:

- The store assigns `seq`. Callers pass `NewEvent` (an `Event` without `seq`) plus `expectedSeq`, the value the caller believes is the next free seq for the run. If the stored head differs, the append fails with `SeqConflictError` and writes nothing. This is the optimistic-concurrency mechanism that prevents two workers from resuming one run.
- Each event is stored as a **meta part** and a **content part** (split by the field classification map from 7.1) so encryption (7.9) applies to content only and telemetry projection (7.10) never touches content.
- Every table has a monotonically increasing `global_seq` (SQLite `INTEGER PRIMARY KEY AUTOINCREMENT` surrogate; Postgres `bigserial`) used only by the outbox.

---

## 7.1 Zod event schema with meta vs content classification

**Parent:** #7 Event store
**Task Description:** Define the canonical event envelope and per-type payload schemas in `@rovinos/schemas`, and the field classification map that marks each field `meta` or `content`, with exhaustiveness enforced by tests.
**Expected Inputs:** Event vocabulary in CONVENTIONS §4.
**Expected Output:** `packages/schemas/src/{json.ts,events.ts,classification.ts}`, exported `Event`, `NewEvent`, `EventType`, `RunStatus`, `EVENT_FIELD_CLASS`, `splitEvent(event)`, `joinEvent(meta, content)`.
**Dependencies:** `zod`.
**Items it depends on:** 1.1.
**Implementation guidance:**

1. Primitives (`packages/schemas/src/primitives.ts`): `Id` (`/^[0-9A-HJKMNP-TV-Z]{26}$/`), `Code` (`/^[a-z0-9_.-]{1,64}$/`), `Sha256Hex` (64 lowercase hex), `TraceId` (32 hex), `SpanId` (16 hex), `Traceparent` (`/^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/`), `JsonValue` (recursive JSON schema: null, boolean, number, string, array, object).
2. Envelope (all `meta`): `runId: Id`, `seq: int>=0`, `ts: int>=0`, `type`, `v: int>=1` (schema version of this event type, written as the current version; task 7.13 adds upcasting), `traceId: TraceId`, `spanId: SpanId`, `segmentId: Id` (one per resume segment). `NewEvent = Omit<Event, "seq">` distributed over the union.
3. Build `Event` as `z.discriminatedUnion("type", [...])` with each member `.strict()`. Payload fields (M = meta, C = content):
   - `run_created`: configHash M Sha256Hex, policyVersion M Code, parentRunId? M Id.
   - `run_status_changed`: from/to M `RunStatus` (`pending|running|suspended|completed|failed|cancelled`), reason M Code.
   - `model_request`: requestId M Id, provider M Code, model M Code, role? M Code, schemaHash? M Sha256Hex, messages C JsonValue.
   - `model_response`: requestId M Id, provider M Code, model M Code, inputTokens M int, outputTokens M int, finishReason M Code, latencyMs M int, schemaValid M boolean, repairAttempts M int, content C JsonValue, providerBlobs C JsonValue.
   - `tool_intent`: callId M Id, toolId M Code, idempotent M boolean, policyDecision M `allow|ask|deny`, argsHash M Sha256Hex (canonical JSON of the tokenized args), args C JsonValue.
   - `tool_result`: callId M Id, toolId M Code, outcome M `ok|error|denied|timeout`, errorCode? M Code, latencyMs M int, executedArgsHash? M Sha256Hex (set when the executed args differ from the intent, for example after an approval edit), result C JsonValue.
   - `approval_requested`: approvalId M Id, callId M Id, expiresAt? M int, payload C JsonValue.
   - `approval_resolved`: approvalId M Id, decision M `approve|deny|edit`, waitMs M int, edits? C JsonValue.
   - `checkpoint_written`: checkpointId M Id, atSeq M int, traceparent M Traceparent, workspaceRef? M `Code`-like string up to 128 (`/^[A-Za-z0-9:_./-]{1,128}$/`).
   - `context_compacted`: fromSeq M int, toSeq M int, strategy M Code, strategyVersion M Code, summary C JsonValue.
   - `pii_action`: boundary M `model_input|tool_input|tool_output|storage|ui`, action M `tokenized|redacted|blocked|allowed`, entities M `{type: Code, count: int}[]`.
   - `budget_exceeded`: budget M `steps|cost|wall_clock`, limit M number, observed M number.
   - `subagent_spawned`: childRunId M Id, role M Code, parentCallId? M Id.
   - `subagent_completed`: childRunId M Id, outcome M `completed|failed|cancelled`.
4. `classification.ts`: `EVENT_FIELD_CLASS: { [T in EventType]: Record<PayloadKeys<T>, "meta"|"content"> }` typed so adding a payload field without classifying it is a compile error. Envelope keys are always meta and not listed. The default for any future field is `content`; document this.
5. `splitEvent(event) -> { meta: Record<string, unknown>; content: Record<string, unknown> }` and `joinEvent(meta, content) -> Event` (re-validates with `Event.parse`). Optional payload fields absent stay absent (do not write `undefined`).
6. Content fields use `JsonValue` for now; task 14.2 tightens `messages`/`content` types. Leave a TODO referencing 14.2.
**Tests to write:** `events.test.ts`: every type parses a valid sample and rejects an extra key; `classification.test.ts`: for each type, every Zod shape key (introspect `.shape`) has a classification (exhaustiveness at runtime), `split`/`join` round-trip is identity for samples, content never appears in meta; regex tests for primitives (valid and invalid examples).
**Acceptance Criteria:**

- [ ] All 14 event types listed above defined strictly; unknown keys rejected. (Task 15.1 later adds a 15th type, `run_input`, with `input` as content and `inputKind` as meta; design the union so adding a type is a one-line change.)
- [ ] Adding an unclassified field fails typecheck and the exhaustiveness test.
- [ ] `splitEvent`/`joinEvent` round-trip verified for every type.

---

## 7.2 EventStore interface, error types, and in-memory reference store

**Parent:** #7 Event store
**Task Description:** Define the `EventStore` contract and typed errors, plus an in-memory implementation used by tests in other packages.
**Expected Inputs:** `Event`/`NewEvent` (7.1).
**Expected Output:** `packages/store/src/types.ts`, `errors.ts`, `memory.ts`, package scaffold `packages/store`.
**Dependencies:** none.
**Items it depends on:** 7.1.
**Implementation guidance:**

1. Interface:

```ts
interface EventStore {
  append(runId: Id, events: readonly NewEvent[], expectedSeq: number): Promise<{ nextSeq: number }>;
  read(runId: Id, range?: { fromSeq?: number; toSeq?: number }): AsyncIterable<Event>;
  head(runId: Id): Promise<number>; // next free seq, 0 for unknown run
  listRuns(opts: { status?: RunStatus; limit: number; cursor?: string }): Promise<{ runs: RunSummary[]; nextCursor?: string }>;
  close(): Promise<void>;
}
```

`RunSummary = { runId, createdAt, status, lastSeq, lastTs }`; status derives from the latest `run_status_changed` (default `pending` after `run_created`).
2. Errors (extend `HarnessError`): `SeqConflictError` (`seq_conflict`, fields `expected`, `actual`), `StoreUnavailableError` (`store_unavailable`), `InvalidEventError` (`event_invalid`, wraps Zod issue paths only, never values).
3. `append` semantics: validate every event with `Event.parse({ ...e, seq })` before writing; all-or-nothing; assign `seq = expectedSeq + index`; reject events whose `runId` differs from the argument; reject empty arrays with `event_invalid`.
4. `InMemoryEventStore` implements the interface with a `Map<Id, Event[]>`, deterministic and synchronous internally. `read` yields copies (deep clone) to prevent callers mutating stored events.
5. Re-export types from `packages/store/src/index.ts`.
**Tests to write:** deferred to 7.4 (conformance suite) except `memory.test.ts` smoke tests: append then read, conflict on stale `expectedSeq`, deep-clone isolation.
**Acceptance Criteria:**

- [ ] Interface and errors exported and documented with TSDoc.
- [ ] In-memory store passes its smoke tests.
- [ ] `append` is all-or-nothing and rejects cross-run events.

---

## 7.3 SQLite adapter: append and read

**Parent:** #7 Event store
**Task Description:** Implement the default durable adapter on SQLite with transactional, conflict-checked appends and a pluggable content codec.
**Expected Inputs:** DB file path (or `:memory:`), optional `ContentCodec`.
**Expected Output:** `packages/store-sqlite/src/sqlite/{adapter.ts,schema.sql.ts}`, `packages/store/src/codec.ts` (`ContentCodec`, `JsonContentCodec`).
**Dependencies:** `better-sqlite3` (verify native build works on Azure ubuntu agents and in the Docker image).
**Items it depends on:** 7.1, 7.2.
**Implementation guidance:**

1. Open with pragmas `journal_mode=WAL`, `synchronous=NORMAL`, `busy_timeout=5000`, `foreign_keys=ON`.
2. Tables (created for now with `CREATE TABLE IF NOT EXISTS`; task 7.12 replaces this with migrations): `events(global_seq INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, seq INTEGER NOT NULL, ts INTEGER NOT NULL, type TEXT NOT NULL, trace_id TEXT NOT NULL, span_id TEXT NOT NULL, segment_id TEXT NOT NULL, meta_json TEXT NOT NULL, content_blob TEXT NOT NULL, key_id TEXT, UNIQUE(run_id, seq))`, `runs(run_id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, status TEXT NOT NULL, next_seq INTEGER NOT NULL, last_ts INTEGER NOT NULL)`, plus indexes on `events(trace_id)` and `runs(status, created_at)`.
3. `ContentCodec { encode(ctx: {runId, seq}, content: object): Promise<{ blob: string; keyId?: string }>; decode(ctx, blob: string, keyId?: string): Promise<object> }`. `JsonContentCodec` is `JSON.stringify/parse` with `keyId` undefined.
4. `append`: encode content first (async, outside the transaction), then run one synchronous `db.transaction(() => { ... })` using `BEGIN IMMEDIATE`: read `next_seq` for the run (insert the `runs` row if the first event is `run_created` and seq 0), compare to `expectedSeq`, throw `SeqConflictError` if different, insert events, update `runs.next_seq`, `status` (from `run_status_changed.to`), `last_ts`. Map `SQLITE_BUSY` to `StoreUnavailableError`.
5. `read` uses a prepared statement with `.iterate()`, decodes content per row, `joinEvent` re-validates. `head` returns `next_seq` or 0. `listRuns` uses keyset pagination on `(created_at, run_id)`, cursor is an opaque base64 of that pair.
6. The synchronous driver is wrapped in `async` methods; do not block the event loop for large reads (iterate lazily).
**Tests to write:** `sqlite.test.ts` (adapter-specific): pragmas applied; file persists across reopen; two events in one batch get consecutive seqs; transaction rolls back on a failing event (no partial rows); cursor pagination stable; `:memory:` works. The shared behaviors are covered by 7.4.
**Acceptance Criteria:**

- [ ] Data survives process restart.
- [ ] Failed append leaves no rows.
- [ ] No content appears in `meta_json` (asserted by test).

---

## 7.4 Adapter conformance suite

**Parent:** #7 Event store
**Task Description:** Write a reusable test suite every `EventStore` adapter must pass, and run it against the in-memory and SQLite stores.
**Expected Inputs:** A factory `() => Promise<{ store: EventStore; cleanup(): Promise<void> }>`.
**Expected Output:** `packages/store/src/conformance.ts` exporting `runEventStoreConformance(name, factory)` which registers Vitest `describe/it` blocks; `memory.test.ts` and `sqlite.conformance.test.ts` invoking it.
**Dependencies:** `vitest`.
**Items it depends on:** 7.2, 7.3.
**Implementation guidance:**

1. Provide sample event builders in `packages/store/src/testing.ts` using `FakeClock` and `SequentialIdGenerator`.
2. Cases (each one `it`): append/read ordering by seq; range reads (`fromSeq`, `toSeq`); `head` for unknown run is 0; conflict on stale `expectedSeq` leaves no new rows; conflict on `expectedSeq` ahead of head; empty append rejected; mixed-run batch rejected; invalid event rejected and nothing persisted (atomicity); content/meta round-trip equals input including optional fields; large content (1 MB JSON) round-trips; `listRuns` filters by status and paginates; `run_status_changed` updates summary status; `read` is lazy (does not load everything: assert via reading first 10 of 5,000 events quickly, informally via timing guard).
3. The suite takes a `caps` argument (`{ supportsFileReopen: boolean }`) so persistence tests run only where applicable.
4. Keep the suite free of adapter-specific imports so 7.6 and future adapters reuse it.
**Tests to write:** The suite itself is the deliverable; plus a "mutation check" test that runs the suite against a deliberately broken store (swallows conflicts) and asserts the suite fails.
**Acceptance Criteria:**

- [ ] In-memory and SQLite stores pass every case.
- [ ] The broken-store mutation check proves the suite detects conflict-handling bugs.
- [ ] Suite exported for reuse by other packages.

---

## 7.5 Concurrent-writer conformance tests

**Parent:** #7 Event store
**Task Description:** Prove that two workers resuming the same run cannot both succeed, using separate connections and real concurrency.
**Expected Inputs:** Adapter factory capable of producing multiple independent connections to the same underlying database.
**Expected Output:** `runConcurrencyConformance(name, multiFactory)` in `packages/store/src/conformance-concurrency.ts`; SQLite test using two connections to one temp file.
**Dependencies:** Node `worker_threads`.
**Items it depends on:** 7.4.
**Implementation guidance:**

1. `multiFactory() -> { open(): Promise<EventStore>; cleanup() }` where each `open()` returns a new connection to the same DB.
2. Scenario A (race on head): create a run with N events; open two stores; call `append` on both with the same `expectedSeq` via `Promise.allSettled`; assert exactly one fulfilled, one rejected with `seq_conflict`, final log has no gaps or duplicates. Repeat 200 times with randomized small delays.
3. Scenario B (resume race using worker threads): spawn two `worker_threads` that each open the store, read head, then append one `run_status_changed` event; assert exactly one winner.
4. Scenario C (writer vs. reader): while a writer appends 1,000 events, a reader repeatedly reads; assert the reader never observes a gap in seq.
5. Mark the suite so it runs in the unit project for SQLite (temp file) and in the integration project for Postgres (7.6).
**Tests to write:** The three scenarios above.
**Acceptance Criteria:**

- [ ] 200/200 race iterations have exactly one winner.
- [ ] Final logs have contiguous seq values.
- [ ] Reader never sees gaps.

---

## 7.6 Postgres adapter with conformance run in Azure

**Parent:** #7 Event store
**Task Description:** Implement the Postgres adapter and run both conformance suites against a Postgres service container in the integration stage.
**Expected Inputs:** Postgres connection URL.
**Expected Output:** `packages/store-postgres/src/postgres/adapter.ts`, `postgres.int.test.ts`, `postgres` service in `infra/compose/docker-compose.test.yml`, `TEST_POSTGRES_URL` env wiring in the pipeline.
**Dependencies:** `pg`, Docker image `postgres:16`.
**Items it depends on:** 7.4, 7.5, 1.8.
**Implementation guidance:**

1. Schema mirrors SQLite with types: `global_seq bigserial`, `meta jsonb`, `content_blob text`, `key_id text`, `UNIQUE(run_id, seq)`, same indexes; table creation inline for now (7.12 migrates).
2. `append` in one transaction: `INSERT INTO runs(...) ON CONFLICT (run_id) DO NOTHING`, then `SELECT next_seq FROM runs WHERE run_id=$1 FOR UPDATE`, compare with `expectedSeq`, batch insert with `unnest`/multi-row values, `UPDATE runs SET next_seq, status, last_ts`. Convert unique violations (`23505`) to `SeqConflictError` as a safety net.
3. Use a `Pool` with injected size; `close()` ends the pool. Map connection errors to `StoreUnavailableError`.
4. Use `READ COMMITTED` (default); the row lock gives the required serialization.
5. Compose: `postgres:16` with healthcheck `pg_isready`; pipeline sets `TEST_POSTGRES_URL`. Each test creates a unique schema (`CREATE SCHEMA t_<ulid>`) and drops it in cleanup.
**Tests to write:** `postgres.int.test.ts` invokes `runEventStoreConformance` and `runConcurrencyConformance` (multi-connection via separate pools).
**Acceptance Criteria:**

- [ ] Both suites pass against Postgres in the Azure `integration` stage.
- [ ] Concurrent race test shows exactly one winner.
- [ ] Schemas cleaned up after tests.

---

## 7.7 Trace and span IDs stored and queryable

**Parent:** #7 Event store
**Task Description:** Ensure every row carries `trace_id`/`span_id` and add a lookup used by replay to resolve a run from a trace.
**Expected Inputs:** Events with trace context (envelope).
**Expected Output:** `findRunsByTrace(traceId): Promise<Id[]>` on the `EventStore` interface, implemented in memory, SQLite, and Postgres; conformance cases.
**Dependencies:** none.
**Items it depends on:** 7.4, 7.6.
**Implementation guidance:**

1. Add the method to `EventStore` and update the in-memory store (scan or maintain a `Map<TraceId, Set<Id>>`).
2. SQLite/Postgres: `SELECT DISTINCT run_id FROM events WHERE trace_id = ? ORDER BY global_seq`; confirm the index on `trace_id` exists (add if missing in the inline schema; migration task 7.12 carries it forward).
3. A trace can map to multiple runs (parent and subagent runs share trace links); return all, ordered by first appearance. Return `[]` for unknown traces (not an error).
4. Validate `traceId` with the `TraceId` schema; invalid input throws `event_invalid`.
**Tests to write:** Add to the conformance suite: lookup finds the run; unknown trace returns empty; one trace across two runs; invalid trace id rejected. Index-existence assertion in adapter-specific tests (`EXPLAIN QUERY PLAN` for SQLite shows index use).
**Acceptance Criteria:**

- [ ] Lookup works on all three adapters.
- [ ] Query uses the index (verified on SQLite).
- [ ] Documented for use by task 9.1.

---

## 7.8 Snapshots: write and read the latest

**Parent:** #7 Event store
**Task Description:** Add snapshot storage written atomically with the `checkpoint_written` event, plus retrieval of the latest snapshot for fast resume.
**Expected Inputs:** `Snapshot` objects from the run loop.
**Expected Output:** `Snapshot` schema in `@rovinos/schemas/src/snapshot.ts`, `SnapshotStore` methods on `EventStore` (`appendWithSnapshot`, `latestSnapshot`), adapter implementations, conformance cases.
**Dependencies:** none.
**Items it depends on:** 7.6, 7.7.
**Implementation guidance:**

1. `Snapshot = { snapshotId: Id, runId: Id, atSeq: int, createdAt: int, traceparent: Traceparent, context: JsonValue (content), plan: JsonValue (content), workspaceRef?: string }`. `context` and `plan` are content and go through the `ContentCodec` like event content.
2. `appendWithSnapshot(runId, events, expectedSeq, snapshot)` performs the event append and snapshot insert in one transaction. It requires the batch to contain exactly one `checkpoint_written` event whose `checkpointId === snapshot.snapshotId` and `atSeq === snapshot.atSeq`; otherwise `event_invalid`.
3. `latestSnapshot(runId)` returns the snapshot with the highest `atSeq`, or `undefined`.
4. Table `snapshots(snapshot_id PK, run_id, at_seq, created_at, meta_json, content_blob, key_id)` with index `(run_id, at_seq DESC)`. Keep the most recent `snapshotKeep` (default 5) per run, pruned inside the same transaction.
5. Conflict behavior identical to `append`; nothing partial is written.
**Tests to write:** Conformance additions: round-trip; latest selection; atomicity (conflict leaves no snapshot); mismatch between checkpoint event and snapshot rejected; pruning keeps exactly N.
**Acceptance Criteria:**

- [ ] Snapshot and checkpoint event are written atomically.
- [ ] `latestSnapshot` returns the newest; pruning bounded.
- [ ] Content fields in snapshots pass through the codec.

---

## 7.9 Encryption at rest for content fields

**Parent:** #7 Event store
**Task Description:** Implement AES-256-GCM content encryption behind a `KeyProvider` interface, wired into both adapters through the `ContentCodec`.
**Expected Inputs:** `KeyProvider`, content objects.
**Expected Output:** `packages/schemas/src/key-provider.ts` (interface), `packages/store/src/aes-gcm-codec.ts`, adapter option `contentCodec`, tests with an in-test key provider.
**Dependencies:** Node `crypto` only.
**Items it depends on:** 7.3, 7.6, 7.8.
**Implementation guidance:**

1. `interface KeyProvider { currentKeyId(): string; getKey(keyId: string): Promise<Uint8Array> /* 32 bytes */ }` (task 12.3 supplies a local implementation, 12.4 an Azure Key Vault one).
2. `AesGcmContentCodec(keyProvider)`: `encode` serializes content with `JSON.stringify`, generates a random 12-byte IV, encrypts with `aes-256-gcm`, uses AAD `${runId}:${seq}` (for snapshots `${runId}:snap:${atSeq}`), outputs `base64(iv || ciphertext || authTag)` and the `keyId`. `decode` reverses; failure throws `content_decrypt_failed` (no details).
3. Never reuse IV; never log keys or plaintext; zero out key buffers when practical.
4. Missing key for an old `key_id` yields `key_not_found` so rotation (12.5) can be tested.
5. Add an `encrypted` flag recorded in a store metadata table so opening an encrypted DB without a codec fails fast (`store_encryption_mismatch`).
**Tests to write:** Round-trip; ciphertext differs for same plaintext; tamper with blob fails; moving a blob to another `(runId, seq)` fails (AAD binding); wrong key fails; plaintext absent from the DB file bytes (grep the SQLite file); conformance suite passes with the codec enabled.
**Acceptance Criteria:**

- [ ] No plaintext content found in DB files (test greps for a canary string).
- [ ] AAD binding verified.
- [ ] Conformance suites pass with encryption on.

---

## 7.10 Outbox cursor API and safe-event projection

**Parent:** #7 Event store
**Task Description:** Let telemetry sinks consume events at-least-once from the store, and project each event to its closed `SafeEvent` form.
**Expected Inputs:** Stored events; sink id.
**Expected Output:** `OutboxReader` methods on `EventStore` (`fetchOutbox(sinkId, limit)`, `ackOutbox(sinkId, cursor)`), `packages/telemetry/src/safe-event.ts` (`SafeEvent` schemas, `toSafeEvent(event): SafeEvent | null`), `sink_cursors` table.
**Dependencies:** none.
**Items it depends on:** 7.1, 7.6, 7.8.
**Implementation guidance:**

1. `fetchOutbox(sinkId: Code, limit: number): Promise<{ events: Event[]; cursor: number }>` returns events with `global_seq > lastAcked` ordered by `global_seq`; `ackOutbox(sinkId, cursor)` advances monotonically (ignore lower cursors). Sinks must be idempotent keyed by `(runId, seq)`.
2. Table `sink_cursors(sink_id TEXT PRIMARY KEY, cursor BIGINT NOT NULL, updated_at INTEGER NOT NULL)`.
3. `SafeEvent` is a `z.discriminatedUnion("kind", [...])` of `.strict()` schemas branded `SafeEvent`. Mapping (event type -> safe kind and fields): `model_response` -> `model_call {provider, model, inputTokens, outputTokens, latencyMs, schemaValid, repairAttempts, finishReason}`; `tool_result` -> `tool_call {toolId, outcome, errorCode?, latencyMs}`; `approval_resolved` -> `approval_wait {decision, waitMs}`; `checkpoint_written` -> `checkpoint {atSeq, hasWorkspaceRef}`; `run_status_changed` -> `run_status {from, to, reason}`; `pii_action` -> same fields; `budget_exceeded`, `subagent_spawned`, `subagent_completed` -> same meta fields; `run_created` -> `run_created {configHash, policyVersion}`. `model_request`, `tool_intent`, `approval_requested`, `context_compacted` -> `null` (not exported). Every safe kind also carries `runId, seq, ts, traceId, spanId, policyVersion` where `policyVersion` is the exporter's current sanitizer policy version, passed in.
4. `toSafeEvent` builds the output from an explicit field list per kind (never by deleting keys from the event), then `SafeEvent.parse`. This is the allowlist rule: new fields are not exported until someone adds them here.
5. Add a CI lint test (task 4.6 extends it) that walks every `SafeEvent` schema and fails on unconstrained `z.string()`.
**Tests to write:** Conformance: fetch/ack at-least-once semantics, monotonic ack, independent sinks; projection tests for every mapping; property test: for random events with canary strings in content fields, `JSON.stringify(toSafeEvent(e))` never contains the canaries; `null` mapping for unexported types.
**Acceptance Criteria:**

- [ ] Two sinks progress independently and replay from a stored cursor.
- [ ] Projection output contains no content-classified field (property test).
- [ ] Adding an event type without a safe-mapping decision fails compilation.

---

## 7.11 Retention policy job

**Parent:** #7 Event store
**Task Description:** Delete expired runs under configured retention, with a dry-run mode and a hook so the token vault purges at the same time. Snapshot pruning is configured per store adapter and happens on snapshot writes.
**Expected Inputs:** Retention config (`completedRunsDays`, `failedRunsDays`), clock.
**Expected Output:** `deleteRun(runId)` on `EventStore`, `packages/store/src/retention.ts` (`purgeExpiredRuns`), config fragment `packages/schemas/src/config/store.ts` retention section, CLI wiring left to 20.x commands (document only).
**Dependencies:** none.
**Items it depends on:** 7.8, 20.1.
**Implementation guidance:**

1. `deleteRun` removes events, snapshots, and the `runs` row in one transaction; returns the number of events deleted. Never deletes runs whose status is `running` or `suspended`.
2. `purgeExpiredRuns({ store, clock, policy, onRunPurged?, dryRun })`: select terminal runs where `last_ts < now - days*86_400_000` (use `listRuns` with status filters and keyset pagination; do not load all runs), call `deleteRun`, then `await onRunPurged(runId)` (12.6 wires the vault purge here). Process in batches of 100.
3. Returns `{ examined, purged, skippedActive, hookFailures }`; hook failures are counted without undoing deletion. In dry-run nothing is deleted or passed to the hook, and the run counts match a real purge.
4. Emit only metadata through the logger (`run_purged` with the run id).
**Tests to write:** Expiry boundaries with `FakeClock`; active runs never purged; dry run deletes nothing; `onRunPurged` called after deletion; failure in the hook does not roll back deletion but is reported; conformance case for `deleteRun` atomicity on all adapters.
**Acceptance Criteria:**

- [ ] Only terminal runs older than policy are removed.
- [ ] Dry run is side-effect free.
- [ ] Vault purge hook invoked per purged run.

---

## 7.12 Schema migration runner shared by both adapters

**Parent:** #7 Event store
**Task Description:** Replace inline `CREATE TABLE IF NOT EXISTS` with ordered, checksummed, transactional migrations.
**Expected Inputs:** SQL migration files per dialect.
**Expected Output:** `packages/store-sqlite/migrations/0001_init.sql` and `packages/store-postgres/migrations/0001_init.sql` (consolidating all tables from 7.3 to 7.10), `packages/store/src/migrate.ts` (`migrate(driver, dialect, opts)`), `schema_migrations` table, CLI doc stub for `harness store migrate`.
**Dependencies:** none.
**Items it depends on:** 7.3, 7.6, 7.10, 7.11.
**Implementation guidance:**

1. Migration files named `NNNN_name.sql`, applied in lexical order. Table `schema_migrations(version TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at INTEGER NOT NULL)`.
2. For each unapplied migration: compute SHA-256 of the file, run inside one transaction (SQLite: `BEGIN IMMEDIATE`; Postgres: `BEGIN` with an advisory lock `pg_advisory_xact_lock(hash)` so concurrent starters serialize), record the row. For an already-applied version, verify the checksum equals the stored one or throw `migration_checksum_mismatch`.
3. Refuse to run if the database has a version newer than the code knows (`schema_newer_than_code`).
4. Both adapters call `migrate` in their `open()` factory; remove inline table creation. Provide `dryRun: true` returning the pending list.
5. `0001_init.sql` must produce exactly the schema tests already rely on, including `global_seq`, indexes, `snapshots`, `sink_cursors`, and the encryption metadata table.
**Tests to write:** Fresh DB migrates; second run is a no-op; edited migration file triggers checksum error; newer-than-code DB refused; two concurrent `migrate` calls on Postgres apply once; SQLite and Postgres conformance suites still pass.
**Acceptance Criteria:**

- [ ] Adapters create their schema solely through migrations.
- [ ] Checksum drift and downgrade attempts are rejected.
- [ ] Concurrent startups are safe on Postgres.

---

## 7.13 Event schema versioning, upcasters, and legacy-log tests

**Parent:** #7 Event store
**Task Description:** Let logs written by older releases keep loading after event schemas change, and make schema changes without a version bump fail CI.
**Expected Inputs:** Stored events with the envelope `v` field (7.1), current schemas.
**Expected Output:** `packages/schemas/src/event-versions.ts` (`EVENT_SCHEMA_VERSIONS`, `UPCASTERS`, `upcastEvent`), read-path integration in `joinEvent` and every adapter, `packages/schemas/event-schema.lock.json`, `scripts/check-event-schema.ts` (`static` stage), `scripts/gen-legacy-log.ts`, `test/fixtures/legacy-logs/`, `test/legacy-logs.test.ts`, CONVENTIONS section 4 rule.
**Dependencies:** none.
**Items it depends on:** 7.1, 7.10, 7.12, 9.6.
**Implementation guidance:**

1. `EVENT_SCHEMA_VERSIONS: Record<EventType, int>` holds the current version per type. `UPCASTERS: { [T in EventType]?: Record<number, (payload: unknown) => unknown> }` maps version `n` to a pure function producing version `n + 1`. `upcastEvent(raw)` applies the chain up to the current version, then the strict `Event.parse` runs. Writes always use the current version. Snapshots carry the same `v` and use the same mechanism.
2. Evolution rule (write it into CONVENTIONS section 4): until the first tagged release (21.6) schemas may change in place with golden updates. From the first release on, any change to an existing event type's payload bumps its version and adds an upcaster. Fields are never removed from meta. A new required field needs an upcaster that supplies a default (for example `decidedBy: "human"` for older `approval_resolved` events). New event types are additive and start at version 1.
3. Lock file: `check-event-schema.ts` converts each event type's Zod schema to JSON Schema with the same converter 14.7 uses (Zod's built-in conversion, or the library 14.7 records), canonicalizes it (sorted keys), hashes it, and compares with `event-schema.lock.json` (`{ type: { v, hash } }`). A hash change without a version bump, a version bump without an upcaster, or a missing lock entry fails. `--update` rewrites the lock file after a deliberate change.
4. Legacy logs: `gen-legacy-log.ts` runs the golden scenario from 9.6 with fake providers and writes synthetic logs as JSON Lines to `test/fixtures/legacy-logs/<version>/` (`containsRealData: false` header line). The release stage (21.6) runs it for every tag and commits the output in the release PR. `legacy-logs.test.ts` loads every committed legacy log through the current code and asserts: parse and fold succeed, `toSafeEvent` succeeds, normalized replay signatures (9.4) are stable, and non-terminal logs resume to completion with fake ports. Legacy log files are read line by line with `parseJson` against the raw (pre-upcast) event envelope schema (CONVENTIONS 3.10).
5. Readers never rewrite stored rows; upcasting happens on read only. Document that a data migration (rewriting old rows) is an explicit, separate tool if it is ever needed.
**Tests to write:** upcaster chain application (1 to 3); strict parse after upcast; lock checker failure cases (hash drift, missing upcaster, missing entry) and pass case; legacy-log suite against a hand-made v1 fixture with an upcaster for a field added in v2.
**Acceptance Criteria:**

- [ ] Logs from earlier releases load, fold, project, and resume with current code.
- [ ] A schema change without a version bump and upcaster fails CI.
- [ ] The evolution rule is documented in CONVENTIONS.

---

## 7.14 Live event subscriptions

**Parent:** #7 Event store
**Task Description:** Let consumers follow a run's log as it grows, and follow run status changes, without polling the whole log.
**Expected Inputs:** `runId`, a starting seq, an `AbortSignal`.
**Expected Output:** `watch(runId, { fromSeq, signal }): AsyncIterable<Event>` and `watchRuns({ statuses?, signal }): AsyncIterable<RunSummary>` on `EventStore`, implemented in memory, SQLite, and Postgres; conformance cases.
**Dependencies:** none.
**Items it depends on:** 7.4, 7.6, 7.12.
**Implementation guidance:**

1. `watch` first yields stored events from `fromSeq`, then new events in order with no gaps or duplicates, and ends when the signal aborts or the run reaches a terminal status (after yielding the terminal event).
2. In-memory store: an internal emitter. SQLite: an in-process emitter for appends made through the same adapter instance plus a polling fallback (default 250 ms, configurable) for writers in other processes. Postgres: inside the append transaction, send one `NOTIFY harness_events, '<runId>:<finalSeq>'` per append batch (ids only, never content); listeners wake on notification and read the new rows.
3. Bounded buffering: if a consumer falls behind by more than `maxBuffered` (default 1,000) events, the iterator re-reads from the store instead of growing memory.
4. `watchRuns` yields `RunSummary` changes for status transitions (used by the control plane console, 24.5). In-process emitters and Postgres notifications identify the changed run so adapters refresh only its summary; SQLite's cross-process polling fallback may re-list all runs.
5. Notifications carry no content; consumers read events through the normal decode path (including upcasting from 7.13).
**Tests to write:** conformance: catch-up then live, ordering, no gaps under concurrent appends from another connection, termination on terminal status, abort, slow-consumer re-read path; Postgres notification path in the integration stage.
**Acceptance Criteria:**

- [ ] Subscribers see every event exactly once and in order.
- [ ] Cross-process appends are delivered on SQLite (polling) and Postgres (notify).
- [ ] Notifications contain ids only.

---

## 7.15 Split the SQLite and Postgres adapters into separate packages

**Parent:** #7 Event store
**Task Description:** Move each durable adapter into its own workspace package so installing one database driver never forces the other (`better-sqlite3` compiles a native addon on install; `pg` is only needed for Postgres).
**Expected Inputs:** `packages/store` with the in-memory store, the `EventStore` contract, the codec, the conformance suites, and both adapters.
**Expected Output:** `packages/store-sqlite` (`SqliteEventStore`, depends on `better-sqlite3`) and `packages/store-postgres` (`PostgresEventStore`, depends on `pg`); `packages/store` keeps the contract, errors, codec, the in-memory store, and the `./testing` conformance suites, and depends on neither driver; `docs/engineering/layers.json` entries for both new packages; updated imports, Dockerfile, and docs.
**Dependencies:** none new.
**Items it depends on:** 7.6, 7.8.
**Implementation guidance:**

1. Move `src/sqlite/**` and its tests to `packages/store-sqlite`, and `src/postgres/**` plus `postgres.int.test.ts` to `packages/store-postgres`. Both depend on `@rovinos/store` for the contract, errors, codec, and `./testing` suites (dev dependency for the suites).
2. `@rovinos/store` drops `better-sqlite3`, `pg`, and their types from `dependencies`; a test asserts its manifest lists neither driver.
3. Shared helpers used by both adapters (row serialization, snapshot validation, error mapping) stay in `@rovinos/store` and are exported for adapter packages only (document them as adapter-internal in TSDoc; never part of the public SDK surface).
4. Move each adapter's conformance invocation with it: `packages/store-sqlite` runs both suites in the unit project; `packages/store-postgres` runs them in the integration project against the Compose Postgres.
5. Update `layers.json`, the Dockerfile copy step (generic since #273), and any consumer imports; `yarn check:agents` regenerates the index blocks.
**Tests to write:** existing adapter and conformance tests pass from their new packages; a manifest test that `@rovinos/store` has no database driver dependency; `yarn workspaces focus @rovinos/store --production` installs no native addon.
**Acceptance Criteria:**

- [ ] Installing `@rovinos/store` alone pulls in neither `better-sqlite3` nor `pg`.
- [ ] Each adapter package passes both conformance suites (SQLite in unit, Postgres in integration).
- [ ] No behavior change; all existing tests pass.
