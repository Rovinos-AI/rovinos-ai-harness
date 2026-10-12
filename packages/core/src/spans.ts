// SPDX-License-Identifier: Apache-2.0
import { attr, defineSpan } from "@harness/telemetry";
import type { SpanDefinition, SpanDefinitionShape } from "@harness/telemetry";

const commonAttributes = {
  "harness.run.id": attr.id(),
  "harness.event.seq": attr.optional(attr.int()),
};

/** Root span for one execution segment. */
export const RUN_SPAN: SpanDefinition<SpanDefinitionShape> = defineSpan("harness.run", {
  ...commonAttributes,
  "harness.segment.id": attr.id(),
  "harness.run.parent_id": attr.optional(attr.id()),
  "harness.run.continuation_of": attr.optional(attr.id()),
  "harness.run.depth": attr.optional(attr.int()),
});

/** Span for one model call. */
export const MODEL_CALL_SPAN: SpanDefinition<SpanDefinitionShape> = defineSpan(
  "harness.model_call",
  {
    ...commonAttributes,
    "harness.model.attempts": attr.optional(attr.int()),
    "harness.model.repair_attempts": attr.optional(attr.nonnegativeInt()),
  },
);

/** Span for one tool call. */
export const TOOL_CALL_SPAN: SpanDefinition<SpanDefinitionShape> = defineSpan(
  "harness.tool_call",
  commonAttributes,
);

/** Span while waiting for an approval. */
export const APPROVAL_WAIT_SPAN: SpanDefinition<SpanDefinitionShape> = defineSpan(
  "harness.approval_wait",
  commonAttributes,
);

/** Span for writing a checkpoint. */
export const CHECKPOINT_SPAN: SpanDefinition<SpanDefinitionShape> = defineSpan(
  "harness.checkpoint",
  {
    ...commonAttributes,
    "harness.checkpoint.reason": attr.optional(attr.code()),
  },
);

/** Span for compacting run context. */
export const COMPACTION_SPAN: SpanDefinition<SpanDefinitionShape> = defineSpan(
  "harness.compaction",
  commonAttributes,
);
