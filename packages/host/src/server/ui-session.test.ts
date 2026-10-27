// SPDX-License-Identifier: Apache-2.0
import { trace, type Span, type SpanContext } from "@opentelemetry/api";
import { createTestSpanCollector } from "@rovinos/telemetry/testing";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { UiSession } from "./ui-session.js";

const collector = createTestSpanCollector();
const runId = "00000000000000000000000001";
const sessionId = "00000000000000000000000002";

beforeAll(() => {
  trace.setGlobalTracerProvider(collector.provider);
});

afterAll(async () => {
  await collector.provider.shutdown();
});

describe("UiSession", () => {
  it("creates a child span, emits a session traceparent, and ends idempotently", () => {
    const unavailable = vi.fn();
    const parent = collector.provider.getTracer("host-test").startSpan("harness.tool_call");
    const parentContext = parent.spanContext();
    const session = new UiSession(
      { runId, toolCallSpanContext: parentContext },
      "approval",
      sessionId,
      unavailable,
    );

    expect(session.traceparent).toBe(`00-${parentContext.traceId}-${"b".repeat(16)}-01`);
    expect(unavailable).not.toHaveBeenCalled();
    session.end();
    session.end();
    parent.end();

    const spans = collector.getFinishedSpans();
    const sessionSpan = spans.find((span) => span.name === "harness.ui_session");
    expect(sessionSpan?.parentSpanContext?.spanId).toBe(parentContext.spanId);
    expect(sessionSpan?.attributes).toMatchObject({
      "harness.run.id": runId,
      "harness.app.id": "approval",
      "harness.ui.session_id": sessionId,
    });
    expect(spans.filter((span) => span.name === "harness.ui_session")).toHaveLength(1);
  });

  it("preserves the parent sampling flags in the session traceparent", () => {
    const parent = collector.provider.getTracer("host-test").startSpan("harness.tool_call");
    const parentContext = { ...parent.spanContext(), traceFlags: 0 };
    const session = new UiSession(
      { runId, toolCallSpanContext: parentContext },
      "approval",
      sessionId,
      () => undefined,
    );

    expect(session.traceparent).toBe(`00-${parentContext.traceId}-${"b".repeat(16)}-00`);
    session.end();
    parent.end();
  });

  it.each([
    ["missing context", undefined],
    [
      "invalid context",
      { traceId: "0".repeat(32), spanId: "0".repeat(16), traceFlags: 1 } satisfies SpanContext,
    ],
  ])("omits trace context for %s", (_name, context) => {
    const unavailable = vi.fn();
    const session = new UiSession(
      context === undefined
        ? undefined
        : {
            runId,
            toolCallSpanContext: context,
          },
      "approval",
      sessionId,
      unavailable,
    );

    expect(session.traceparent).toBeUndefined();
    expect(unavailable).toHaveBeenCalledOnce();
    expect(() => {
      session.end();
    }).not.toThrow();
  });

  it("ends a session span when the provider returns an invalid child context", () => {
    const parent = collector.provider.getTracer("host-test").startSpan("harness.tool_call");
    const invalidSpanContext: SpanContext = {
      traceId: "0".repeat(32),
      spanId: "0".repeat(16),
      traceFlags: 1,
    };
    const span = {
      end: vi.fn(),
      spanContext: () => invalidSpanContext,
    } as unknown as Span;
    const originalGetTracer = trace.getTracer;
    expect(Reflect.set(trace, "getTracer", () => ({ startSpan: () => span }))).toBe(true);
    const unavailable = vi.fn();

    try {
      const session = new UiSession(
        { runId, toolCallSpanContext: parent.spanContext() },
        "approval",
        sessionId,
        unavailable,
      );

      expect(span.end).toHaveBeenCalledOnce();
      expect(unavailable).toHaveBeenCalledOnce();
      expect(session.traceparent).toBeUndefined();
      expect(session.spanContext).toBeUndefined();
      session.end();
    } finally {
      Reflect.set(trace, "getTracer", originalGetTracer);
      parent.end();
    }
  });
});
