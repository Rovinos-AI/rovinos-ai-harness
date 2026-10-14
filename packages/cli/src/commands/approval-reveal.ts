// SPDX-License-Identifier: Apache-2.0
import type { HarnessConfig } from "@harness/config";
import type { Runtime, RunState } from "@harness/core";
import { HarnessError } from "@harness/schemas";
import type { Event, Id, JsonValue } from "@harness/schemas";
import type { VaultAuditPiiAction } from "@harness/vault";
import type { CliContext } from "../command.js";
import { collectApprovalTokens, revealApprovalTokens } from "./approval-args.js";

interface PendingApprovalReveal {
  readonly runId: Id;
  readonly state: RunState;
  readonly events: readonly Event[];
}

interface ApprovalResolverLease {
  readonly resolver: Pick<Runtime["vault"], "resolveMany"> | undefined;
  close(): void;
}

class ApprovalRevealAuditError extends HarnessError {
  override readonly code = "failure";

  constructor() {
    super("The approval reveal audit could not be recorded.");
  }
}

/** Selects an injected test resolver or the runtime's scope-aware resolver. */
export async function createApprovalResolverLease(
  context: CliContext,
  runtime: Runtime,
  config: HarnessConfig,
): Promise<ApprovalResolverLease> {
  if (context.createVaultResolver !== undefined) {
    const resolver = await context.createVaultResolver(config);
    return {
      resolver,
      close: () => resolver?.close?.(),
    };
  }
  return { resolver: runtime.vault, close: () => undefined };
}

async function recordRevealAudit(
  store: Runtime["store"],
  context: Pick<CliContext, "clock">,
  pending: PendingApprovalReveal,
  actions: readonly VaultAuditPiiAction[],
): Promise<void> {
  if (actions.length === 0) {
    return;
  }
  const lastEvent = pending.events.at(-1);
  if (lastEvent === undefined) {
    return;
  }
  const { APPROVAL_WAIT_SPAN, RunRecorder } = await import("@harness/core");
  const recorder = new RunRecorder(
    store,
    pending.runId,
    lastEvent.segmentId,
    pending.state.nextSeq,
    context.clock,
  );
  await recorder.withStepSpan(APPROVAL_WAIT_SPAN, {}, async () => {
    const recorded = await recorder.recordBatch(actions.map((action) => ({ ...action, v: 1 })));
    const last = recorded.at(-1);
    if (last === undefined) {
      throw new ApprovalRevealAuditError();
    }
    return last;
  });
}

/** Reveals approval arguments through the runtime audit resolver and records its counts. */
export async function revealApprovalArgs(options: {
  readonly context: Pick<CliContext, "clock">;
  readonly resolver: Pick<Runtime["vault"], "resolveMany">;
  readonly store: Runtime["store"];
  readonly pending: PendingApprovalReveal;
  readonly args: JsonValue;
  readonly toolId: string;
}): Promise<JsonValue> {
  const { context, resolver, store, pending, args, toolId } = options;
  const { findTokens, vaultAuditToPiiAction } = await import("@harness/vault");
  const audits: VaultAuditPiiAction[] = [];
  const tokens = new Set<string>();
  collectApprovalTokens(args, tokens, findTokens);
  const values = new Map<string, string>();
  try {
    if (tokens.size > 0) {
      const list = [...tokens];
      const resolved = await resolver.resolveMany(
        pending.runId,
        list,
        {
          boundary: "ui",
          ...(toolId === "unknown" ? {} : { toolId }),
        },
        (audit) => {
          audits.push(vaultAuditToPiiAction(audit));
        },
      );
      list.forEach((token, index) => {
        const value = resolved[index];
        if (value !== undefined) {
          values.set(token, value);
        }
      });
    }
  } finally {
    await recordRevealAudit(store, context, pending, audits);
  }
  return revealApprovalTokens(args, (token) => values.get(token), findTokens);
}
