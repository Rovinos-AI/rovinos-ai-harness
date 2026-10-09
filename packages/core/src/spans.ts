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
});

/** Span for one model call. */
export const MODEL_CALL_SPAN: SpanDefinition<SpanDefinitionShape> = defineSpan(
  "harness.model_call",
  commonAttributes,
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
  commonAttributes,
);

/** Span for compacting run context. */
export const COMPACTION_SPAN: SpanDefinition<SpanDefinitionShape> = defineSpan(
  "harness.compaction",
  commonAttributes,
);
