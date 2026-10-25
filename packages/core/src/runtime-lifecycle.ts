// SPDX-License-Identifier: Apache-2.0
// Runtime lifecycle helpers extracted from runtime.ts (keeps it under the max-lines limit).
import { Code, type Event, type Id } from "@rovinos/schemas";
import { emitVaultMarkTerminalFailed } from "@rovinos/telemetry";
import type { SandboxBackend } from "@rovinos/sandbox";
import type { EventStore } from "@rovinos/store";
import type { RuntimeComposition, RuntimeOverrides } from "./runtime-config.js";
import { inspectCancellationTail } from "./runtime-cancellation.js";
import { LeaseLostError } from "./recorder.js";
import { DeploymentStartupError } from "./runtime-deployment.js";
import { appApprovalContext } from "./app-approval-context.js";
import { foldRunState, type RunState } from "./run-state.js";
import type { RunLoopResult } from "./loop.js";

/** Throws after this process loses ownership of a guarded SQLite runtime. */
export function assertRuntimeOwnership(signal: AbortSignal | undefined): void {
  if (
    signal !== undefined &&
    signal.aborted &&
    signal.reason === "deployment_single_instance_violation"
  ) {
    throw new DeploymentStartupError("deployment_single_instance_violation");
  }
}

function isAppSuspension(state: RunState, events: readonly Event[]): boolean {
  return (
    state.status === "suspended" &&
    [...state.pendingApprovals.values()].some((approval) => {
      const intent = state.pendingToolCalls.get(approval.callId);
      return intent !== undefined && appApprovalContext(intent, events) !== undefined;
    })
  );
}

/** Recovers only a verified durable cancellation or app suspension after a writer loses its lease. */
export async function readRuntimeControlResult(
  options: { readonly store: EventStore; readonly runId: Id; readonly firstNewSeq: number },
  reason: "cancelled" | "app_approval",
): Promise<RunLoopResult | undefined> {
  const events: Event[] = [];
  for await (const event of options.store.read(options.runId)) {
    events.push(event);
  }
  const state = foldRunState(events);
  const matches =
    reason === "cancelled" ? state.status === "cancelled" : isAppSuspension(state, events);
  if (!matches) {
    return undefined;
  }
  return {
    status: state.status,
    approvalIds: Array.from(state.pendingApprovals.keys()),
    state,
    events: events.filter((event) => event.seq >= options.firstNewSeq),
  };
}

/** Recovers durable control events after a run loses its event-store lease. */
export async function recoverRunControlError(options: {
  readonly error: unknown;
  readonly store: EventStore;
  readonly runId: Id;
  readonly firstNewSeq: number;
  readonly nextSeq: number;
  readonly cancellationObserved: boolean;
  readonly controller: AbortController;
  readonly ownershipSignal?: AbortSignal;
}): Promise<{
  readonly result: RunLoopResult | undefined;
  readonly cancellationObserved: boolean;
}> {
  assertRuntimeOwnership(options.ownershipSignal);
  let nextSeq = options.nextSeq;
  let cancellationObserved = options.cancellationObserved;
  if (options.error instanceof LeaseLostError) {
    await inspectCancellationTail({
      store: options.store,
      runId: options.runId,
      fromSeq: nextSeq,
      controller: options.controller,
      onCursor: (value) => {
        nextSeq = value;
      },
      onCancellation: () => {
        cancellationObserved = true;
      },
    });
  }
  assertRuntimeOwnership(options.ownershipSignal);
  let result: RunLoopResult | undefined;
  if (cancellationObserved) {
    result = await readRuntimeControlResult(
      { store: options.store, runId: options.runId, firstNewSeq: options.firstNewSeq },
      "cancelled",
    );
  } else if (options.error instanceof LeaseLostError) {
    result = await readRuntimeControlResult(
      { store: options.store, runId: options.runId, firstNewSeq: options.firstNewSeq },
      "app_approval",
    );
  }
  return { result, cancellationObserved };
}

/** Runs an operation while holding the backend's optional run-scoped lease. */
export async function withSandboxLease<T>(
  backend: SandboxBackend | undefined,
  runId: Id,
  operation: () => Promise<T>,
): Promise<T> {
  await backend?.acquireLease?.(runId);
  try {
    return await operation();
  } finally {
    try {
      await backend?.releaseLease?.(runId);
    } catch {
      // Lease cleanup must not replace a durable run outcome.
    }
  }
}

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

/** Close sandbox resources while guaranteeing backend cleanup is attempted. */
async function closeSandboxResources(options: {
  readonly closeToolPort?: () => Promise<void>;
  readonly sandboxBackend: RuntimeComposition["sandboxBackend"];
}): Promise<void> {
  try {
    await options.closeToolPort?.();
  } finally {
    await options.sandboxBackend.close?.();
  }
}

/** Close durable runtime resources while guaranteeing remaining cleanup is attempted. */
async function closeStorageResources(options: {
  readonly store: EventStore;
  readonly vault: RuntimeComposition["vault"];
  readonly keys: RuntimeComposition["keys"];
  readonly instanceHeartbeat: RuntimeComposition["instanceHeartbeat"];
}): Promise<void> {
  try {
    await options.store.close();
  } finally {
    try {
      await options.vault.close();
    } finally {
      try {
        await options.instanceHeartbeat?.close();
      } finally {
        options.keys.dispose();
      }
    }
  }
}

/** Flush telemetry and close owned resources, even if an earlier step fails. */
export async function closeRuntimeResources(options: {
  readonly store: EventStore;
  readonly closeToolPort?: () => Promise<void>;
  readonly vault: RuntimeComposition["vault"];
  readonly keys: RuntimeComposition["keys"];
  readonly sandboxBackend: RuntimeComposition["sandboxBackend"];
  readonly instanceHeartbeat: RuntimeComposition["instanceHeartbeat"];
  readonly flushTelemetry?: RuntimeOverrides["flushTelemetry"];
}): Promise<void> {
  try {
    await options.flushTelemetry?.();
  } finally {
    try {
      await closeSandboxResources(options);
    } finally {
      await closeStorageResources(options);
    }
  }
}
