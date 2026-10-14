// SPDX-License-Identifier: Apache-2.0
import { ROOT_CONTEXT, isSpanContextValid, trace, type SpanContext } from "@opentelemetry/api";
import { Code, Id } from "@harness/schemas";
import { attr, defineSpan, type SpanDefinition, type SpanDefinitionShape } from "@harness/telemetry";
import type { AppSpan, AppTelemetryRejectReason } from "./app-telemetry.js";

interface Clock {
  now(): number;
}

/** Trusted host state used to stamp a validated span received from an MCP App. */
export interface AppSpanStampContext {
  readonly appId: Code;
  readonly runId: Id;
  readonly sessionId: Id;
  readonly sessionStartTime: number;
  readonly parent: SpanContext;
  readonly clock: Clock;
  readonly hasPendingApproval: boolean;
}

const identityShape = {
  "harness.app.id": attr.code(),
  "harness.run.id": attr.id(),
  "harness.ui.session_id": attr.id(),
  "harness.ui.duration_ms": attr.nonnegativeInt(),
};

/** Registered host span definition for app render events. */
export const UI_RENDER_SPAN: SpanDefinition<SpanDefinitionShape> = defineSpan(
  "harness.ui.render",
  identityShape,
  { taskId: "3.6", packageName: "@harness/host" },
);

/** Registered host span definition for app decision events. */
export const UI_DECISION_SPAN: SpanDefinition<SpanDefinitionShape> = defineSpan(
  "harness.ui.decision",
  {
    ...identityShape,
    "harness.ui.decision": attr.enum(["approve", "deny", "edit"]),
  },
  { taskId: "3.6", packageName: "@harness/host" },
);

/** Registered host span definition for app error events. */
export const UI_ERROR_SPAN: SpanDefinition<SpanDefinitionShape> = defineSpan(
  "harness.ui.error",
  identityShape,
  { taskId: "3.6", packageName: "@harness/host" },
);

/** Registered host span definition for app interaction events. */
export const UI_INTERACTION_SPAN: SpanDefinition<SpanDefinitionShape> = defineSpan(
  "harness.ui.interaction",
  {
    ...identityShape,
    "harness.ui.interaction.kind": attr.enum(["click", "focus", "edit"]),
    "harness.ui.interaction.count": attr.nonnegativeInt(),
  },
  { taskId: "3.6", packageName: "@harness/host" },
);

function startStampedSpan(
  span: AppSpan,
  context: AppSpanStampContext,
  startTime: number,
  endTime: number,
  durationMs: number,
): void {
  const identity = {
    "harness.app.id": context.appId,
    "harness.run.id": context.runId,
    "harness.ui.session_id": context.sessionId,
    "harness.ui.duration_ms": durationMs,
  };
  const options = {
    parent: trace.setSpanContext(ROOT_CONTEXT, context.parent),
    startTime,
  };
  switch (span.name) {
    case "ui.render":
      UI_RENDER_SPAN.start(identity, options).end(endTime);
      return;
    case "ui.decision":
      UI_DECISION_SPAN.start(
        { ...identity, "harness.ui.decision": span.decision },
        options,
      ).end(endTime);
      return;
    case "ui.error":
      UI_ERROR_SPAN.start(
        { ...identity, "harness.error.code": span.code },
        options,
      ).end(endTime);
      return;
    case "ui.interaction":
      UI_INTERACTION_SPAN.start(
        {
          ...identity,
          "harness.ui.interaction.kind": span.kind,
          "harness.ui.interaction.count": span.count,
        },
        options,
      ).end(endTime);
  }
}

/**
 * Creates an app span using only host-bound identity, timing, and parent context.
 *
 * App-provided offsets are intentionally ignored; duration is clamped to the active session.
 *
 * @param span - Span already validated by the app telemetry schema.
 * @param context - Host-owned identity, clock, session, approval, and parent state.
 * @returns A bounded rejection reason, or `undefined` after creating the registered span.
 */
export function stampAppSpan(
  span: AppSpan,
  context: AppSpanStampContext,
): AppTelemetryRejectReason | undefined {
  if (span.name === "ui.decision" && !context.hasPendingApproval) {
    return "unknown_span";
  }
  if (
    !Number.isSafeInteger(context.sessionStartTime) ||
    !isSpanContextValid(context.parent)
  ) {
    return "schema";
  }
  try {
    const endTime = context.clock.now();
    if (!Number.isSafeInteger(endTime) || endTime < context.sessionStartTime) {
      return "schema";
    }
    const durationMs = Math.min(span.durationMs, endTime - context.sessionStartTime);
    const startTime = Math.max(context.sessionStartTime, endTime - durationMs);
    startStampedSpan(span, context, startTime, endTime, durationMs);
    return undefined;
  } catch {
    return "schema";
  }
}
