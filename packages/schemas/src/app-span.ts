// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";
import { Code } from "./primitives.js";

const startOffset = z.number().int().nonnegative();
const duration = z.number().int().min(0).max(3_600_000);

/** Closed schema for spans accepted from an MCP App. */
export const AppSpanSchema = z.discriminatedUnion("name", [
  z
    .object({
      name: z.literal("ui.render"),
      startOffsetMs: startOffset,
      durationMs: duration,
    })
    .strict(),
  z
    .object({
      name: z.literal("ui.decision"),
      decision: z.enum(["approve", "deny", "edit"]),
      startOffsetMs: startOffset,
      durationMs: duration,
    })
    .strict(),
  z
    .object({
      name: z.literal("ui.error"),
      code: Code,
      startOffsetMs: startOffset,
      durationMs: duration,
    })
    .strict(),
  z
    .object({
      name: z.literal("ui.interaction"),
      kind: z.enum(["click", "focus", "edit"]),
      count: z.number().int().min(0).max(1000),
      startOffsetMs: startOffset,
      durationMs: duration,
    })
    .strict(),
  z
    .object({
      name: z.literal("ui.input"),
      action: z.enum(["accept", "decline", "cancel", "open_link", "done"]),
      startOffsetMs: startOffset,
      durationMs: duration,
    })
    .strict(),
]);

/** Inferred span accepted by the host's app telemetry boundary. */
export type AppSpan = z.infer<typeof AppSpanSchema>;
