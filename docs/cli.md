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
belongs in `packages/schemas/src/cli/<command>.ts` and is documented alongside the command. JSON
mode writes at most one newline-terminated JSON document to stdout; command text and error codes
are sent to stderr.

## Exit codes

These numeric values are stable for scripts and automation:

| Code | Name | Meaning |
| --- | --- | --- |
| `0` | `ok` | Command completed successfully. |
| `1` | `failure` | Unhandled or unmapped failure. |
| `2` | `usage` | Invalid arguments or unknown command. |
| `3` | `config_invalid` | Configuration is invalid. |
| `4` | `policy_denied` | Policy denied an operation, including separation-of-duties denial. |
| `5` | `suspended` | A run is waiting for approval or human input. |
| `6` | `budget_exceeded` | A run exceeded its configured budget. |
| `7` | `not_found_or_resolved` | Approval or input was not found or was already resolved. |
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
| `suspended` | `5` |
| `budget_exceeded` | `6` |
| `not_found_or_resolved`, `approval_not_found`, `approval_already_resolved`, `input_not_found`, `input_already_resolved` | `7` |
| `replay_failed` | `8` |
| `quota_exceeded` | `9` |

