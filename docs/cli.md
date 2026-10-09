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

## `harness serve`

`serve` keeps the process running until SIGINT or SIGTERM, then exits successfully. With `--json`,
it writes `{"status":"serving"}` once when startup completes.

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

`harness resume <runId>` resumes a suspended or interrupted run from its durable event log and latest
checkpoint. The human and JSON output and exit codes match `harness run`. Resolve a pending approval
through the approval API before resuming.

## `harness inspect`

`harness inspect <runId> [--show-content]` displays the status, step count, token and cost usage,
last checkpoint, pending approval IDs and tool IDs, and up to the last ten event summaries. By
default event summaries contain only their type and sequence number. `--show-content` includes the
stored tokenized event content and writes a `content_may_be_sensitive` warning to stderr.

## Exit codes

These numeric values are stable for scripts and automation:

| Code | Name | Meaning |
| --- | --- | --- |
| `0` | `ok` | Command completed successfully. |
| `1` | `failure` | Unhandled or unmapped failure. |
| `2` | `usage` | Invalid arguments or unknown command. |
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
| `config_invalid` | `3` |
| `policy_denied`, `approver_is_requester` | `4` |
| `suspended`, `run_awaiting_approval` | `5` |
| `budget_exceeded` | `6` |
| `not_found_or_resolved`, `approval_not_found`, `approval_already_resolved`, `approval_run_not_suspended`, `input_not_found`, `input_already_resolved` | `7` |
| `replay_failed` | `8` |
| `quota_exceeded` | `9` |
