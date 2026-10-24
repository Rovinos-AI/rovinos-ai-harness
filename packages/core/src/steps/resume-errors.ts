// SPDX-License-Identifier: Apache-2.0
import { HarnessError } from "@rovinos/schemas";

/** Error raised when a resume step expected an event that was not recorded. */
class ResumeEventMissingError extends HarnessError {
  readonly code = "resume_event_missing";

  constructor() {
    super("Expected a recorded resume event.");
    this.name = "ResumeEventMissingError";
  }
}

/** Error raised when a resume action or approval does not identify its intent. */
export class ResumeActionMismatchError extends HarnessError {
  readonly code = "resume_action_mismatch";

  constructor() {
    super("Resume action or approval does not match its intent.");
    this.name = "ResumeActionMismatchError";
  }
}

/** Error raised when an edit decision has no replacement arguments. */
export class ApprovalEditsRequiredError extends HarnessError {
  readonly code = "approval_edits_required";

  constructor() {
    super("An edit approval decision requires replacement arguments.");
    this.name = "ApprovalEditsRequiredError";
  }
}

/** Error raised when an approval edit changes a non-editable field. */
export class ApprovalEditNotAllowedError extends HarnessError {
  readonly code = "approval_edit_not_allowed";

  constructor() {
    super("Approval edits may only change fields listed as editable.");
    this.name = "ApprovalEditNotAllowedError";
  }
}

export { ResumeEventMissingError };
