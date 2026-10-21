// SPDX-License-Identifier: Apache-2.0
import { Code } from "@harness/schemas";

/** Stable process exit codes exposed by the harness CLI. */
export const ExitCode = {
  ok: 0,
  failure: 1,
  usage: 2,
  configInvalid: 3,
  policyDenied: 4,
  suspended: 5,
  budgetExceeded: 6,
  notFoundOrResolved: 7,
  replayFailed: 8,
  quotaExceeded: 9,
} as const;

/** Numeric exit-code type returned by {@link ExitCode}. */
export type ExitCode = (typeof ExitCode)[keyof typeof ExitCode];

/** The only mapping from harness error codes to CLI exit codes. */
export const ERROR_EXIT_CODES: Readonly<Record<string, ExitCode>> = Object.freeze({
  usage: ExitCode.usage,
  confirmation_required: ExitCode.usage,
  edit_invalid: ExitCode.usage,
  edit_not_allowed: ExitCode.usage,
  serve_options_invalid: ExitCode.usage,
  serve_port_invalid: ExitCode.usage,
  worker_concurrency_invalid: ExitCode.usage,
  stdio_json_unsupported: ExitCode.usage,
  approval_edit_unavailable: ExitCode.failure,
  key_rotation_incomplete: ExitCode.failure,
  reveal_unavailable: ExitCode.failure,
  policy_test_mismatch: ExitCode.failure,
  policy_lint_failed: ExitCode.failure,
  policy_test_ids_duplicate: ExitCode.failure,
  policy_expectations_ids_duplicate: ExitCode.failure,
  doctor_failed: ExitCode.failure,
  approval_sweep_partial: ExitCode.failure,
  migration_checksum_mismatch: ExitCode.failure,
  schema_newer_than_code: ExitCode.failure,
  migration_set_invalid: ExitCode.failure,
  schema_migration_pending: ExitCode.failure,
  retention_not_configured: ExitCode.failure,
  retention_hook_failed: ExitCode.failure,
  run_input_missing: ExitCode.failure,
  run_already_terminal: ExitCode.failure,
  run_not_terminal: ExitCode.failure,
  continuation_chain_too_long: ExitCode.failure,
  cancel_conflict: ExitCode.failure,
  config_invalid: ExitCode.configInvalid,
  policy_denied: ExitCode.policyDenied,
  approver_is_requester: ExitCode.policyDenied,
  suspended: ExitCode.suspended,
  run_awaiting_approval: ExitCode.suspended,
  budget_exceeded: ExitCode.budgetExceeded,
  not_found_or_resolved: ExitCode.notFoundOrResolved,
  approval_not_found: ExitCode.notFoundOrResolved,
  approval_already_resolved: ExitCode.notFoundOrResolved,
  approval_run_not_suspended: ExitCode.notFoundOrResolved,
  input_not_found: ExitCode.notFoundOrResolved,
  input_already_resolved: ExitCode.notFoundOrResolved,
  replay_failed: ExitCode.replayFailed,
  quota_exceeded: ExitCode.quotaExceeded,
});

/**
 * Returns a safe error code without exposing an exception message or value.
 *
 * @param error - A thrown value from command execution.
 * @returns A valid harness code, or `failure` when none is available.
 */
export function errorCodeOf(error: unknown): string {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return "failure";
  }
  const code: unknown = error.code;
  return typeof code === "string" && Code.safeParse(code).success ? code : "failure";
}

/**
 * Maps a harness error code to its stable process exit code.
 *
 * @param code - A validated harness error code.
 * @returns The mapped exit code, or failure for an unlisted code.
 */
export function exitCodeForError(code: string): ExitCode {
  return (
    Object.entries(ERROR_EXIT_CODES).find(([errorCode]) => errorCode === code)?.[1] ??
    ExitCode.failure
  );
}
