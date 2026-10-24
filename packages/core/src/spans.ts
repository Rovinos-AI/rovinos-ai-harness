// SPDX-License-Identifier: Apache-2.0
import { attr, defineSpan } from "@rovinos/telemetry";
import type { SpanDefinition, SpanDefinitionShape } from "@rovinos/telemetry";
import type { Id } from "@rovinos/schemas";

const commonAttributes = {
  "harness.run.id": attr.id(),
  "harness.event.seq": attr.optional(attr.int()),
};

/** Root span for one execution segment. */
export const RUN_SPAN: SpanDefinition<SpanDefinitionShape> = defineSpan(
  "harness.run",
  {
    ...commonAttributes,
    "harness.segment.id": attr.id(),
    "harness.run.parent_id": attr.optional(attr.id()),
    "harness.run.continuation_of": attr.optional(attr.id()),
    "harness.run.depth": attr.optional(attr.int()),
  },
  { taskId: "4.1", packageName: "@rovinos/core" },
);

/** Creates metadata attributes for a run's root span. */
export function runSpanAttributes(options: {
  readonly parentRunId?: Id;
  readonly continuationOf?: Id;
  readonly depth?: number;
}): {
  readonly "harness.run.parent_id"?: Id;
  readonly "harness.run.continuation_of"?: Id;
  readonly "harness.run.depth": number;
} {
  return {
    ...(options.parentRunId === undefined ? {} : { "harness.run.parent_id": options.parentRunId }),
    ...(options.continuationOf === undefined
      ? {}
      : { "harness.run.continuation_of": options.continuationOf }),
    "harness.run.depth": options.depth ?? 0,
  };
}

/** Span for one model call. */
export const MODEL_CALL_SPAN: SpanDefinition<SpanDefinitionShape> = defineSpan(
  "harness.model_call",
  {
    ...commonAttributes,
    "harness.model.attempts": attr.optional(attr.int()),
    "harness.model.repair_attempts": attr.optional(attr.nonnegativeInt()),
    "harness.model.input_tokens": attr.optional(attr.nonnegativeInt()),
    "harness.model.output_tokens": attr.optional(attr.nonnegativeInt()),
    "harness.model.cache_read_tokens": attr.optional(attr.nonnegativeInt()),
    "harness.model.cache_write_tokens": attr.optional(attr.nonnegativeInt()),
    "harness.model.cost_micros": attr.optional(attr.nonnegativeInt()),
    "harness.context.strategy": attr.code(),
    "harness.context.strategy_version": attr.code(),
    "harness.context.estimated_tokens": attr.int(),
    "harness.context.message_count": attr.int(),
  },
  { taskId: "4.1", packageName: "@rovinos/core" },
);

/** Span for one tool call. */
export const TOOL_CALL_SPAN: SpanDefinition<SpanDefinitionShape> = defineSpan(
  "harness.tool_call",
  {
    ...commonAttributes,
    "harness.policy.decision": attr.optional(attr.enum(["allow", "ask", "deny"])),
    "harness.policy.rule_id": attr.optional(attr.code()),
    "harness.subagent.completion_record_failed": attr.optional(attr.bool()),
  },
  { taskId: "4.1", packageName: "@rovinos/core" },
);

/** Span while waiting for an approval. */
export const APPROVAL_WAIT_SPAN: SpanDefinition<SpanDefinitionShape> = defineSpan(
  "harness.approval_wait",
  commonAttributes,
  { taskId: "4.1", packageName: "@rovinos/core" },
);

/** Span for resolving one human input request. */
export const INPUT_WAIT_SPAN: SpanDefinition<SpanDefinitionShape> = defineSpan(
  "harness.input_wait",
  {
    ...commonAttributes,
    "harness.input.source": attr.enum(["mcp_mrtr", "mcp_legacy", "agent"]),
    "harness.input.mode": attr.enum(["form", "url"]),
    "harness.input.round": attr.nonnegativeInt(),
    "harness.input.action": attr.enum(["accept", "decline", "cancel"]),
    "harness.wait_ms": attr.nonnegativeInt(),
  },
  { taskId: "25.3", packageName: "@rovinos/core" },
);

/** Span for recording content submitted by an untrusted app. */
export const APP_CONTENT_SPAN: SpanDefinition<SpanDefinitionShape> = defineSpan(
  "harness.app_content",
  {
    ...commonAttributes,
    "harness.app.id": attr.code(),
  },
  { taskId: "3.8", packageName: "@rovinos/core" },
);

/** Span for writing a checkpoint. */
export const CHECKPOINT_SPAN: SpanDefinition<SpanDefinitionShape> = defineSpan(
  "harness.checkpoint",
  {
    ...commonAttributes,
    "harness.checkpoint.reason": attr.optional(attr.code()),
  },
  { taskId: "4.1", packageName: "@rovinos/core" },
);

/** Span for compacting run context. */
export const COMPACTION_SPAN: SpanDefinition<SpanDefinitionShape> = defineSpan(
  "harness.compaction",
  commonAttributes,
  { taskId: "4.1", packageName: "@rovinos/core" },
);
