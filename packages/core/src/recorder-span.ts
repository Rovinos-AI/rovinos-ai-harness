// SPDX-License-Identifier: Apache-2.0
import {
  context,
  ROOT_CONTEXT,
  SpanStatusCode,
  trace,
  type AnyValue,
  type Context,
  type Link,
  type Span,
} from "@opentelemetry/api";
import { HarnessError, type Event, type Id } from "@rovinos/schemas";
import {
  setActiveSpanAttribute,
  type SpanDefinition,
  type SpanDefinitionShape,
} from "@rovinos/telemetry";
import { RUN_SPAN } from "./spans.js";

/** Optional parent context and links for a registered span. */
export interface StepSpanOptions {
  readonly links?: readonly Link[];
  readonly parentContext?: Context;
}

/** Run one recorder callback in its registered event span. */
export async function runStepSpan(options: {
  readonly runId: Id;
  readonly segmentId: Id;
  readonly definition: SpanDefinition<SpanDefinitionShape>;
  readonly attrs: Readonly<Record<string, AnyValue>>;
  readonly fn: (span: Span) => Event | Promise<Event>;
  readonly options: StepSpanOptions;
}): Promise<Event> {
  const { runId, segmentId, definition, attrs, fn, options: spanOptions } = options;
  const spanAttrs: Record<string, unknown> = {
    ...attrs,
    "harness.run.id": runId,
  };
  if (definition.name === "harness.run") {
    spanAttrs["harness.segment.id"] = segmentId;
  }

  const span = definition.start(
    spanAttrs,
    definition.name === RUN_SPAN.name
      ? {
          parent: spanOptions.parentContext ?? ROOT_CONTEXT,
          ...(spanOptions.links === undefined ? {} : { links: [...spanOptions.links] }),
        }
      : undefined,
  );
  const activeContext = trace.setSpan(context.active(), span);
  return context.with(activeContext, async () => {
    try {
      const event = await fn(span);
      setActiveSpanAttribute("harness.event.seq", event.seq);
      return event;
    } catch (error) {
      span.setStatus({ code: SpanStatusCode.ERROR });
      if (error instanceof HarnessError) {
        setActiveSpanAttribute("harness.error.code", error.code);
      }
      throw error;
    } finally {
      span.end();
    }
  });
}
