// SPDX-License-Identifier: Apache-2.0
import { HarnessError, type Code, type Event, type Principal } from "@rovinos/schemas";
import type { ToolIntentEvent } from "./run-state.js";

/** Metadata describing who or what resolved an approval. */
export interface ApprovalResolutionMetadata {
  readonly decidedBy: Extract<Event, { type: "approval_resolved" }>["decidedBy"];
  readonly approverId?: Principal;
  readonly reason?: Code;
}

/** Error raised when a human resolution omits its required principal. */
export class ApprovalPrincipalRequiredError extends HarnessError {
  readonly code = "approval_principal_required";

  /** Creates an error for an approval resolution without a principal. */
  constructor() {
    super("Human approval resolution requires an approver identity.");
    this.name = "ApprovalPrincipalRequiredError";
  }
}

/** Error raised when separation of duties forbids the requester from approving. */
export class ApproverIsRequesterError extends HarnessError {
  readonly code = "approver_is_requester";

  /** Creates an error for an approval by the run requester. */
  constructor() {
    super("The run requester cannot resolve this approval.");
    this.name = "ApproverIsRequesterError";
  }
}

/** Validates the human approver and applies separation of duties when enabled. */
export function assertApproverMayResolve(
  created: Event | undefined,
  intent: ToolIntentEvent | undefined,
  metadata: ApprovalResolutionMetadata,
): void {
  if (metadata.decidedBy !== "human") {
    return;
  }
  if (metadata.approverId === undefined) {
    throw new ApprovalPrincipalRequiredError();
  }
  if (
    created?.type === "run_created" &&
    created.requestedBy === metadata.approverId &&
    intent?.policySeparationOfDuties === true
  ) {
    throw new ApproverIsRequesterError();
  }
}
