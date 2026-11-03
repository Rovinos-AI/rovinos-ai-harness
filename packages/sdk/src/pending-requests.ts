// SPDX-License-Identifier: Apache-2.0
import { foldRunState, type Runtime } from "@rovinos/core";
import type { Id } from "@rovinos/schemas";
import { readEvents } from "./event-views.js";
import {
  ApprovalDecisionSchema,
  ApprovalIdInputSchema,
  ApprovalResolutionResultSchema,
  AnswerInputOptionsSchema,
  InputResolutionResultSchema,
  RequestIdInputSchema,
  ResolveApprovalOptionsSchema,
  SdkError,
  type AnswerInputOptions,
  type ApprovalDecision,
  type ApprovalResolutionResult,
  type InputResolutionResult,
  type ResolveApprovalOptions,
} from "./types.js";

/**
 * Finds a suspended run for an approval by streaming its log.
 *
 * This lookup is O(suspended runs × events) until the store exposes a direct approval index.
 */
export async function findPendingApprovalRun(
  runtime: Runtime,
  approvalId: Id,
): Promise<Id | undefined> {
  let cursor: string | undefined;
  do {
    const page = await runtime.store.listRuns({
      status: "suspended",
      limit: 100,
      ...(cursor === undefined ? {} : { cursor }),
    });
    for (const summary of page.runs) {
      let requested = false;
      let resolved = false;
      for await (const event of runtime.store.read(summary.runId)) {
        if (event.type === "approval_requested" && event.approvalId === approvalId) {
          requested = true;
        } else if (event.type === "approval_resolved" && event.approvalId === approvalId) {
          resolved = true;
        }
      }
      if (requested && !resolved) {
        return summary.runId;
      }
    }
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  return undefined;
}

/** Finds the unique suspended run that owns a pending input request. */
export async function findPendingInputRun(
  runtime: Runtime,
  requestId: Id,
): Promise<Id | undefined> {
  let cursor: string | undefined;
  let foundRunId: Id | undefined;
  do {
    const page = await runtime.store.listRuns({
      status: "suspended",
      limit: 100,
      ...(cursor === undefined ? {} : { cursor }),
    });
    for (const summary of page.runs) {
      if (!foldRunState(await readEvents(runtime, summary.runId)).pendingInputs.has(requestId)) {
        continue;
      }
      if (foundRunId !== undefined && foundRunId !== summary.runId) {
        throw new SdkError("sdk_input_ambiguous");
      }
      foundRunId = summary.runId;
    }
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  return foundRunId;
}

/** Resolves a pending approval in its suspended run. */
export async function resolvePendingApproval(
  runtime: Runtime,
  approvalId: string,
  decision: ApprovalDecision,
  options: ResolveApprovalOptions,
): Promise<ApprovalResolutionResult> {
  const parsedApprovalId = ApprovalIdInputSchema.parse({ approvalId }).approvalId;
  const parsedDecision = ApprovalDecisionSchema.parse(decision);
  const parsedOptions = ResolveApprovalOptionsSchema.parse(options);
  const runId = await findPendingApprovalRun(runtime, parsedApprovalId);
  if (runId === undefined) {
    throw new SdkError("sdk_run_not_found");
  }
  await runtime.resolveApproval(runId, parsedApprovalId, parsedDecision, {
    ...(parsedOptions.edits === undefined ? {} : { edits: parsedOptions.edits }),
    metadata: { decidedBy: "human", approverId: parsedOptions.principal },
  });
  return ApprovalResolutionResultSchema.parse({
    runId,
    approvalId: parsedApprovalId,
    decision: parsedDecision,
  });
}

/** Resolves a pending input request in its suspended run. */
export async function answerPendingInput(
  runtime: Runtime,
  requestId: string,
  options: AnswerInputOptions,
): Promise<InputResolutionResult> {
  const parsedRequestId = RequestIdInputSchema.parse({ requestId }).requestId;
  const parsedOptions = AnswerInputOptionsSchema.parse(options);
  const runId = await findPendingInputRun(runtime, parsedRequestId);
  if (runId === undefined) {
    throw new SdkError("sdk_run_not_found");
  }
  const resolution = await runtime.resolveInput(runId, parsedRequestId, {
    action: parsedOptions.action,
    ...(parsedOptions.content === undefined ? {} : { answer: parsedOptions.content }),
    principal: parsedOptions.principal,
  });
  return InputResolutionResultSchema.parse({
    runId,
    requestId: resolution.requestId,
    action: resolution.action,
  });
}
