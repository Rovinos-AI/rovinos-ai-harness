# Epic #24: Run service, SDK, and horizontal scaling

**Goal:** turn the harness from a single-process CLI into a service: a stable programmatic SDK, a durable run queue with workers, run creation and live updates over the control plane, multi-replica deployment, quotas across runs, and performance budgets. Read `docs/engineering/CONVENTIONS.md` first, plus epics 2, 7, 12, 18, and 19.
**Tasks:** 24.1 to 24.8, all size S.

Shared design for this epic:
- **The event log stays the source of truth.** The queue holds only ids and scheduling state. Run input is recorded as `run_created` and `run_input` events (status `pending`) at enqueue time, so no content lives in queue rows.
- **Workers are interchangeable.** Any worker can execute or resume any run. Ownership comes from the queue lease plus the store's `seq` conflict (2.2), so a stale worker can never append after losing a run.
- **Single-instance mode stays supported.** SQLite store and vault with one process remain the default for local use. Multi-instance mode requires Postgres for both and is validated at startup.
- Package `packages/sdk` is the only stable public API (`@harness/sdk`). `createRuntime` and other internals stay internal. The `harness worker` command lives in `packages/cli`; queue tables live in `packages/store`.

---

## 24.1 Public SDK: `@harness/sdk`

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
4. Types are exported from `index.ts` with full TSDoc. Anything not exported is internal. Add an API-extractor-style snapshot test of the public surface (a committed `.d.ts` snapshot) so breaking changes are deliberate and require a major changeset (21.6).
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
**Dependencies:** `@modelcontextprotocol/sdk` resources and subscriptions (verify `resources/subscribe` and update notification names).
**Items it depends on:** 7.14, 18.3, 24.1, 14.16.
**Implementation guidance:**
1. Resource reads return metadata (`RunView`, recent `SafeEvent`s). Subscriptions send `resources/updated` notifications on new events; clients re-read with `sinceSeq` to get only new safe events.
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
2. Budgets: `bench/budgets.json` holds absolute ceilings (for example sentinel p95 per span) and relative regression limits (default 20 percent versus the previous nightly artifact). `compare.ts` fails on violations and prints a table.
3. Soak test (nightly): a 1,000-step scripted run with compaction, checkpoints, and a worker restart every 100 steps; assert completion, bounded heap growth between checkpoints (heap snapshot delta under a threshold), and resume time under budget.
4. Benchmarks run on a fixed agent pool; results are published as artifacts and never block PRs (nightly only).
**Tests to write:** compare script unit tests (absolute and relative budgets, missing baseline); the soak test itself; scenario smoke runs in the unit stage with tiny sizes.
**Acceptance Criteria:**
- [ ] The overhead of each safety layer is measured and tracked.
- [ ] Regressions beyond budget fail the nightly build.
- [ ] Long runs stay within memory and resume-time budgets.
