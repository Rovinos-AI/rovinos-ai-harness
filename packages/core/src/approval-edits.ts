// SPDX-License-Identifier: Apache-2.0
import { HarnessError, type Event, type Id, type JsonValue } from "@harness/schemas";
import {
  ApprovalEditError,
  ApprovalPayloadSchema,
  approvalEditsAreAllowed,
  diffToEdits,
  validateEdits,
} from "@harness/policy";
import type { ToolPort } from "./ports.js";
import type { RunRecorder } from "./recorder.js";
import { prepareToolCall, toolRunContext } from "./steps/prepare-tool.js";
import { ApprovalEditNotAllowedError, ApprovalEditsRequiredError } from "./steps/resume-errors.js";
import type { ApprovalRequestedEvent, ToolIntentEvent } from "./run-state.js";

/** Restores only replacement arguments authorized by the original approval payload. */
export function approvedArgs(
  intent: ToolIntentEvent,
  approval: ApprovalRequestedEvent,
  resolution: Extract<Event, { type: "approval_resolved" }>,
): JsonValue {
  if (resolution.decision !== "edit") {
    return intent.args;
  }
  if (resolution.edits === undefined) {
    throw new ApprovalEditsRequiredError();
  }
  const payload = ApprovalPayloadSchema.safeParse(approval.payload);
  if (
    !payload.success ||
    payload.data.callId !== intent.callId ||
    !approvalEditsAreAllowed(payload.data, diffToEdits(intent.args, resolution.edits))
  ) {
    throw new ApprovalEditNotAllowedError();
  }
  return resolution.edits;
}

/** Safe failure raised when approval edits cannot pass through the PII-aware tool port. */
export class ApprovalEditPreparationError extends HarnessError {
  readonly code = "pii_prepare_failed";

  constructor() {
    super("Approval edits require a PII-aware tool port.");
  }
}

interface PrepareApprovalEditOptions {
  readonly tool: ToolPort;
  readonly approval: Extract<Event, { type: "approval_requested" }>;
  readonly intent: Extract<Event, { type: "tool_intent" }>;
  readonly edits: JsonValue;
  readonly runId: Id;
  readonly recorder: RunRecorder;
  readonly events: Event[];
}

/** Validates, tokenizes, and prepares edits to an approval payload. */
export async function prepareApprovalEdits(
  options: PrepareApprovalEditOptions,
): Promise<JsonValue> {
  const { tool, approval, intent, edits, runId, recorder, events } = options;
  const parsedPayload = ApprovalPayloadSchema.safeParse(approval.payload);
  if (
    !parsedPayload.success ||
    parsedPayload.data.callId !== intent.callId ||
    parsedPayload.data.toolId !== intent.toolId
  ) {
    throw new ApprovalEditError("edit_invalid");
  }
  const pointerEdits = diffToEdits(parsedPayload.data.args, edits);
  const context = toolRunContext({ runId, signal: new AbortController().signal }, recorder, events);
  const validateSchema =
    tool.validateInputSchema === undefined
      ? undefined
      : (args: JsonValue, schema: JsonValue) =>
          tool.validateInputSchema?.(intent.toolId, args, schema, context) ??
          Promise.resolve(false);
  return validateEdits(
    parsedPayload.data,
    pointerEdits,
    tool.describe(intent.toolId, intent.args)?.inputSchema,
    {
      tokenize: async (args) => {
        const prepared = await prepareToolCall(
          tool,
          { callId: approval.callId, toolId: intent.toolId, args },
          context,
        );
        if (prepared.errorCode !== undefined) {
          throw new ApprovalEditPreparationError();
        }
        return prepared.call.args;
      },
      ...(validateSchema === undefined ? {} : { validateSchema }),
    },
  );
}
