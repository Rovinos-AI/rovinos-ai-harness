// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";
import { Code, Id } from "../primitives.js";
import { JsonValue } from "../json.js";
import { RunStatus } from "../events.js";

/** One safe event summary returned by `harness inspect`. */
export const InspectEventSchema = z
  .object({
    type: Code,
    seq: z.number().int().nonnegative(),
    event: JsonValue.optional(),
  })
  .strict();

/** Inferred event summary returned by `harness inspect`. */
export type InspectEvent = z.infer<typeof InspectEventSchema>;

/** Machine-readable run state returned by `harness inspect`. */
export const InspectResultSchema = z
  .object({
    runId: Id,
    status: RunStatus,
    steps: z.number().int().nonnegative(),
    usage: z
      .object({
        inputTokens: z.number().int().nonnegative(),
        outputTokens: z.number().int().nonnegative(),
        costMicros: z.number().int().nonnegative(),
      })
      .strict(),
    lastCheckpoint: z
      .object({
        checkpointId: Id,
        atSeq: z.number().int().nonnegative(),
      })
      .strict()
      .nullable(),
    pendingApprovals: z.array(
      z
        .object({
          approvalId: Id,
          toolId: Code,
        })
        .strict(),
    ),
    continuations: z.array(Id),
    events: z.array(InspectEventSchema),
  })
  .strict();

/** Inferred machine-readable run state returned by `harness inspect`. */
export type InspectResult = z.infer<typeof InspectResultSchema>;
