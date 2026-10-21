# Workers

Run `harness worker` against the same configured store as the run service. The SQLite queue shares
the event-store database; Postgres configurations use the configured Postgres connection. Queue
records contain run IDs and scheduling metadata, while inputs and execution history remain in the
event log.

```sh
harness worker --concurrency 4
```

Concurrency defaults to one and accepts values from 1 to 1000. Each worker claims no more jobs than
its available concurrency slots and renews each lease every third of the lease interval. If a
heartbeat is rejected, the worker aborts the active run; the event store's sequence conflict is an
independent guard against stale writes.

On SIGINT or SIGTERM, the worker stops claiming jobs and asks active runs to suspend at their next
safe point. A suspended job is released back to the queue so another worker can resume it. A crashed
worker's leases expire, making its jobs claimable by another worker. Resume processing relies on the
event log and checkpoint to recover the run rather than data stored in the queue.

When a runtime has a queue, approval resolution schedules a resume job by default. Set
`run.autoResume: false` to disable this behavior. The `harness serve` and `harness worker` commands
open the queue for the configured store. The `worker_queue_reachable` doctor check verifies queue
connectivity with a read-only query.

Worker telemetry contains only bounded job outcomes and queue delay:

- `harness.worker.jobs` with a closed `outcome` value.
- `harness.worker.queue_lag_ms` with no attributes.

Input-answer auto-resume depends on the durable human-input answer flow tracked by
[#243](https://github.com/Rovinos-AI/rovinos-ai-harness/issues/243).
