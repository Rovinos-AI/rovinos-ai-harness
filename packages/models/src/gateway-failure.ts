// SPDX-License-Identifier: Apache-2.0
import type {
  JsonValue,
  ModelRef,
  ModelRequest,
  ModelResponse,
  ModelUsage,
} from "@harness/schemas";
import type { EnforcementIssue, EnforcementRung } from "./enforce/index.js";
import { appendRepairMessages } from "./enforce/repair.js";
import { ModelOutputInvalidError, attachModelFailureMetadata } from "./errors.js";
import { reportModelUsage } from "./usage.js";

/** Adds schema repair context or throws when the configured repair limit is reached. */
export function appendRepairOrThrow(options: {
  readonly currentRequest: ModelRequest;
  readonly parts: ModelResponse["parts"];
  readonly issues: readonly EnforcementIssue[];
  readonly rungUsed?: EnforcementRung;
  readonly outputSchema: JsonValue | undefined;
  readonly repairAttempts: number;
  readonly maxRepairs: number;
  readonly usage: ModelUsage | undefined;
  readonly latencyMs: number;
}): ModelRequest {
  if (options.repairAttempts >= options.maxRepairs) {
    throw new ModelOutputInvalidError(
      options.repairAttempts,
      options.issues,
      options.outputSchema,
      {
        ...(options.usage === undefined ? {} : { usage: options.usage }),
        latencyMs: options.latencyMs,
      },
    );
  }
  return appendRepairMessages(
    options.currentRequest,
    options.parts,
    options.issues,
    options.rungUsed,
  );
}

/** Accounts usage from a failed attempt and rethrows its sanitized failure metadata. */
export function rethrowWithAccountedUsage(options: {
  readonly error: unknown;
  readonly model: ModelRef;
  readonly usage: ModelUsage | undefined;
  readonly latencyMs: number;
  readonly repairAttempts: number;
  readonly deferUsage: boolean;
  readonly accountUsage: (model: ModelRef, usage: ModelUsage) => ModelUsage;
}): never {
  if (options.usage === undefined) {
    throw options.error;
  }
  const usage = options.accountUsage(options.model, options.usage);
  reportModelUsage(options.model, usage, options.deferUsage);
  throw attachModelFailureMetadata(options.error, {
    usage,
    latencyMs: options.latencyMs,
    repairAttempts: options.repairAttempts,
  });
}
