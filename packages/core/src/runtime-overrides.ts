// SPDX-License-Identifier: Apache-2.0
import { HarnessError } from "@rovinos/schemas";
import type { RuntimeOverrides } from "./runtime-config.js";

class AlreadyTokenizedRequiresReplayPortsError extends HarnessError {
  readonly code = "already_tokenized_requires_replay_ports";

  constructor() {
    super("alreadyTokenized is only available with isolated replay ports.");
  }
}

/** Enforces the isolated-port requirement for already-tokenized replay runs. */
export function assertRuntimeOverrideRequirements(overrides: RuntimeOverrides): void {
  if (
    overrides.alreadyTokenized === true &&
    (overrides.transientVault !== true ||
      overrides.store === undefined ||
      overrides.model === undefined ||
      overrides.tool === undefined)
  ) {
    throw new AlreadyTokenizedRequiresReplayPortsError();
  }
}
