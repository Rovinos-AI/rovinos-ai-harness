// SPDX-License-Identifier: Apache-2.0
import { countHostAppRejected } from "@rovinos/telemetry";
import { AppSpanSchema, type AppSpan } from "@rovinos/schemas";
import { z } from "zod";
import { stampAppSpan, type AppSpanStampContext } from "./stamp.js";

export { AppSpanSchema, type AppSpan };

/** Strict schema for an app telemetry batch. */
export const AppSpanBatchSchema = z.object({ spans: z.array(AppSpanSchema).max(50) }).strict();

/** Inferred app telemetry batch contract. */
export type AppSpanBatch = z.infer<typeof AppSpanBatchSchema>;

/** Bounded reasons recorded when app telemetry is discarded. */
export const AppTelemetryRejectReasonSchema = z.enum([
  "schema",
  "size",
  "rate",
  "unknown_app",
  "unknown_span",
  "session_cap",
]);

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

export { UI_DECISION_SPAN, UI_ERROR_SPAN, UI_INTERACTION_SPAN, UI_RENDER_SPAN } from "./stamp.js";

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

function ingestSpan(
  candidate: unknown,
  onRejected?: (reason: AppTelemetryRejectReason) => void,
  stamp?: AppSpanStampContext,
  acceptSpan?: () => true | "rate" | "session_cap",
): boolean {
  try {
    const name = isRecord(candidate) ? candidate.name : undefined;
    if (typeof name === "string" && !spanNames.has(name)) {
      reject("unknown_span", onRejected);
      return false;
    }
    const parsed = AppSpanSchema.safeParse(candidate);
    if (!parsed.success) {
      reject("schema", onRejected);
      return false;
    }
    if (stamp === undefined) {
      reject("unknown_app", onRejected);
      return false;
    }
    if (acceptSpan !== undefined) {
      const acceptance = acceptSpan();
      if (acceptance !== true) {
        reject(acceptance, onRejected);
        return false;
      }
    }
    const rejected = stampAppSpan(parsed.data, stamp);
    if (rejected !== undefined) {
      reject(rejected, onRejected);
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
 * @param options - Host stamp context, span limiter, and bounded rejection observer.
 * @returns Integer counts only; malformed spans are dropped independently.
 */
export function ingestBatch(
  input: unknown,
  options: {
    readonly onRejected?: (reason: AppTelemetryRejectReason) => void;
    readonly stamp?: AppSpanStampContext;
    readonly acceptSpan?: () => true | "rate" | "session_cap";
  } = {},
): AppSpanBatchAck {
  const inspection = inspectBatch(input);
  if ("reason" in inspection) {
    reject(inspection.reason, options.onRejected);
    return acknowledgment(0, inspection.dropped);
  }

  let accepted = 0;
  let dropped = 0;
  for (const candidate of inspection.spans) {
    if (ingestSpan(candidate, options.onRejected, options.stamp, options.acceptSpan)) {
      accepted += 1;
    } else {
      dropped += 1;
    }
  }
  return acknowledgment(accepted, dropped);
}

/** Drops an entire batch with a bounded rejection reason and an integer-only acknowledgment. */
export function rejectBatch(
  input: unknown,
  reason: AppTelemetryRejectReason,
  options: { readonly onRejected?: (reason: AppTelemetryRejectReason) => void } = {},
): AppSpanBatchAck {
  reject(reason, options.onRejected);
  return acknowledgment(0, droppedBatchCount(input));
}
