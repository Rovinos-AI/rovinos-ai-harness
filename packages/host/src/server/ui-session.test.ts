// SPDX-License-Identifier: Apache-2.0
import { trace, type SpanContext } from "@opentelemetry/api";
import { createTestSpanCollector } from "@harness/telemetry/testing";
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

  it.each([
    ["missing context", undefined],
    [
      "invalid context",
      { traceId: "0".repeat(32), spanId: "0".repeat(16), traceFlags: 1 } satisfies SpanContext,
    ],
  ])("omits trace context for %s", (_name, context) => {
    const unavailable = vi.fn();
    const session = new UiSession(context === undefined ? undefined : {
      runId,
      toolCallSpanContext: context,
    }, "approval", sessionId, unavailable);

    expect(session.traceparent).toBeUndefined();
    expect(unavailable).toHaveBeenCalledOnce();
    expect(() => session.end()).not.toThrow();
  });
});
