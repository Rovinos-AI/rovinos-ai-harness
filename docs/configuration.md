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

Store, model, server, policy, PII, telemetry, and sandbox fragments are strict schemas owned by their respective packages. `telemetry.sentinel.minValueLength` defaults to `6` and controls the minimum length of vault values included in leak-sentinel scans; shorter values are counted and skipped. The sentinel is enabled by default; `telemetry.sentinel.enabled: false` is accepted only outside production. Configuration should contain secret references rather than secret values; secret resolution is covered by task 20.3.

## Tool policy

`policy.file` selects the YAML or JSON policy document used for tool calls. If
it is omitted, the runtime uses a built-in deny-all policy: every tool call is
denied. `harness doctor` warns with `policy_default_deny` when no policy file
is configured.

For example, configure a policy file alongside `harness.config.yaml`:

```yaml
policy:
  file: ./policy.yaml
```

The smallest useful allow policy is explicit about the tool it permits; replace
`my.read_only_tool` with an actual tool ID:

```yaml
version: 1
defaultDecision: deny
rules:
  - id: allow_read_only
    match:
      tools:
        - my.read_only_tool
    decision: allow
    reason: read_only_operation
```

See [Policy documents](./policy.md) for matching and tokenized-argument details.

Role configuration is a list of role definitions used to override the built-in
`planner`, `worker`, `judge`, and `summarizer` roles. See [Model roles](./roles.md)
for routing, tool, prompt, budget, context-strategy, and result-schema behavior.

`models.enforcement.maxRepairs` defaults to `2` and limits structured-output repair calls after an invalid model response. When the limit is exhausted, the gateway throws `model_output_invalid` with the final issue paths only.

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

Tool arguments remain tokenized unless a `pii.detokenize` entry explicitly
allows the destination tool and argument pointers. JSON Pointers use RFC 6901
escaping; a `*` segment selects array elements only. Unresolvable tokens fail
closed by default; `onUnresolvable: leave` preserves their token text instead.
Every resolution is audited with entity types and counts, not values. For example:

```yaml
pii:
  detokenize:
    - toolId: mail.send
      args:
        - /to
        - /attachments/*/name
      onUnresolvable: fail
```

The `*` segment traverses arrays only; for example, `/headers/*` does nothing
when `headers` is an object.

The conservative safety screen rejects unbounded quantifiers, quantified
groups, alternation, look-around assertions, backreferences, and Unicode property escapes.
It permits fixed atom repetitions up to 256 and at most one optional or
variable bounded repetition per pattern. Patterns are limited to 1024
characters. Rewrite rejected expressions using fixed-width atoms rather than
disabling the screen. Unsafe patterns fail with `pii_pattern_unsafe`; invalid
configuration or regex syntax fails with `pii_pattern_invalid`. Errors never
contain the submitted pattern or detected value.

See [Secret references](./secrets.md) for environment, file, and Key Vault reference forms and resolver behavior.

## PII tokenization

`Tokenizer` applies policy before writing detected values to the vault. JSON
string values are processed without changing structure. Keys remain unchanged:
detected PII in a key with `tokenize`, `redact`, or `block` policy fails the
operation with `pii_key_contains_pii` and per-type counts only, before vault
writes. Keys whose detections are explicitly allowed pass through unchanged.
JSON is limited to depth 64, 2 MiB of serialized UTF-8, and 1,024 string
values and object keys per input.

Tokens are run-scoped. Independent runs may use the same token string; resolve
each token only with its owning run ID. Existing tokens are not scanned again.
Action summaries use policy verbs; convert them with
`toPiiActionEventPayload` before recording canonical `pii_action` events.

## PII tool boundary composition

Task 13.7 adds `PiiToolPort` with structural tool ports (no reverse dependency on core).
Pass an already composed tool override to `createRuntime`:
`Offloading( Pii( Policy( Tools ) ) )`. The runtime does not automatically install
PII protection. Future policy decorators decide on tokenized arguments during
`prepare`, before `PiiToolPort.execute` resolves the configured argument pointers.
Policy authorization must not inspect the raw argument copy passed to execution.

Preparation runs before the durable model response and tool intent. Provider blobs
are omitted when preparation is enabled because opaque blobs can duplicate tool
arguments. Preparation failure records null arguments and a denied tool result;
failed calls are excluded from durable model-response recovery input. Input and
output summaries go through `RunRecorder`. Results are tokenized before previews,
files, or events are written. Detector coverage is not a complete detection guarantee.

Binary execution results use `binary: true` and a JSON numeric byte array validated
by `ToolBinaryPayloadSchema` (integers from 0 through 255). Only this representation
bypasses tokenization; flagged text or objects fail with `pii_input_invalid`.
The outer offloader always offloads binary output, even below its configured
threshold, with an empty preview. Oversized unflagged output still fails with
`pii_input_too_large`. Binary tools must use the composed outer offloader.

Canary checklist for this boundary: integration tests cover every recorded event
(including model responses and checkpoints), allowlisted raw execution, both
boundary summaries, blocked input, detector/vault failures, tokenized offload
files and previews, oversized text rejection, validated binary offloading without
previews, rejected textual binary flags, and an unprotected negative control.
