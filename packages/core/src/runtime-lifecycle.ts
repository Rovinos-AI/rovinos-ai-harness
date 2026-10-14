// SPDX-License-Identifier: Apache-2.0
// Runtime lifecycle helpers extracted from runtime.ts (keeps it under the max-lines limit).
import { Code, type Id } from "@harness/schemas";
import { emitVaultMarkTerminalFailed } from "@harness/telemetry";
import type { EventStore } from "@harness/store";
import type { RuntimeComposition, RuntimeOverrides } from "./runtime-config.js";

function terminalMarkFailureCode(error: unknown): Code {
  try {
    if (typeof error === "object" && error !== null) {
      const parsedCode = Code.safeParse(Reflect.get(error, "code"));
      if (parsedCode.success) {
        return parsedCode.data;
      }
    }
  } catch {
    // Error metadata must not prevent the run result from being returned.
  }
  return Code.parse("vault_unavailable");
}

/** Record a terminal run in the vault without failing the run when bookkeeping fails. */
export async function markTerminalBestEffort(
  vault: RuntimeComposition["vault"],
  runId: Id,
  timestamp: number,
): Promise<void> {
  try {
    await vault.markTerminal(runId, timestamp);
  } catch (error) {
    try {
      emitVaultMarkTerminalFailed(runId, terminalMarkFailureCode(error));
    } catch {
      // A diagnostic logger failure must not change the durable run result.
    }
  }
}

/** Flush telemetry and close owned resources, even if an earlier step fails. */
export async function closeRuntimeResources(options: {
  readonly store: EventStore;
  readonly vault: RuntimeComposition["vault"];
  readonly keys: RuntimeComposition["keys"];
  readonly sandboxBackend: RuntimeComposition["sandboxBackend"];
  readonly flushTelemetry?: RuntimeOverrides["flushTelemetry"];
}): Promise<void> {
  try {
    await options.flushTelemetry?.();
  } finally {
    try {
      try {
        await options.sandboxBackend.close?.();
      } finally {
        await options.store.close();
      }
    } finally {
      try {
        options.vault.close();
      } finally {
        options.keys.dispose();
      }
    }
  }
}
