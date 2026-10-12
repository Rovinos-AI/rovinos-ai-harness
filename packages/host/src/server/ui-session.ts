// SPDX-License-Identifier: Apache-2.0
import {
  ROOT_CONTEXT,
  isSpanContextValid,
  trace,
  type Span,
  type SpanContext,
} from "@opentelemetry/api";
import { Traceparent, type Code, type Id } from "@harness/schemas";
import {
  attr,
  defineSpan,
  type SpanDefinition,
  type SpanDefinitionShape,
} from "@harness/telemetry";

/** Registered host span for one MCP App UI session. */
export const UI_SESSION_SPAN: SpanDefinition<SpanDefinitionShape> = defineSpan(
  "harness.ui_session",
  {
    "harness.run.id": attr.id(),
    "harness.app.id": attr.code(),
    "harness.ui.session_id": attr.id(),
  },
  { taskId: "3.2", packageName: "@harness/host" },
);

/** Trace context required to create a UI session beneath its originating tool call. */
export interface UiSessionContext {
  readonly runId: Id;
  readonly toolCallSpanContext: SpanContext;
}

/** Active UI-session span and its app-safe W3C traceparent. */
export class UiSession {
  readonly traceparent: string | undefined;
  readonly #span: Span | undefined;
  #ended = false;

  /**
   * Starts a session span as a child of the originating tool-call span when its context is valid.
   *
   * @param context - Run and originating tool-call context.
   * @param appId - Validated app code from host configuration.
   * @param sessionId - Host-generated UI session identifier.
   * @param onUnavailable - Receives a safe diagnostic when context cannot be used.
   */
  constructor(
    context: UiSessionContext | undefined,
    appId: Code,
    sessionId: Id,
    onUnavailable: () => void,
  ) {
    const parent = context?.toolCallSpanContext;
    if (context === undefined || parent === undefined || !isSpanContextValid(parent)) {
      onUnavailable();
      this.#span = undefined;
      this.traceparent = undefined;
      return;
    }
    const span = UI_SESSION_SPAN.start(
      {
        "harness.run.id": context.runId,
        "harness.app.id": appId,
        "harness.ui.session_id": sessionId,
      },
      { parent: trace.setSpanContext(ROOT_CONTEXT, parent) },
    );
    const spanContext = span.spanContext();
    if (!isSpanContextValid(spanContext)) {
      span.end();
      onUnavailable();
      this.#span = undefined;
      this.traceparent = undefined;
      return;
    }
    this.#span = span;
    this.traceparent = Traceparent.parse(`00-${spanContext.traceId}-${spanContext.spanId}-01`);
  }

  /** Ends the session span once when its iframe is removed or the owning run resumes. */
  end(): void {
    if (!this.#ended) {
      this.#ended = true;
      this.#span?.end();
    }
  }
}
