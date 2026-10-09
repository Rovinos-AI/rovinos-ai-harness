# Configuration

`@harness/config` loads YAML or JSON, validates it with the shared Zod fragments, and returns a deeply frozen `HarnessConfig`. Unknown keys are rejected. Validation errors identify paths and expected types without including submitted values.

## File selection and environment overrides

The loader selects a config file in this order:

1. The `configPath` option (the CLI's `--config` value).
2. `HARNESS_CONFIG`.
3. `harness.config.yaml` in the current working directory.

Environment values with the `HARNESS__` prefix override file values. Separate nested path segments with double underscores; segments are case-insensitive and underscore-separated names are converted to camel case. For example, `HARNESS__RUN__BUDGETS__MAXSTEPS=50` overrides `run.budgets.maxSteps` with the numeric value `50`. Overrides are merged into the file object before schema validation. Arrays cannot be overridden by environment variables.

`run.budgets.maxSteps` defaults to `200`, and `run.budgets.maxWallClockMs` defaults to `3600000`. Both must be positive integers. `run.budgets.maxCostUsd` is optional and must be a positive number when supplied.

Store, model, server, policy, PII, telemetry, and sandbox fragments are strict placeholders until their owning tasks define those schemas. Configuration should contain secret references rather than secret values; secret resolution is covered by task 20.3.
