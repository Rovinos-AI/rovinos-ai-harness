# Epic #24: Run service, SDK, and horizontal scaling

**Goal:** turn the harness from a single-process CLI into a service: a stable programmatic SDK, a durable run queue with workers, run creation and live updates over the control plane, multi-replica deployment, quotas across runs, and performance budgets. Read `docs/engineering/CONVENTIONS.md` first, plus epics 2, 7, 12, 18, and 19.
**Tasks:** 24.1 to 24.10, all size S; 24.23 is a design task.

Shared design for this epic:

- **The event log stays the source of truth.** The queue holds only ids and scheduling state. Run input is recorded as `run_created` and `run_input` events (status `pending`) at enqueue time, so no content lives in queue rows.
- **Workers are interchangeable.** Any worker can execute or resume any run. Ownership comes from the queue lease plus the store's `seq` conflict (2.2), so a stale worker can never append after losing a run.
- **Single-instance mode stays supported.** SQLite store and vault with one process remain the default for local use. Multi-instance mode requires Postgres for both and is validated at startup.
- Package `packages/sdk` is the only stable public API (`@rovinos/sdk`). `createRuntime` and other internals stay internal. The `harness worker` command lives in `packages/cli`; queue tables live in `packages/store`.

---

## 24.1 Public SDK: `@rovinos/sdk`

**Parent:** #24 Run service, SDK, and horizontal scaling
**Task Description:** Provide a small, documented, semver-stable programmatic API for embedding the harness in other applications.
**Expected Inputs:** Config object or path, optional overrides for tests.
**Expected Output:** `packages/sdk/src/{index.ts,harness.ts,types.ts}`, package scaffold, `examples/sdk/basic.ts`, `docs/sdk.md`, `layers.json` entry for `sdk`.
**Dependencies:** none.
**Items it depends on:** 2.10, 2.13, 2.14, 17.5, 20.1, 7.14.
**Implementation guidance:**

1. API:

   ```ts
   const harness = await createHarness({ config | configPath, overrides? });
   harness.startRun({ goal, metadata?, role?, idempotencyKey?, requestedBy? }): Promise<{ runId; status }>;
   harness.continueRun(runId, { goal, metadata? });
   harness.getRun(runId): Promise<RunView>;          // metadata only, like get_run (18.1)
   harness.listRuns(filter): Promise<Page<RunSummary>>;
   harness.resumeRun(runId); harness.cancelRun(runId);
   harness.resolveApproval(approvalId, decision, { edits?, principal });
   harness.answerInput(requestId, { action, content?, principal });   // epic 25
   harness.watch(runId, { fromSeq? }): AsyncIterable<SafeEvent>;     // content-free
   harness.close(): Promise<void>;
   ```

2. Without a queue configured, `startRun` runs in-process (detached) and returns immediately. With a queue (24.2), it enqueues.
3. Everything returned is metadata or `SafeEvent`s. Reading content requires an explicit `getRunContent(runId, { reveal: false })` that returns tokenized content only and is documented as sensitive.
4. Types are exported from `index.ts` with full TSDoc. Anything not exported is internal. Add an API-extractor-style snapshot test of the public surface (a committed `.d.ts` snapshot) so breaking changes are deliberate and require a major changeset (21.6). Every public method validates its input with a Zod schema at the boundary, and exported types are `z.infer` of those schemas (CONVENTIONS 3.10).
5. Add `sdk` to `docs/engineering/layers.json`: it may import `core` and everything below it, plus `config`.
**Tests to write:** each method against the in-memory store and fake ports; public surface snapshot; `watch` yields safe events only (canary); idempotency key returns the same run id; example file type-checks.
**Acceptance Criteria:**

- [ ] Applications can run and control the harness without the CLI.
- [ ] The public surface is snapshot-tested and documented.
- [ ] No content is returned unless explicitly requested.

---

## 24.2 Durable run queue

**Parent:** #24 Run service, SDK, and horizontal scaling
**Task Description:** Add a database-backed job queue for starting, resuming, and continuing runs, with leases, retries, and dead-lettering.
**Expected Inputs:** Jobs `{ kind: "start" | "resume" | "continue", runId }`.
**Expected Output:** `packages/store/src/queue/{types.ts,sqlite.ts,postgres.ts,conformance.ts}`, migration `0002_run_queue.sql` for both dialects, `RunQueue` interface, conformance suite.
**Dependencies:** none.
**Items it depends on:** 7.12, 7.6.
**Implementation guidance:**

1. Table `run_queue(job_id, kind, run_id, priority, available_at, attempts, max_attempts, lease_owner, lease_expires_at, idempotency_key UNIQUE NULL, last_error_code, created_at, updated_at)` plus `run_queue_dead` for dead letters.
2. `enqueue(job)`, `claim(workerId, limit, leaseMs)`, `heartbeat(jobId, workerId, leaseMs)`, `complete(jobId, workerId)`, `fail(jobId, workerId, errorCode, retryAfterMs)`, `release(jobId, workerId)` (graceful requeue). Postgres claims with `FOR UPDATE SKIP LOCKED`; SQLite with `BEGIN IMMEDIATE`. Expired leases become claimable again.
3. At most one active job per `runId` (partial unique index on unfinished jobs); enqueuing a duplicate returns the existing job.
4. Failures back off exponentially; after `max_attempts` (default 5) the job moves to `run_queue_dead` with its error code. Rows contain ids and codes only.
**Tests to write:** conformance suite on SQLite and Postgres: claim exclusivity under concurrency (200 iterations, two connections), lease expiry and reclaim, heartbeat extension, backoff, dead-lettering, one-active-job-per-run, idempotency keys.
**Acceptance Criteria:**

- [ ] A job is never held by two workers at once.
- [ ] Crashed workers' jobs are reclaimed after lease expiry.
- [ ] Queue rows hold no content.

---

## 24.3 Workers: `harness worker`

**Parent:** #24 Run service, SDK, and horizontal scaling
**Task Description:** Run a pool of workers that claim queue jobs and execute runs, surviving crashes and restarts.
**Expected Inputs:** Queue, runtime config, `--concurrency`.
**Expected Output:** `packages/core/src/worker.ts` (`Worker`), `packages/cli/src/commands/worker.ts`, auto-resume hooks, doctor check `worker_queue_reachable`, docs `docs/workers.md`.
**Dependencies:** none.
**Items it depends on:** 24.2, 2.7, 2.8, 2.9.
**Implementation guidance:**

1. Each worker has an id (`w_<ulid>`), claims up to `concurrency` jobs, heartbeats every `leaseMs / 3`, and runs `runLoop` (start), `resumeRun` (resume), or the continuation flow (continue). A run that suspends or finishes completes its job.
2. Lease loss (heartbeat rejected) aborts the run's controller; the store conflict (2.2) independently prevents stale appends.
3. SIGTERM: stop claiming, let runs reach a safe point and suspend (2.8), then enqueue a `resume` job for each and exit. Work is never lost on deploys.
4. Auto-resume: after `resolveApproval` (2.9) or an input answer (25.5) succeeds, enqueue a `resume` job when `run.autoResume: true` (default true when a queue is configured). The control plane's in-process `RunSupervisor` (18.2) delegates to the queue when one is configured.
5. Metrics: `harness.worker.jobs{outcome}` and `harness.worker.queue_lag_ms` histogram (no ids); update `METRIC_ALLOWLIST`.
**Tests to write:** worker runs a queued start job to completion with fakes; crash simulation (stop heartbeats) leads to reclaim by a second worker and exactly-once non-idempotent tool execution; SIGTERM requeues suspended runs; auto-resume after approval; concurrency limit respected.
**Acceptance Criteria:**

- [ ] Runs survive worker crashes and deploys without duplicate side effects.
- [ ] Approved runs resume automatically when a queue is configured.
- [ ] Worker metrics are bounded.

---

## 24.4 Starting and continuing runs from the control plane

**Parent:** #24 Run service, SDK, and horizontal scaling
**Task Description:** Add control-plane tools to start and continue runs, with scopes, principals, idempotency, and protection against agents spawning runs on their own.
**Expected Inputs:** MCP tool calls `start_run`, `continue_run`.
**Expected Output:** `packages/control-plane/src/tools/{start-run.ts,continue-run.ts}`, scope enforcement, docs update in `docs/control-plane-security.md`.
**Dependencies:** none.
**Items it depends on:** 24.1, 24.2, 18.2, 18.5, 17.9, 2.14.
**Implementation guidance:**

1. `start_run { goal: string (max 8000), metadata?, role?: Code, idempotencyKey?: string }` and `continue_run { runId, goal, metadata? }` require scope `run`. They record `requestedBy = token.<tokenId>` and return `{ runId, status }`.
2. Input is content: it is written as `run_input` through the PII storage boundary (13.8), never logged, and never echoed back.
3. Agents starting runs: when the calling client is model-driven (no app context), require the confirmation gate (18.2) unless `controlPlane.allowAgentStartedRuns: true`. This stops a model connected to the control plane from silently spawning work.
4. Per-token rate limits (18.5) and quotas (24.7) apply before anything is written.
**Tests to write:** start and continue with scope checks; idempotency key; confirmation gate for model-driven clients; quota rejection writes nothing; input never appears in tool output or logs (canary).
**Acceptance Criteria:**

- [ ] MCP clients can start and continue runs with the right scope.
- [ ] Agents cannot start runs without a human or explicit opt-in.
- [ ] Inputs are tokenized at rest and never echoed.

---

## 24.5 Live run updates over MCP and the SDK

**Parent:** #24 Run service, SDK, and horizontal scaling
**Task Description:** Push run progress to control-plane clients and SDK users instead of polling, with content-free payloads.
**Expected Inputs:** Store subscriptions (7.14), gateway progress (14.16).
**Expected Output:** MCP resources `harness://runs` and `harness://runs/<runId>` with subscribe support, `get_run { sinceSeq }` deltas, progress notifications for long `start_run` calls, console (18.3) switched to subscriptions, SDK `watch` wiring.
**Dependencies:** `@modelcontextprotocol/server` (v2: `subscriptions/listen` support and `notify.resourceUpdated(uri)`; verify names).
**Items it depends on:** 7.14, 18.3, 24.1, 14.16.
**Implementation guidance:**

1. Resource reads return metadata (`RunView`, recent `SafeEvent`s). MCP 2026-07-28 replaced `resources/subscribe` with `subscriptions/listen`: clients open one listen stream opting in to `resourceSubscriptions`, and the server sends resource-updated notifications tagged with the subscription id when new events arrive; clients re-read with `sinceSeq` to get only new safe events. For 2025-11-25 clients the SDK's legacy handling serves the older subscription methods.
2. Model progress (output token counts) is relayed as MCP progress notifications when the client supplied a progress token.
3. The run console replaces its 5 s polling with subscriptions and keeps polling as a fallback when subscriptions are unsupported.
4. Fan-out is bounded per client (max subscriptions per session, default 50) and dropped on disconnect.
**Tests to write:** subscribe and receive updates in order; `sinceSeq` deltas; console updates without polling (fake timers show no interval calls); fallback path; no content in any notification or resource (canary); subscription limits.
**Acceptance Criteria:**

- [ ] Clients see run progress live without polling.
- [ ] Notifications and resources are content-free.
- [ ] Polling remains as a fallback.

---

## 24.6 Multi-replica deployment and the sandbox runner pool

**Parent:** #24 Run service, SDK, and horizontal scaling
**Task Description:** Make multi-instance deployments a validated, tested configuration: Postgres store and vault, several workers, and a pool of sandbox runners.
**Expected Inputs:** Deployment config, compose and Kubernetes assets.
**Expected Output:** config `deployment.mode: "single" | "multi"`, startup validation, `instances` heartbeat table, `RunnerPool` in `packages/sandbox/src/runner-pool.ts`, compose `prod-like` profile with 2 workers and 2 runners, updated `infra/k8s` examples, `test/multi-worker.int.test.ts`, docs `docs/deployment.md` section "Scaling".
**Dependencies:** Docker.
**Items it depends on:** 24.3, 12.9, 19.5, 19.8.
**Implementation guidance:**

1. `multi` mode requires the Postgres store (7.6), the Postgres vault (12.9), and the queue. Startup fails with `deployment_requires_postgres` otherwise. In `single` mode, an `instances` table (id, heartbeat) detects a second live instance on the same SQLite files and refuses to start (`deployment_single_instance_violation`).
2. `RunnerPool`: config `sandbox.runners: { url, token: SecretRef }[]`. Acquire a runner by trying leases (19.5) in random order; a busy runner (409) is skipped. Health checks remove failing runners temporarily. A run keeps its runner for its lifetime; on resume it may get a different runner and restores its workspace from the snapshot (19.6).
3. Compose `prod-like`: `harness-worker` with 2 replicas, 2 `sandbox-runner` services, a shared workspaces volume, and the control plane. Kubernetes examples: worker Deployment, runner Deployment, NetworkPolicies from 10.4 extended.
4. Integration test: two workers and two runners against Postgres; kill one worker mid-run (`docker kill`); the other reclaims the job after lease expiry and finishes; the non-idempotent fake tool executed exactly once; the sentinel and vault work across instances.
**Tests to write:** startup validation table; runner pool acquisition, busy skip, and health eviction; the multi-worker integration test; compose security linter (19.8) passes the new profile.
**Acceptance Criteria:**

- [ ] Multi-instance deployments run on Postgres with several workers and runners.
- [ ] Killing a worker loses no run and duplicates no side effect.
- [ ] Unsupported topologies are refused at startup.

---

## 24.7 Quotas and spending limits across runs

**Parent:** #24 Run service, SDK, and horizontal scaling
**Task Description:** Enforce cost and concurrency limits across runs per principal or role, not just per run.
**Expected Inputs:** Config `quotas`, usage from model responses, principals (17.9).
**Expected Output:** quotas config fragment, `usage_ledger` table and migration, `QuotaService` in `packages/core/src/quotas.ts`, `budget` enum value `quota` on `budget_exceeded`, exit code 9 mapping, metrics, docs `docs/quotas.md`.
**Dependencies:** none.
**Items it depends on:** 24.2, 2.12, 14.14, 17.9.
**Implementation guidance:**

1. Config: `quotas: { id: Code, match: { requestedBy?: Code[], role?: Code[] }, dailyCostUsd?, monthlyCostUsd?, maxConcurrentRuns?, maxRunsPerHour? }[]`. A run is charged to every quota it matches.
2. Ledger: `usage_ledger(quota_id, period_start, cost_micros, runs_started)` updated in the same transaction as the `model_response` append (store method `appendWithUsage`), so usage is never lost or double counted.
3. Enforcement points: at enqueue or start (`quota_exceeded`, nothing written, CLI exit code 9) and before each model call (BudgetTracker consults remaining quota; exceeding records `budget_exceeded { budget: "quota" }` and fails the run).
4. Concurrency quotas count runs in `running` status per quota, checked at claim time by workers (24.3).
5. Metrics: `harness.quota.rejections{quota}` where `quota` is a config-bounded Code; no principal ids on metrics.
**Tests to write:** daily and monthly windows with a fake clock; enqueue rejection; mid-run exhaustion; concurrency limit at claim; ledger consistency under concurrent appends; exit code 9; metrics bounded.
**Acceptance Criteria:**

- [ ] Spending across runs cannot exceed configured limits.
- [ ] Usage accounting is transactional with the events that cause it.
- [ ] Rejections are typed and visible.

---

## 24.8 Performance budgets and soak tests

**Parent:** #24 Run service, SDK, and horizontal scaling
**Task Description:** Measure the cost of the safety layers and the scalability of the store, and fail the nightly build on regressions.
**Expected Inputs:** Benchmark scenarios, baseline results.
**Expected Output:** `bench/` with scenarios, `bench/budgets.json`, `scripts/bench/compare.ts`, nightly pipeline job, `test/soak/long-run.int.test.ts`, docs `docs/performance.md`.
**Dependencies:** `tinybench` (verify license and API).
**Items it depends on:** 24.6, 8.6, 7.6, 13.4, 4.2.
**Implementation guidance:**

1. Scenarios: store append throughput (SQLite and Postgres, batch sizes 1, 10, 100); read and fold of 100,000 events; resume time from a snapshot versus the full log; sentinel cost per span with 1,000, 10,000, and 100,000 vault values (variants on); tokenizer throughput on 1 MiB of mixed text; spans per second through the full allowlist and sentinel pipeline; queue claim throughput with 4 workers.
2. Budgets: `bench/budgets.json` holds absolute ceilings (for example sentinel p95 per span) and relative regression limits (default 20 percent versus the previous nightly artifact). `compare.ts` fails on violations and prints a table. Budgets and benchmark result files have Zod schemas (CONVENTIONS 3.10).
3. Soak test (nightly): a 1,000-step scripted run with compaction, checkpoints, and a worker restart every 100 steps; assert completion, bounded heap growth between checkpoints (heap snapshot delta under a threshold), and resume time under budget.
4. Benchmarks run on a fixed agent pool; results are published as artifacts and never block PRs (nightly only).
**Tests to write:** compare script unit tests (absolute and relative budgets, missing baseline); the soak test itself; scenario smoke runs in the unit stage with tiny sizes.
**Acceptance Criteria:**

- [ ] The overhead of each safety layer is measured and tracked.
- [ ] Regressions beyond budget fail the nightly build.
- [ ] Long runs stay within memory and resume-time budgets.

---

## 24.9 Shared rate-limit store: `RateLimitStore` port with in-process and Postgres backends

**Parent:** #24 Run service and scaling
**Task Description:** Make rate limits hold across replicas. Today the provider limiter (14.12) and the control plane's per-token limit (18.5) keep their token buckets in process memory, so N replicas allow N times the configured rate and providers still return 429. Introduce one `RateLimitStore` port that both use, with an in-process backend (default, unchanged behavior) and a Postgres backend that needs no new infrastructure.
**Expected Inputs:** Limit definitions from config (`models.providers[].requestsPerMinute`, `controlPlane.rateLimitPerMinute`), the injected clock, the store's Postgres connection.
**Expected Output:** `packages/core/src/rate-limit/{types.ts,memory.ts,conformance.ts}` (`RateLimitStore`, `InMemoryRateLimitStore`, conformance suite), `packages/store-postgres/src/rate-limit.ts` (`PostgresRateLimitStore`, table `rate_limit_buckets` via the 7.12 migration runner), config fragment `rateLimits: { backend: "memory" | "postgres" | "redis", onUnavailable: "local" | "deny" }`, 14.12 and 18.5 rewired to the port, docs `docs/deployment/rate-limits.md`.
**Dependencies:** none new.
**Items it depends on:** 14.12, 18.5, 24.6, 7.12, 7.15.
**Implementation guidance:**

1. Port: `take(key: Code, limit: { capacity: int, refillPerSecond: number }, cost = 1): Promise<{ allowed: boolean; retryAfterMs: number; remaining: number }>`. Keys are config-bounded codes (`provider.anthropic`, `cp.token.<tokenId>`); never principal names, prompts, or other content. Token ids are already non-secret config ids (18.5).
2. Token bucket semantics are identical across backends: refill is computed from the elapsed time since the last update using the injected clock (in-process) or the database's clock (shared backends, so replicas with skewed clocks agree).
3. Postgres: one row per key, updated with `INSERT ... ON CONFLICT (key) DO UPDATE ... RETURNING` in a single statement, so concurrent replicas never double-spend a token.
4. Failure handling: when the shared backend is unavailable, `onUnavailable: "local"` (default) falls back to the in-process bucket for that replica and emits `harness.rate_limit.degraded{backend}`, while `"deny"` rejects (429 for the control plane, `provider_rate_limited` for models). Document the trade-off.
5. Metrics: `harness.rate_limit.denied{key_kind}` where `key_kind` is `provider` or `control_plane`; never the full key.
6. The conformance suite (in `./testing`, not the main entry) takes a factory and covers: burst up to capacity, refill over time, `retryAfterMs` accuracy, cost greater than 1, and exactly-capacity grants under concurrency from two clients (200 iterations).
**Tests to write:** conformance against in-memory (unit) and Postgres (integration); 14.12 and 18.5 tests unchanged with the in-memory backend; a two-client Postgres test proving the combined rate across "replicas" stays at the configured limit; degraded fallback and `deny` behavior with an injected failing backend.
**Acceptance Criteria:**

- [ ] With the Postgres backend, two replicas together never exceed the configured provider or control-plane rate.
- [ ] Default behavior (in-process backend) is unchanged for single-node deployments.
- [ ] Keys and metrics contain no content or principal identifiers.

---

## 24.10 Redis/Valkey rate-limit backend for multi-replica deployments

**Parent:** #24 Run service and scaling
**Task Description:** Add an optional Redis-protocol backend for `RateLimitStore`, for multi-replica deployments where per-request database round trips for rate limiting are undesirable. Redis is optional infrastructure: single-node and Postgres-only deployments never need it, and the event log stays the only source of truth (nothing in Redis is needed for recovery).
**Expected Inputs:** `rateLimits.backend: "redis"` and `rateLimits.redis: { url: SecretRef, keyPrefix: Code (default "harness"), tls?: boolean }`.
**Expected Output:** `packages/rate-limit-redis` (`RedisRateLimitStore`), a `valkey` service in `infra/compose/docker-compose.test.yml`, an integration conformance run in the Azure `integration` stage (`TEST_REDIS_URL`), a multi-replica compose example `infra/compose/docker-compose.replicas.yml` (two harness replicas, Postgres, Valkey), docs in `docs/deployment/rate-limits.md`.
**Dependencies:** a Redis-protocol client (`iovalkey` or `ioredis`; MIT, verify against 1.7); server image `valkey/valkey` pinned by multi-arch index digest. Use Valkey (BSD-3-Clause) for the test and example infrastructure rather than Redis 7.4+ server images, whose licenses (RSALv2, SSPL, AGPL) conflict with the 1.7 license policy. The client works against either server.
**Items it depends on:** 24.9, 20.3, 22.1.
**Implementation guidance:**

1. The token bucket runs as one Lua script (`EVALSHA`, loaded at startup with an `EVAL` fallback) so take-and-refill is atomic on the server, and uses the server's `TIME` so replica clock skew doesn't matter. Keys are `<keyPrefix>:rl:<key>` with a TTL of twice the full-refill time, so idle buckets expire.
2. Connection: lazy connect, bounded reconnect with backoff, command timeout (default 50 ms). Timeouts and connection errors map to the 24.9 unavailable path (`onUnavailable`), never to an unhandled error.
3. Secrets: the URL (which may include a password) comes from a `SecretRef` (20.3) and never appears in logs, spans, or errors; TLS is supported for managed Redis/Valkey services.
4. The package declares the client as a dependency and `@rovinos/core` (or the SDK, after 21.9) as a peer, matching the adapter packaging rule in 21.9, so users without Redis never install the client.
5. Compose: `valkey` service hardened like Postgres (read-only root, dropped capabilities, loopback-only port, healthcheck `valkey-cli ping`).
6. Multi-replica example: two `harness serve` replicas sharing Postgres and Valkey, with a short doc showing how to verify the combined provider rate limit holds.
**Tests to write:** the 24.9 conformance suite against Valkey in the integration stage (including the 200-iteration two-client concurrency case); script-load fallback; timeout and connection-loss paths use `onUnavailable`; a canary test that the connection URL never appears in errors or logs.
**Acceptance Criteria:**

- [ ] The Redis backend passes the shared `RateLimitStore` conformance suite against Valkey in Azure.
- [ ] Two replicas sharing Valkey never exceed the configured rate.
- [ ] Deployments without `rateLimits.backend: "redis"` install and run no Redis client.

---

## 24.23 Strict spend reservations across concurrent runs

**Parent:** #24 Run service and quotas
**Task Description:** Define the admission and reconciliation contract for reserving estimated model-call spend across matching quotas before dispatch. This is a design task; it does not implement a reservation backend.
**Expected Inputs:** Matching quota identities and periods, a bounded request-cost estimate, provider usage/cost state, retries, worker and store failures.
**Expected Output:** This reservation state machine, transaction contract, failure model, conformance-test plan, and bounded implementation follow-ups.
**Dependencies:** Existing quota ledger (24.7) and the cost-completeness contract (14.25).
**Items it depends on:** 24.7, 14.25, 7.12.

### Guarantee and non-guarantees

Strict reservation mode admits a model call only when one shared, durable transaction can reserve its bounded estimate for every matching cost quota and UTC period. The estimate uses explicit input/output token ceilings and the configured price revision, rounded up to integer micro-dollars; if those inputs cannot produce a finite estimate, admission fails. In that transaction, the store checks `settled accounted cost + outstanding reservations + new reservation <= limit` and records an idempotent reservation for the model-call attempt. `known` and `estimated` settled costs both consume quota headroom; their cost states remain distinct. Concurrent requests against the same quota are serialized by the backend, so they cannot both consume the same unreserved headroom. The reservation and the existing `model_request` record must be durable before any provider request is sent.

This guarantees only that the harness does not admit a call when its recorded cost and reservations exceed the configured limit. It is not a hard provider-billing cap: provider-side tokenization, hidden usage, price changes, and actual charges can exceed an estimate, and a request may be charged even if its response is lost. If complete usage reports cost above the reservation, reconciliation records the full reported cost; the accounted overrun is `max(0, reported cost - reserved amount)` and later calls are rejected while the quota is exhausted. There is no finite bound on the actual provider charge when the estimate is exceeded or usage is unknown. An overrun cannot undo a provider charge, and harness UTC periods need not match provider billing periods. Existing post-response quota behavior remains unchanged unless strict mode is explicitly enabled. Strict mode is fail-closed: unavailable or non-transactional reservation storage, an unknown price, or an estimate without a finite configured upper bound rejects the call before dispatch. It never falls back to a per-process reservation.

Use integer micro-dollars and round reservation estimates up. Persist the pricing revision and UTC quota periods used to calculate each reservation; a pricing change does not rewrite reservations already in flight. If a cost quota cannot be reserved completely, reject the request without dispatch. This mechanism is separate from shared request-rate limiting (24.9, 24.10).

### Reservation and reconciliation state machine

Each reservation has a unique model-call attempt key and transitions atomically:

| From | To | Condition and effect |
| --- | --- | --- |
| absent | `reserved` | Atomically check all matching quotas, record the reservation, and persist the `model_request`; otherwise reject without dispatch. |
| `reserved` | `dispatching` | Persist immediately before the provider call. From this point, a charge may have occurred. |
| `reserved` | `released` | Cancellation or failure proves dispatch did not begin; release its amount. |
| `dispatching` | `settled` | Atomically append the response and usage-ledger update, replace the reservation with its reported cost state, and deduplicate by attempt key. |
| `dispatching` | `uncertain` | A dispatched call loses its response or reports incomplete/unknown cost. Keep the exposure unresolved; lease expiry alone never releases it. |
| `uncertain` | `settled` | A late duplicate or authoritative complete usage result reconciles the same attempt exactly once. |

Duplicate settlement for an attempt is idempotent; a conflicting second response is rejected. Retries after a possibly dispatched attempt use a new attempt key and reservation unless the provider's idempotency contract proves that the original request cannot be charged twice. Expired worker leases trigger recovery, not an automatic refund. An uncertain attempt blocks further strict-mode calls for its affected quota period until complete usage is reconciled or an explicitly audited operator resolution is made. Operator resolution is not evidence of provider billing and does not restore a hard-cap guarantee.

The reservation transition, quota headroom check, event append, and corresponding usage-ledger mutation must share one backend transaction where applicable. In particular, response settlement must extend the existing `appendWithUsage` atomicity rather than update the reservation or ledger after the `model_response` commit. A backend must lock all affected quota-period rows in a stable order or provide equivalent serializable isolation; transaction conflicts may be retried only as a whole bounded transaction. Strict mode rejects on transaction failure and does not make an admission decision from a stale or local-only view.

### Conformance and recovery scenarios

The store conformance suite must cover concurrent reservations at the exact remaining limit (only fitting reservations succeed), cross-quota requests, safe pre-dispatch cancellation/release, cancellation after dispatch, duplicate and conflicting responses, crash before and after the dispatching transition, expired leases, delayed/late responses, backend unavailability, missing or partial pricing/usage, price changes with in-flight reservations, and safe-integer/rounding boundaries. Assert that every retry is idempotent, uncertainty is never silently released, recorded overruns block later calls, and recovery preserves the ledger and reservation state after restart. Run the same contract against each durable backend, including two independent clients for shared-backend concurrency.

### Bounded implementation follow-ups

These are proposed scopes for separately assigned implementation tasks after maintainer approval:

1. Define the reservation schemas, store transaction port, typed failures, reference behavior, and backend-neutral conformance suite.
2. Implement the transaction and recovery contract in the SQLite store, with restart and competing-connection tests.
3. Implement the same contract in Postgres, with row-locking/serialization and competing-worker integration tests. Do not add a Redis dependency.
4. Integrate fail-closed admission and atomic response reconciliation in the core model-call path; add the opt-in strict-mode configuration and model-path tests.
5. Implement worker-death recovery and audited operator resolution for uncertain attempts, with crash/restart tests and user-facing recovery documentation.

Do not change existing event payloads for this design. If implementation later requires an event contract change, use the repository's event-versioning, upcaster, and legacy-fixture rules.

**Tests to write:** Reusable store conformance scenarios above; SQLite and Postgres multi-client races; core integration tests for pre-dispatch rejection, response reconciliation, overrun and uncertain-attempt blocking; crash/restart tests for both sides of the dispatch transition.
**Acceptance Criteria:**

- [ ] The admission guarantee and its provider-billing uncertainty are explicit.
- [ ] Reservation, release, and reconciliation transitions are atomic, idempotent, and recoverable.
- [ ] Fail-closed behavior and the effect of unknown usage, pricing, lease expiry, and backend failure are specified.
- [ ] Implementation is divided into bounded store-contract, SQLite, Postgres, and runtime-integration tasks.

**Design status:** Draft for maintainer approval; this task does not authorize implementation or claim an enforced provider-billing cap.
