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

Store, model, server, policy, PII, telemetry, and sandbox fragments are strict schemas owned by their respective packages. `telemetry.sentinel.minValueLength` defaults to `6` and controls the minimum length of vault values included in leak-sentinel scans; shorter values are counted and skipped. Configuration should contain secret references rather than secret values; secret resolution is covered by task 20.3.

## PII detectors and custom identifiers

`@harness/pii` exports synchronous detectors for email, phone, credit cards,
IBANs, IPv4/IPv6, AWS/GitHub keys, JWT-shaped strings, private-key opening
markers, and URL credentials. Credit cards require Luhn validation; IBANs
require a known country length and mod-97 validation. Detection is imperfect:
these are simplified formats, not comprehensive coverage of sensitive text.
JWT detection checks shape, not signature or authenticity. Private-key detection
marks the opening header, not the entire PEM body.

Detector results contain only entity codes, confidence, detector IDs, and
UTF-16 offsets (`start` inclusive, `end` exclusive). Slice the original text
with these offsets; do not convert them to Unicode code-point offsets.
`resolveOverlaps` returns sorted, non-overlapping ranges, preferring length,
then confidence, then lexically lower detector ID. Overlap chains are resolved
in start order against the last retained range; discarded ranges are not restored.

No national-ID patterns are built in. Configure an application-specific
custom entry, then compile it once with `createCustomDetector`. For example,
this synthetic format can be replaced with the bounded format appropriate
to your jurisdiction:

```yaml
pii:
  custom:
    - name: national_id_example
      pattern: '\bID-\d{8}\b'
```

The resulting entity code is `custom_national_id_example`; select that code
in PII policy rules. Custom matches preserve the exact original substring.
Optional `flags` supports `i`, `m`, `s`, and `u`; global Unicode scanning is
always enabled. Optional `validator` is `luhn` or `mod97` (IBAN-style rotation
of the first four characters).

The conservative safety screen rejects unbounded quantifiers, quantified
groups, alternation, look-around assertions, backreferences, and Unicode property escapes.
It permits fixed atom repetitions up to 256 and at most one optional or
variable bounded repetition per pattern. Patterns are limited to 1024
characters. Rewrite rejected expressions using fixed-width atoms rather than
disabling the screen. Unsafe patterns fail with `pii_pattern_unsafe`; invalid
configuration or regex syntax fails with `pii_pattern_invalid`. Errors never
contain the submitted pattern or detected value.

See [Secret references](./secrets.md) for environment, file, and Key Vault reference forms and resolver behavior.
