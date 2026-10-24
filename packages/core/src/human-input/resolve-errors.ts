// SPDX-License-Identifier: Apache-2.0
import { HarnessError } from "@rovinos/schemas";

/** Error raised when an input request does not exist in the run log. */
export class InputNotFoundError extends HarnessError {
  readonly code = "input_not_found";

  constructor() {
    super("Input request was not found.");
    this.name = "InputNotFoundError";
  }
}

/** Error raised when an input request has already been resolved. */
export class InputAlreadyResolvedError extends HarnessError {
  readonly code = "input_already_resolved";

  constructor() {
    super("Input request was already resolved.");
    this.name = "InputAlreadyResolvedError";
  }
}

/** Error raised when the selected answer does not satisfy its request schema. */
export class InputAnswerInvalidError extends HarnessError {
  readonly code = "input_answer_invalid";

  constructor() {
    super("Input answer does not satisfy the request schema.");
    this.name = "InputAnswerInvalidError";
  }
}

/** Error raised when a channel's principal is not a valid human principal. */
export class InputPrincipalInvalidError extends HarnessError {
  readonly code = "input_principal_invalid";

  constructor() {
    super("Input resolution requires a valid human principal.");
    this.name = "InputPrincipalInvalidError";
  }
}

/** Error raised when the input has not reached its configured expiry. */
export class InputNotExpiredError extends HarnessError {
  readonly code = "input_not_expired";

  constructor() {
    super("Input request has not expired.");
    this.name = "InputNotExpiredError";
  }
}

/** Error raised when a human answers after the configured input deadline. */
export class InputExpiredError extends HarnessError {
  readonly code = "input_expired";

  constructor() {
    super("Input request expired before the answer was recorded.");
    this.name = "InputExpiredError";
  }
}

/** Error raised when a run is terminal and can no longer accept input. */
export class InputRunTerminalError extends HarnessError {
  readonly code = "input_run_terminal";

  constructor() {
    super("A terminal run cannot accept or expire input.");
    this.name = "InputRunTerminalError";
  }
}

/** Error raised when tokenized schema constraints cannot be restored for validation. */
export class InputSchemaUnavailableError extends HarnessError {
  readonly code = "input_schema_unavailable";

  constructor() {
    super("Input schema constraints are unavailable for validation.");
    this.name = "InputSchemaUnavailableError";
  }
}

/** Error raised when an answer cannot be tokenized before it is recorded. */
export class InputTokenizerUnavailableError extends HarnessError {
  readonly code = "input_tokenizer_unavailable";

  constructor() {
    super("Input answer cannot be recorded without a tokenizer.");
    this.name = "InputTokenizerUnavailableError";
  }
}

/** Error raised when the answer cannot be routed to its originating tool. */
export class InputDestinationUnavailableError extends HarnessError {
  readonly code = "input_destination_unavailable";

  constructor() {
    super("Input answer has no authorized destination.");
    this.name = "InputDestinationUnavailableError";
  }
}

/** Error raised when concurrent writers prevent a durable input resolution. */
export class InputResolutionConflictError extends HarnessError {
  readonly code = "input_resolution_conflict";

  constructor() {
    super("Input resolution conflicted with concurrent run events.");
    this.name = "InputResolutionConflictError";
  }
}
