// SPDX-License-Identifier: Apache-2.0
import type { StartRunOptions } from "./start-run-options.js";

/** Returns the optional prompt-selection field used to start a runtime run. */
export function promptSelectionOption(promptSelections: StartRunOptions["promptSelections"]): {
  readonly promptSelections?: NonNullable<StartRunOptions["promptSelections"]>;
} {
  return promptSelections === undefined ? {} : { promptSelections };
}
