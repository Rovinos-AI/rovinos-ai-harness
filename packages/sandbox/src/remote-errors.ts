// SPDX-License-Identifier: Apache-2.0
import { HarnessError } from "@harness/schemas";

/** Error reported when an authenticated remote runner request fails. */
export class RemoteSandboxError extends HarnessError {
  readonly code:
    | "sandbox_unavailable"
    | "sandbox_busy"
    | "sandbox_timeout"
    | "sandbox_runner_config_invalid"
    | "snapshot_too_large";

  constructor(
    code:
      | "sandbox_unavailable"
      | "sandbox_busy"
      | "sandbox_timeout"
      | "sandbox_runner_config_invalid"
      | "snapshot_too_large",
  ) {
    super("The remote sandbox request failed.");
    this.code = code;
  }
}
