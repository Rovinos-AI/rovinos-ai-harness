// SPDX-License-Identifier: Apache-2.0
import {
  attr,
  countHostAppRejected,
  defineSpan,
  type SpanDefinition,
  type SpanDefinitionShape,
} from "@harness/telemetry";
import { Code } from "@harness/schemas";
import { z } from "zod";

const startOffset = z.number().int().nonnegative();
const duration = z.number().int().min(0).max(3_600_000);

/** Closed schema for the spans accepted from an MCP App. */
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
]);

/** Inferred span accepted by the host's app telemetry boundary. */
export type AppSpan = z.infer<typeof AppSpanSchema>;

/** Strict schema for an app telemetry batch. */
export const AppSpanBatchSchema = z.object({ spans: z.array(AppSpanSchema).max(50) }).strict();

/** Inferred app telemetry batch contract. */
export type AppSpanBatch = z.infer<typeof AppSpanBatchSchema>;

/** Bounded reasons recorded when app telemetry is discarded. */
export const AppTelemetryRejectReasonSchema = z.enum(["schema", "size", "unknown_span"]);

/** Inferred bounded reasons recorded when app telemetry is discarded. */
export type AppTelemetryRejectReason = z.infer<typeof AppTelemetryRejectReasonSchema>;

/** Minimal acknowledgment returned to the app. */
export const AppSpanBatchAckSchema = z
  .object({
    accepted: z.number().int().nonnegative(),
    dropped: z.number().int().nonnegative(),
  })
  .strict();

/** Inferred minimal acknowledgment returned to the app. */
export type AppSpanBatchAck = z.infer<typeof AppSpanBatchAckSchema>;

/** Registered span definition for app render events. */
export const UI_RENDER_SPAN: SpanDefinition<SpanDefinitionShape> = defineSpan(
  "harness.ui.render",
  {
    "harness.ui.start_offset_ms": attr.nonnegativeInt(),
    "harness.ui.duration_ms": attr.nonnegativeInt(),
  },
  { taskId: "3.4", packageName: "@harness/host" },
);

/** Registered span definition for app decision events. */
export const UI_DECISION_SPAN: SpanDefinition<SpanDefinitionShape> = defineSpan(
  "harness.ui.decision",
  {
    "harness.ui.decision": attr.enum(["approve", "deny", "edit"]),
    "harness.ui.start_offset_ms": attr.nonnegativeInt(),
    "harness.ui.duration_ms": attr.nonnegativeInt(),
  },
  { taskId: "3.4", packageName: "@harness/host" },
);

/** Registered span definition for app error events. */
export const UI_ERROR_SPAN: SpanDefinition<SpanDefinitionShape> = defineSpan(
  "harness.ui.error",
  {
    "harness.ui.start_offset_ms": attr.nonnegativeInt(),
    "harness.ui.duration_ms": attr.nonnegativeInt(),
  },
  { taskId: "3.4", packageName: "@harness/host" },
);

/** Registered span definition for app interaction events. */
export const UI_INTERACTION_SPAN: SpanDefinition<SpanDefinitionShape> = defineSpan(
  "harness.ui.interaction",
  {
    "harness.ui.interaction.kind": attr.enum(["click", "focus", "edit"]),
    "harness.ui.interaction.count": attr.nonnegativeInt(),
    "harness.ui.start_offset_ms": attr.nonnegativeInt(),
    "harness.ui.duration_ms": attr.nonnegativeInt(),
  },
  { taskId: "3.4", packageName: "@harness/host" },
);

const spanNames = new Set(["ui.render", "ui.decision", "ui.error", "ui.interaction"]);
const maxBatchBytes = 16 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function byteLength(value: unknown): number | undefined {
  try {
    const serialized = JSON.stringify(value);
    return typeof serialized === "string" ? Buffer.byteLength(serialized, "utf8") : undefined;
  } catch {
    return undefined;
  }
}

function droppedBatchCount(value: unknown): number {
  try {
    if (isRecord(value) && Array.isArray(value.spans)) {
      const spans: readonly unknown[] = value.spans;
      return spans.length;
    }
  } catch {
    return 1;
  }
  return 1;
}

function acknowledgment(accepted: number, dropped: number): AppSpanBatchAck {
  return AppSpanBatchAckSchema.parse({ accepted, dropped });
}

function inspectBatch(
  input: unknown,
):
  | { readonly spans: readonly unknown[] }
  | { readonly reason: AppTelemetryRejectReason; readonly dropped: number } {
  const serializedBytes = byteLength(input);
  if (serializedBytes === undefined) {
    return { reason: "schema", dropped: droppedBatchCount(input) };
  }
  if (serializedBytes > maxBatchBytes) {
    return { reason: "size", dropped: droppedBatchCount(input) };
  }
  if (!isRecord(input)) {
    return { reason: "schema", dropped: 1 };
  }

  try {
    if (!Object.hasOwn(input, "spans") || !Array.isArray(input.spans)) {
      return { reason: "schema", dropped: droppedBatchCount(input) };
    }
    const spans: readonly unknown[] = input.spans;
    if (spans.length > 50) {
      return { reason: "size", dropped: spans.length };
    }
    const keys = Object.keys(input);
    if (keys.length !== 1 || keys[0] !== "spans") {
      return { reason: "schema", dropped: spans.length };
    }
    return { spans };
  } catch {
    return { reason: "schema", dropped: droppedBatchCount(input) };
  }
}

function reject(
  reason: AppTelemetryRejectReason,
  onRejected?: (reason: AppTelemetryRejectReason) => void,
): void {
  countHostAppRejected(reason);
  try {
    onRejected?.(reason);
  } catch {
    return;
  }
}

function startSpan(span: AppSpan): boolean {
  const timing = {
    "harness.ui.start_offset_ms": span.startOffsetMs,
    "harness.ui.duration_ms": span.durationMs,
  };
  try {
    switch (span.name) {
      case "ui.render":
        UI_RENDER_SPAN.start(timing).end();
        return true;
      case "ui.decision":
        UI_DECISION_SPAN.start({
          ...timing,
          "harness.ui.decision": span.decision,
        }).end();
        return true;
      case "ui.error":
        UI_ERROR_SPAN.start({
          ...timing,
          "harness.error.code": span.code,
        }).end();
        return true;
      case "ui.interaction":
        UI_INTERACTION_SPAN.start({
          ...timing,
          "harness.ui.interaction.kind": span.kind,
          "harness.ui.interaction.count": span.count,
        }).end();
        return true;
    }
  } catch {
    return false;
  }
  return false;
}

function ingestSpan(
  candidate: unknown,
  onRejected?: (reason: AppTelemetryRejectReason) => void,
): boolean {
  try {
    const name = isRecord(candidate) ? candidate.name : undefined;
    if (typeof name === "string" && !spanNames.has(name)) {
      reject("unknown_span", onRejected);
      return false;
    }
    const parsed = AppSpanSchema.safeParse(candidate);
    if (!parsed.success || !startSpan(parsed.data)) {
      reject("schema", onRejected);
      return false;
    }
    return true;
  } catch {
    reject("schema", onRejected);
    return false;
  }
}

/**
 * Validates and ingests an untrusted app telemetry batch without retaining or logging its payload.
 *
 * @param input - Untrusted decoded `harness.telemetry.emit` arguments.
 * @param options - Optional observer for bounded rejection reasons.
 * @returns Integer counts only; malformed spans are dropped independently.
 */
export function ingestBatch(
  input: unknown,
  options: { readonly onRejected?: (reason: AppTelemetryRejectReason) => void } = {},
): AppSpanBatchAck {
  const inspection = inspectBatch(input);
  if ("reason" in inspection) {
    reject(inspection.reason, options.onRejected);
    return acknowledgment(0, inspection.dropped);
  }

  let accepted = 0;
  let dropped = 0;
  for (const candidate of inspection.spans) {
    if (ingestSpan(candidate, options.onRejected)) {
      accepted += 1;
    } else {
      dropped += 1;
    }
  }
  return acknowledgment(accepted, dropped);
}
