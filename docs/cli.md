# CLI

The `harness` executable uses a shared command framework. Commands register through
`CommandModule` and receive a validated configuration loader, an output interface, and a clock.
The global options are:

| Option | Description |
| --- | --- |
| `--config <path>` | Load configuration from the specified YAML or JSON file. |
| `--json` | Send human-readable output to stderr and write command results as JSON to stdout. |
| `--log-level <level>` | Set the log level. Defaults to `info`. |
| `--help` | Show help. |
| `--version` | Show the harness version. |

Each command's JSON result is validated against its Zod contract before output. Its JSON Schema
belongs in `packages/schemas/src/cli/<command>.ts` and is documented alongside the command. A
successful command in JSON mode writes exactly one newline-terminated JSON document to stdout;
command text and error codes are sent to stderr.

## `harness keys generate`

Generates a fresh cryptographically random 32-byte key and prints its base64 value. Store it in an
environment variable or secret store; the command never writes files. `--help` includes this
storage guidance. In `--json` mode the key and storage instructions are returned as one
`KeyGenerateResultSchema` document. Treat either output format as secret material.

## `harness keys rotate` and `harness keys retire`

Set `keys.currentKeyId` to the new key before rotating so new writes use the target key. Keep the
old key configured and readable until the rotation and retirement check finish.
`harness keys rotate --to <keyId>` re-encrypts the vault and event store in resumable batches of up to
500 rows; `--vault` or `--store` selects only that adapter, and omitting both selects both. Running
the command again is safe: rows already using the target key are skipped. The command verifies row
counts after each full pass and retries up to three passes if a concurrent write prevented an
optimistic update. If rows still reference other keys, it exits with `key_rotation_incomplete` and
reports the remaining vault and store counts only. Successful output reports processed row counts.
Its JSON result is validated by `KeyRotationResultSchema`.

`harness keys retire <keyId>` checks both stores and fails with `key_in_use` while any encrypted
content or vault lookup still references that key. On success, remove the key reference from
configuration; the command does not edit configuration or delete external secret material. The
current key cannot be retired.

## `harness healthcheck`

`harness healthcheck` checks that the configured local data and vault directories exist, are
directories, and are readable and writable. It does not load configuration or make network calls.
It prints `healthy` on success and returns code `1` with only a safe error code if the check fails.
In `--json` mode it emits one schema-validated status document.

## `harness doctor`

`harness doctor` checks the Node.js version, configuration, secret references, and data-directory
write access. It returns `1` if any check fails; warnings do not fail the command. Human output is a
table of check IDs, statuses, and codes. `--json` returns a schema-validated array; see
[Environment diagnostics](doctor.md) for check details and the registration pattern.

## `harness servers check`

`harness servers check [--server <id>] [--json]` connects to the configured MCP servers, lists their
tools, and reports registered tool IDs, rejected-tool reason codes, negotiated protocol metadata,
MCP Apps support, connection latency, and trace-propagation behavior. `--server` limits the check to
one configured server. It never invokes tools or prints tool descriptions or server-provided text.
Trusted servers with trace propagation disabled are marked with a warning. Unreachable servers or
registry collisions return code `1`; `--json` emits one validated `ServersCheckResultSchema`
document.

## `harness store migrate`

`harness store migrate [--dry-run] [--json]` applies pending, checksummed SQLite or Postgres schema
migrations selected by `store.dialect` (SQLite is the default). A dry run lists pending migration
versions without writing to the database. JSON output has `applied` and `pending` version arrays.
Migration checksum mismatches, a schema newer than this code, invalid migration sets, and pending
migrations in a read-only operation are reported by their store error codes and exit with code `1`.

Postgres uses `store.connectionString`, which must be a secret reference such as
`env:HARNESS_STORE_URL`; the resolved URL is never printed. SQLite uses `harness.db` under
`HARNESS_DATA_DIR` (or the current directory when unset).

## `harness store purge`

`harness store purge [--dry-run] [--json]` applies `store.retention` to terminal runs using the
system clock. It reports `examined`, `purged`, `skippedActive`, and `hookFailures`; a dry run counts
eligible runs without deleting them. Without `store.retention`, it reports `retention_not_configured`
and exits with code `1`. If a vault resolver supplied by the caller exposes `purge(runId)`, it is
called after each deleted run; otherwise no vault hook is used. Hook failures remain visible in the
JSON counts, report `retention_hook_failed`, and exit with code `1`.

## `harness serve`

`harness serve` defaults to MCP over loopback HTTP and stops on SIGINT or SIGTERM. Use
`--http [--port <port>]` to select HTTP explicitly; it prints only the endpoint URL and defaults to
port 3000. Use `--stdio` for MCP over standard input and output; it stops when its input closes or
receives SIGINT or SIGTERM. HTTP mode also accepts `--json`, which writes the validated
`{"status":"serving"}` result to stdout and the endpoint to stderr. JSON mode is not available with
stdio because stdout carries the MCP protocol.

## `harness worker`

`harness worker [--concurrency <n>]` drains the run queue stored alongside the configured event
store. Concurrency defaults to `1` and is limited to `1` through `1000`. Workers stop claiming on
SIGINT or SIGTERM, allow active runs to suspend, and return suspended jobs to the queue. `--json`
prints one `{"status":"worker_started"}` document when the worker begins.

HTTP mode requires at least one configured bearer token and rejects unauthenticated requests before
MCP dispatch. Configure token scopes and secret references as described in
[Control-plane security](control-plane-security.md); stdio remains the trusted local transport.

## `harness run`

`harness run --input <json-file|-> [--fake-model <script.json>]` starts a run. The input file must
contain `{"goal":"..."}` and may include `metadata`, a map from `Code` keys to `Code`, number, or
boolean values. Use `-` to read the input JSON from standard input. Human output is the run ID;
`--json` returns `{"runId":"...","status":"completed"}` (or the resulting run status).

`--fake-model` reads an array of scripted completions. Each entry requires `content`; `toolCalls`,
`usage`, `finishReason`, `provider`, `model`, `latencyMs`, `schemaValid`, `repairAttempts`, and
`providerBlobs` have defaults. For example, `[{"content":"Hello"}]` scripts a single final answer.
The default data directory is the current working directory; set `HARNESS_DATA_DIR` to change it.
The SQLite event log is stored as `harness.db` inside that directory. Provider-backed model and tool
ports are supplied by their owning epics; use `--fake-model` to run without a configured model.

Exit code `0` means completed, `5` means suspended for approval or input, `6` means a budget was
exceeded, and `1` means the run failed.

## `harness resume`

`harness resume <runId> [--fake-model <script.json>]` resumes a suspended or interrupted run from its
durable event log and latest checkpoint. The human and JSON output and exit codes match `harness run`.
Resolve a pending approval through the approval API before resuming. `--fake-model` supplies scripted
completions for an offline resume; its file uses the same format as `harness run --fake-model`.

## `harness continue`

`harness continue <runId> --input <json-file|->` starts a new run with a follow-up input in the same
`{"goal":"..."}` format as `harness run`. By default only completed runs can be continued; set
`run.continuations.allowFromFailed: true` to allow failed runs. The original event log remains
unchanged, and `run_created.continuationOf` links the new run to its source. Continuations branch
independently, so multiple follow-ups to one run do not include each other's messages. Tokens remain
in the shared run scope. `run.continuations.maxChainLength` defaults to 50, and
`run.continuations.inheritBudgets: true` subtracts ancestor usage from the new run's configured
budgets. `harness inspect <runId>` lists direct continuations.

Non-terminal sources report `run_not_terminal`; a chain at its configured limit reports
`continuation_chain_too_long`.

## `harness approvals`

Lists and resolves approvals from the terminal. Any process can resolve an approval; the suspended
run needs no live process. Output carries tokenized values only unless `--reveal` is used.

- `harness approvals list [--run <id>]` prints pending approvals of suspended runs as a table of
  `approvalId`, `runId`, `toolId`, `ruleId`, `ageMs`, and `expiresAt` (`-` when it never expires).
- `harness approvals show <approvalId> [--show-args] [--reveal]` prints metadata. Tokenized
  arguments need `--show-args`. `--reveal` implies `--show-args`, resolves tokens through the
  runtime's scope-aware auditing vault resolver with boundary `ui`, writes
  `reveal_exposes_sensitive_values` to stderr, and appends metadata-only `pii_action` audit events
  (entity counts only) to the run log. It requires configured keys; otherwise it fails with
  `reveal_unavailable`. Only tokens in the approval's run scope can be revealed, including subagent
  approvals resolved through their root run's scope; tokens from other runs remain tokenized.
- `harness approvals approve <approvalId> [--edit <json-file>] [--yes] [--resume]` approves. With
  `--edit`, the file holds the complete replacement (tokenized) arguments; they are validated
  against the rule's editable fields and the tool schema, and the decision is recorded as `edit`.
  Editing requires a caller-supplied PII-aware tool port; default MCP tool-port composition is
  pending tasks 6.3/6.5. Until then `--edit` reports `approval_edit_unavailable` unless a caller
  supplies that port.
- `harness approvals deny <approvalId> [--yes] [--resume]` denies.
- `harness approvals sweep` runs one sweep: approvals at or past expiry are denied and recorded;
  due escalations are written as metadata-only log notifications. Expiry takes precedence when both
  thresholds have elapsed.

Without `--yes`, `approve` and `deny` ask for confirmation when standard input is a terminal. When
there is no TTY they fail with `confirmation_required` (code `2`), so piped or automated decisions
must explicitly include `--yes`. A refusal exits with `confirmation_declined` (code `1`). After
resolving, the command prints `harness resume <runId>`; `--resume` resumes at once and then uses the
`harness resume` exit codes.
`--json` results are `ApprovalListResultSchema`, `ApprovalShowResultSchema`, and
`ApprovalResolveResultSchema` and `ApprovalSweepResultSchema` in
`packages/schemas/src/cli/approvals.ts`; `sweep` returns examined, expired, escalated, and failed
counts.
If any approval fails during a sweep, the result is still printed and the
command exits with `approval_sweep_partial` (code `1`).

Exit codes: `0` completed, `1` failure, `2` usage (including a malformed id), `7` for
`approval_not_found`, `approval_already_resolved`, or a run that is no longer suspended.

## `harness policy`

`harness policy test --policy <file> --calls <jsonl> [--expect <jsonl>] [--explain]`
evaluates one tokenized call fixture per JSONL line without loading configuration, a store, or a
model. Calls have `{ "id", "toolId", "args", "context?" }`; when present, context can contain
`subagent`, `server`, and `app`. Arguments must already contain PII tokens such as `<EMAIL_1>`.
Expectations have `{ "id", "decision", "ruleId?" }`. Missing or mismatched expectations fail with
exit code `1`; without `--expect`, the command only reports the evaluations. `--explain` includes
every matching rule. `--json` emits one validated report.

`harness policy lint --policy <file>` checks for duplicate matchers, fully shadowed rules, allows
covered by denies, missing reasons, and (when tool metadata is supplied to the linter) overly broad
destructive allows and unused editable pointers. Lint errors exit `1`; warnings do not fail. Both
commands operate offline and do not access runtime services. The runnable fixtures in
[`examples/policy-tests`](../examples/policy-tests/) are tested in CI.

## `harness inspect`

`harness inspect <runId> [--show-content]` displays the status, step count, token and cost usage,
last checkpoint, pending approval IDs and tool IDs, and up to the last ten event summaries. By
default event summaries contain only their type and sequence number. `--show-content` includes the
stored event content verbatim and writes a `content_may_be_sensitive` warning to stderr. Until PII
tokenization in tasks 13.4 and 13.7 lands, run goals and event content are stored as provided.

## `harness cancel`

`harness cancel <runId>` appends a cancellation request for a running or suspended run. Human output
is the run ID; `--json` returns `{"runId":"...","status":"cancelled"}`. Cancellation exits with code
`0`; a run that is already terminal reports `run_already_terminal`, and repeated append conflicts
report `cancel_conflict`; both exit with code `1`.

## `harness context`

`harness context <runId> [--strategy naive|sliding_window|summarizing] [--max-tokens N]
[--reserve-output N] [--model provider/model] [--show-content] [--compare a,b] [--json]`
re-derives context
from the stored event log without appending events or calling models. Summarizing uses only
already-recorded compactions; it does not create a new summary.

`--compare a,b` rebuilds the same stored events with the two named strategies and prints their
token estimates, message and drop counts, compacted ranges, retained run/sequence references, and
directional retained-event coverage. The table rounds percentages to one decimal place. With
`--json`, it emits the comparison list and exact coverage fractions as one JSON document.
Context inspection currently supports SQLite only. SQLite is loaded into an in-memory read-only
snapshot without directory creation, schema initialization, metadata writes, or sidecar creation.
If a WAL or rollback-journal sidecar exists, inspection fails rather than returning a potentially
stale or inconsistent snapshot.

Defaults are `naive`, 8,192 maximum tokens, and 1,024 reserved output tokens. The model reference
defaults to the first configured routing default, or `heuristic/default` when none is configured.
Token estimates use the offline heuristic counter; they are not provider-reported usage.

Human output summarizes the strategy and version, message/token counts versus the available budget,
retained/dropped groups, compacted ranges, offloaded handles and byte sizes, and pinned sequences.
JSON output contains metadata: strategy and version, model and budget,
message count, estimated tokens, reconstructed group count, retained and dropped groups,
all recorded compaction sequence ranges, retained offload handles and byte sizes, and pinned
sequences. Neither offload previews nor summaries nor message text are included by default.
The JSON contract is `ContextInspectionSchema` in `packages/schemas/src/cli/context.ts`.

`--show-content` additionally includes the built messages as stored, without detokenization,
and writes `content_may_be_sensitive` to stderr. It assumes the stored run was tokenized at its
storage boundaries; legacy or externally supplied logs may still contain sensitive content.
Unknown strategies list the registered identifiers and exit with code `2`; invalid model
references and token counts also exit with code `2`. Missing runs report `run_not_found` (code `1`).

## Exit codes

These numeric values are stable for scripts and automation:

| Code | Name | Meaning |
| --- | --- | --- |
| `0` | `ok` | Command completed successfully. |
| `1` | `failure` | Unhandled or unmapped failure, a failed doctor check, or cancellation of an already-terminal run. |
| `2` | `usage` | Invalid arguments, unknown command or context strategy, missing non-interactive approval confirmation, or invalid approval edits. |
| `3` | `config_invalid` | Configuration is invalid. |
| `4` | `policy_denied` | Policy denied an operation, including separation-of-duties denial. |
| `5` | `suspended` | A run is waiting for approval or human input, including a resume blocked by unresolved approvals. |
| `6` | `budget_exceeded` | A run exceeded its configured budget. |
| `7` | `not_found_or_resolved` | Approval or input was not found, already resolved, or its run is no longer suspended. |
| `8` | `replay_failed` | Replay failed. |
| `9` | `quota_exceeded` | The configured quota was exceeded. |

The CLI maps error codes to these values in `packages/cli/src/exit-codes.ts`. Unmapped error codes
use exit code `1`. Errors are printed as codes only; exception messages and submitted values are
never included in CLI error output.

## Error-code mapping

| Error code | Exit code |
| --- | --- |
| `usage`, `confirmation_required`, `edit_not_allowed`, `edit_invalid` | `2` |
| `serve_options_invalid`, `serve_port_invalid`, `stdio_json_unsupported`, `worker_concurrency_invalid` | `2` |
| `doctor_failed`, `approval_sweep_partial`, `run_already_terminal`, `run_not_terminal`, `continuation_chain_too_long`, `cancel_conflict` | `1` |
| `approval_edit_unavailable`, `reveal_unavailable` | `1` |
| `migration_checksum_mismatch`, `schema_newer_than_code`, `migration_set_invalid`, `schema_migration_pending`, `retention_not_configured`, `retention_hook_failed` | `1` |
| `config_invalid` | `3` |
| `policy_denied`, `approver_is_requester` | `4` |
| `suspended`, `run_awaiting_approval` | `5` |
| `budget_exceeded` | `6` |
| `not_found_or_resolved`, `approval_not_found`, `approval_already_resolved`, `approval_run_not_suspended`, `input_not_found`, `input_already_resolved` | `7` |
| `replay_failed` | `8` |
| `quota_exceeded` | `9` |
