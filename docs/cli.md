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
stored event content verbatim and writes a `content_may_be_sensitive` warning to stderr. Until PII
tokenization in tasks 13.4 and 13.7 lands, run goals and event content are stored as provided.

## `harness cancel`

`harness cancel <runId>` appends a cancellation request for a running or suspended run. Human output
is the run ID; `--json` returns `{"runId":"...","status":"cancelled"}`. Cancellation exits with code
`0`; a run that is already terminal reports `run_already_terminal`, and repeated append conflicts
report `cancel_conflict`; both exit with code `1`.

## `harness context`

`harness context <runId> [--strategy naive|sliding_window|summarizing] [--max-tokens N]
[--reserve-output N] [--model provider/model] [--show-content] [--json]` re-derives context
from the stored event log without appending events or calling models. Summarizing uses only
already-recorded compactions; it does not create a new summary.
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
| `1` | `failure` | Unhandled or unmapped failure, including cancellation of an already-terminal run. |
| `2` | `usage` | Invalid arguments, unknown command, or unknown context strategy. |
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
| `usage` | `2` |
| `run_already_terminal`, `cancel_conflict` | `1` |
| `config_invalid` | `3` |
| `policy_denied`, `approver_is_requester` | `4` |
| `suspended`, `run_awaiting_approval` | `5` |
| `budget_exceeded` | `6` |
| `not_found_or_resolved`, `approval_not_found`, `approval_already_resolved`, `approval_run_not_suspended`, `input_not_found`, `input_already_resolved` | `7` |
| `replay_failed` | `8` |
| `quota_exceeded` | `9` |
