// SPDX-License-Identifier: Apache-2.0
import type { RuntimeOverrides } from "@rovinos/core";
import type { HarnessOverrides } from "./types.js";

function storageOverrides(
  options: HarnessOverrides,
): Pick<
  RuntimeOverrides,
  "store" | "dataDir" | "roleConfigDirectory" | "readOnlyStore" | "transientVault"
> {
  return {
    ...(options.store === undefined ? {} : { store: options.store }),
    ...(options.dataDir === undefined ? {} : { dataDir: options.dataDir }),
    ...(options.roleConfigDirectory === undefined
      ? {}
      : { roleConfigDirectory: options.roleConfigDirectory }),
    ...(options.readOnlyStore === undefined ? {} : { readOnlyStore: options.readOnlyStore }),
    ...(options.transientVault === undefined ? {} : { transientVault: options.transientVault }),
  };
}

function dependencyOverrides(
  options: HarnessOverrides,
): Pick<
  RuntimeOverrides,
  "clock" | "ids" | "model" | "providerAdapters" | "secretResolver" | "onKeysWarning"
> {
  return {
    ...(options.clock === undefined ? {} : { clock: options.clock }),
    ...(options.ids === undefined ? {} : { ids: options.ids }),
    ...(options.model === undefined ? {} : { model: options.model }),
    ...(options.providerAdapters === undefined
      ? {}
      : { providerAdapters: options.providerAdapters }),
    ...(options.secretResolver === undefined ? {} : { secretResolver: options.secretResolver }),
    ...(options.onKeysWarning === undefined ? {} : { onKeysWarning: options.onKeysWarning }),
  };
}

function portOverrides(
  options: HarnessOverrides,
): Pick<RuntimeOverrides, "tool" | "policy" | "context" | "scopeRegistry"> {
  return {
    ...(options.tool === undefined ? {} : { tool: options.tool }),
    ...(options.policy === undefined ? {} : { policy: options.policy }),
    ...(options.context === undefined ? {} : { context: options.context }),
    ...(options.scopeRegistry === undefined ? {} : { scopeRegistry: options.scopeRegistry }),
  };
}

function lifecycleOverrides(
  options: HarnessOverrides,
): Pick<RuntimeOverrides, "processLike" | "flushTelemetry"> {
  return {
    ...(options.processLike === undefined ? {} : { processLike: options.processLike }),
    ...(options.flushTelemetry === undefined ? {} : { flushTelemetry: options.flushTelemetry }),
  };
}

/** Convert the validated public runtime adapters into core runtime overrides. */
export function runtimeOverridesFrom(options: HarnessOverrides): RuntimeOverrides {
  return {
    ...storageOverrides(options),
    ...dependencyOverrides(options),
    ...portOverrides(options),
    ...lifecycleOverrides(options),
  };
}
