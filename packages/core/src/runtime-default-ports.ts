// SPDX-License-Identifier: Apache-2.0
import { HarnessError } from "@harness/schemas";
import type { ModelPort, ToolPort } from "./ports.js";

class ModelNotConfiguredError extends HarnessError {
  readonly code = "model_not_configured";

  constructor() {
    super("No model port is configured.");
  }
}

class ToolNotConfiguredError extends HarnessError {
  readonly code = "tool_not_configured";

  constructor() {
    super("No tool port is configured.");
  }
}

/** Model port returned when the runtime has no configured model provider. */
export const missingModelPort: ModelPort = {
  complete: () => Promise.reject(new ModelNotConfiguredError()),
};

/** Tool port returned when no tool adapter has been configured. */
export const unavailableTool: ToolPort = {
  describe: () => undefined,
  execute: () => Promise.reject(new ToolNotConfiguredError()),
};
