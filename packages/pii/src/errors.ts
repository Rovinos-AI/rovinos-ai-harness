// SPDX-License-Identifier: Apache-2.0
import { HarnessError } from "@harness/schemas";
import type { Code } from "@harness/schemas";

type PiiTokenizerErrorCode =
  | "pii_depth_exceeded"
  | "pii_input_too_large"
  | "pii_input_invalid"
  | "pii_detector_failed"
  | "pii_detector_invalid_output"
  | "pii_vault_failed";

interface EntityCount {
  readonly type: Code;
  readonly count: number;
}

/** Safe tokenizer failure; its message and code never include input values. */
export class PiiTokenizerError extends HarnessError {
  readonly code: PiiTokenizerErrorCode;

  constructor(code: PiiTokenizerErrorCode) {
    super(code);
    this.code = code;
  }
}

/** Policy block carrying only entity types and counts, never detected values. */
export class PiiBlockedError extends HarnessError {
  readonly code = "pii_blocked";
  readonly entities: readonly EntityCount[];

  constructor(entities: readonly EntityCount[]) {
    super("Sensitive content blocked by policy");
    this.entities = entities.map(({ type, count }) => ({ type, count }));
  }
}
