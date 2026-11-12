# Performance budgets

The scheduled **Nightly performance budgets** workflow measures the safety-layer cost and service
workloads on the `ubuntu-24.04` GitHub-hosted runner. Pull-request CI does not run benchmarks. The
workflow records CPU model, architecture, CPU count, memory, Node version, and the benchmark sample
configuration with each result artifact.

## Scenarios and limits

`bench/budgets.json` is the source of truth for absolute ceilings/floors and relative regression
limits. The absolute limits are hard guardrails
on every run; they remain active even when there is no prior artifact. The relative limits default
to a 20% regression against the previous nightly result, and do not replace the absolute limits.

Each scenario gets a 200 ms warmup followed by a 1,000 ms measurement window, and must produce at
least 10 samples. The initial limits are intentionally generous operational ceilings rather than a
claim about production latency. Update them only with representative results from the same runner
label and recorded environment.

The benchmark covers:

| Area | Workload |
| --- | --- |
| Event store | SQLite and Postgres append batches of 1, 10, and 100 events; read and fold 100,000 events; full-log versus snapshot-tail resume |
| PII and telemetry | Sentinel p95 scan cost with 1,000, 10,000, and 100,000 vault values and variants enabled; tokenizer throughput on 1 MiB of mixed synthetic text; allowlist sanitization plus sentinel spans/second |
| Queue and SDK | Four concurrent queue claimers; SDK full-history reads, pending-approval lookup over 1,000 suspended runs, and content streaming under backpressure |
| MCP | Selection from a 1,000-tool catalog, repeated invalid-catalog rejection, and mixed text/binary normalization plus workspace artifact offloading |

`yarn test:unit scripts/bench` runs the scenarios at smoke sizes. The nightly runner writes only
validated benchmark metadata and aggregate measurements to the `performance-results` artifact; it
does not upload prompts, tool content, event content, or benchmark input values.

## Long-run soak

The soak test executes 1,000 synthetic steps against SQLite, writes compaction events and snapshots
every 100 steps, and closes/reopens the queue worker connection at each checkpoint. It checks that
used-heap growth between checkpoints stays below 32 MiB and that reading and folding the completed
log stays under 5 seconds.

The test is `test/soak/long-run.int.test.ts` and is enabled only with
`RUN_PERFORMANCE_SOAK=1`; the GitHub Actions `integration` project classifies the test, but its
ordinary pull-request run skips the long soak. The nightly workflow opts in explicitly.

## CI mapping and baseline behavior

**(verify)** The task specification refers to an Azure stage, but the repository now uses GitHub
Actions. The soak test maps to the `integration` test project/job; the scheduled benchmark and soak
workflow is separate from required pull-request checks. `ubuntu-24.04` is the fixed runner label.
CPU details are recorded because hosted hardware can vary behind that label.

The first scheduled result can bootstrap relative comparisons with
`--allow-missing-baseline`; absolute budgets still apply. Later runs download the prior
`performance-results` artifact and fail if either an absolute limit or a relative regression is
violated. Artifacts are retained for 30 days.
