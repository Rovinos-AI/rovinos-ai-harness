// SPDX-License-Identifier: Apache-2.0
import { HarnessError } from "@rovinos/schemas";
import type { ShutdownProcessLike } from "./shutdown.js";

/** Process adapter used to install the runtime shutdown handler. */
export const defaultProcessLike: ShutdownProcessLike = {
  /** Register a process signal listener. */
  on: (signal, listener) => process.on(signal, listener),
  /** Remove a previously registered process signal listener. */
  removeListener: (signal, listener) => process.removeListener(signal, listener),
  /** Read the process exit code. */
  get exitCode(): number | undefined {
    return typeof process.exitCode === "number" ? process.exitCode : undefined;
  },
  /** Set the process exit code when one is provided. */
  set exitCode(code) {
    if (code !== undefined) {
      process.exitCode = code;
    }
  },
  // The shutdown grace deadline must force termination if the active operation does not flush.
  /** Terminate the process after the shutdown grace deadline. */
  exit: (code) => {
    // eslint-disable-next-line n/no-process-exit -- shutdown deadline is the final safety bound
    process.exit(code);
  },
};

/** Error raised when a run cannot recover its stored input. */
export class RunInputMissingError extends HarnessError {
  readonly code = "run_input_missing";

  constructor() {
    super("The run input is unavailable.");
  }
}
