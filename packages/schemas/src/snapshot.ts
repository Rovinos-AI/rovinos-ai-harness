// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";
import { JsonValue } from "./json.js";
import { Id, Traceparent, WorkspaceRef } from "./primitives.js";

/** A compacted run checkpoint; context and plan are content-classified. */
export const SnapshotSchema = z
  .object({
    snapshotId: Id,
    runId: Id,
    v: z.number().int().positive().default(1),
    atSeq: z.number().int().nonnegative(),
    createdAt: z.number().int().nonnegative(),
    traceparent: Traceparent,
    context: JsonValue,
    plan: JsonValue,
    workspaceRef: WorkspaceRef.optional(),
  })
  .strict();

/** A validated checkpoint snapshot. */
export type Snapshot = z.infer<typeof SnapshotSchema>;
