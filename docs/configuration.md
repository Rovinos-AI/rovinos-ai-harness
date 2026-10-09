# Configuration

`@harness/config` loads YAML or JSON, validates it with the shared Zod fragments, and returns a deeply frozen `HarnessConfig`. Unknown keys are rejected. Validation errors identify paths and expected types without including submitted values.

## File selection and environment overrides

The loader selects a config file in this order:

1. The `configPath` option (the CLI's `--config` value).
2. `HARNESS_CONFIG`.
3. `harness.config.yaml` in the current working directory.

Environment values with the `HARNESS__` prefix override file values. Separate nested path segments with double underscores; segments are case-insensitive and underscore-separated names are converted to camel case. For example, `HARNESS__RUN__BUDGETS__MAXSTEPS=50` overrides `run.budgets.maxSteps` with the numeric value `50`. Overrides are merged into the file object before schema validation. Arrays cannot be overridden by environment variables.

`run.budgets.maxSteps` defaults to `200`, and `run.budgets.maxWallClockMs` defaults to `3600000`. Both must be positive integers. `run.budgets.maxCostUsd` is optional and must be a positive number when supplied. Reported model costs are accumulated as integer micro-dollars; responses without cost metadata do not count toward the cost budget. `run.budgets.countSuspendedTime` defaults to `false`; suspended intervals between `suspended` and `running` status events are excluded from the wall-clock budget unless it is set to `true`. The run start time and usage are recovered from the event log, so budgets do not reset on resume.

`run.checkpointEveryEvents` defaults to `20` and must be a positive integer. The run loop writes a checkpoint when that many events have accrued since the previous checkpoint, and always writes one before returning a suspended run.

`run.shutdownGraceMs` defaults to `20000` and must be a positive integer. On SIGTERM or SIGINT, the run aborts in-flight work, suspends at a safe point, and writes a checkpoint before exiting with code 143 or 130. If the grace period expires first, the process attempts a best-effort checkpoint and exits with code 1. Set the container's `stop_grace_period` longer than this value so the container runtime does not terminate the process before graceful shutdown can finish.

Store, model, server, policy, PII, telemetry, and sandbox fragments are strict placeholders until their owning tasks define those schemas. Configuration should contain secret references rather than secret values; secret resolution is covered by task 20.3.
