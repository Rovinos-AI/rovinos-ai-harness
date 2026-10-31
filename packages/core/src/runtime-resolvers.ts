// SPDX-License-Identifier: Apache-2.0
import type { EventStore, RunQueue } from "@rovinos/store";
import { HarnessError } from "@rovinos/schemas";
import type { Runtime, RuntimeComposition } from "./runtime-config.js";
import type { Clock } from "./recorder.js";
import { resolveInput as resolveInputEvent } from "./human-input/resolve.js";
import { resolveApproval as resolveApprovalEvent } from "./approvals.js";
import { withResumeWakeUp } from "./runtime-approval-wake.js";
import { assertRuntimeOwnership } from "./runtime-lifecycle.js";
import type { ToolPort } from "./ports.js";

/** Creates the runtime input resolver with its configured privacy and queue dependencies. */
export function createRuntimeInputResolver(input: {
  readonly store: EventStore;
  readonly clock: Clock;
  readonly pii: RuntimeComposition["pii"];
  readonly queue: RunQueue | undefined;
}): Runtime["resolveInput"] {
  return (runId, requestId, resolution) =>
    resolveInputEvent(input.store, runId, requestId, {
      ...resolution,
      clock: input.clock,
      ...(input.pii === undefined
        ? {}
        : { tokenizer: input.pii.tokenizer, resolver: input.pii.resolver }),
      ...(input.queue === undefined ? {} : { queue: input.queue }),
    });
}

/** Creates the runtime approval resolver with its ownership and resume guarantees. */
export function createRuntimeApprovalResolver(input: {
  readonly options: RuntimeComposition;
  readonly store: EventStore;
  readonly clock: Clock;
  readonly tool: ToolPort;
}): Runtime["resolveApproval"] {
  return (runId, approvalId, decision, resolveOptions) => {
    assertRuntimeOwnership(input.options.instanceHeartbeat?.signal);
    if (
      decision === "edit" &&
      input.options.overrides.tool === undefined &&
      (input.options.config.servers?.length ?? 0) === 0
    ) {
      throw new ApprovalEditUnavailableError();
    }
    return withResumeWakeUp(
      input.options.overrides.queue,
      input.options.config.run.autoResume,
      runId,
      () =>
        resolveApprovalEvent(
          input.store,
          runId,
          approvalId,
          decision,
          resolveOptions?.edits,
          input.clock,
          input.tool,
          resolveOptions?.metadata,
        ),
    );
  };
}

class ApprovalEditUnavailableError extends HarnessError {
  readonly code = "approval_edit_unavailable";

  constructor() {
    super("approval_edit_unavailable");
  }
}
