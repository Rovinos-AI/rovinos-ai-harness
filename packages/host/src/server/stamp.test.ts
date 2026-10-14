// SPDX-License-Identifier: Apache-2.0
import { trace } from "@opentelemetry/api";
import { FakeClock } from "@harness/schemas";
import { AllowlistSpanProcessor } from "@harness/telemetry";
import { createTestSpanCollector } from "@harness/telemetry/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ingestBatch } from "./app-telemetry.js";
import { UI_SESSION_SPAN } from "./ui-session.js";
import { stampAppSpan, type AppSpanStampContext } from "./stamp.js";

const collector = createTestSpanCollector();
const runId = "00000000000000000000000001";
const appId = "approval";
const sessionId = "00000000000000000000000002";
const sessionStartTime = 1_700_000_000_000;

beforeAll(() => {
  trace.setGlobalTracerProvider(collector.provider);
});

afterAll(async () => {
  await collector.provider.shutdown();
});

function createStampContext(
  clock: FakeClock,
  parentSpanId: string,
  overrides: Partial<AppSpanStampContext> = {},
): AppSpanStampContext {
  return {
    appId,
    runId,
    sessionId,
    sessionStartTime,
    parent: {
      traceId: "a".repeat(32),
      spanId: parentSpanId,
      traceFlags: 1,
    },
    clock,
    hasPendingApproval: true,
    ...overrides,
  };
}

function timeInMilliseconds(time: readonly [number, number] | undefined): number | undefined {
  return time === undefined ? undefined : time[0] * 1_000 + time[1] / 1_000_000;
}

describe("stampAppSpan", () => {
  it("uses host identity and trusted clamped timing and parent through the allowlist processor", () => {
    const initialCount = collector.getFinishedSpans().length;
    const parent = UI_SESSION_SPAN.start({
      "harness.app.id": appId,
      "harness.run.id": runId,
      "harness.ui.session_id": sessionId,
    });
    const clock = new FakeClock(sessionStartTime + 100);
    const input = {
      name: "ui.render" as const,
      startOffsetMs: Number.MAX_SAFE_INTEGER,
      durationMs: 3_600_000,
    };

    expect(
      stampAppSpan(input, createStampContext(clock, parent.spanContext().spanId)),
    ).toBeUndefined();
    parent.end();

    const finished = collector
      .getFinishedSpans()
      .slice(initialCount)
      .find((span) => span.name === "harness.ui.render");
    expect(finished).toBeDefined();
    if (finished === undefined) {
      throw new Error("The stamped span was not exported.");
    }
    const allowlisted: Parameters<AllowlistSpanProcessor["onEnd"]>[0][] = [];
    const processor = new AllowlistSpanProcessor(
      {
        onStart: () => undefined,
        onEnd: (span) => allowlisted.push(span),
        forceFlush: () => Promise.resolve(),
        shutdown: () => Promise.resolve(),
      },
      { telemetry: { sentinel: { minValueLength: 6, enabled: false } } },
    );
    processor.onEnd(finished);

    expect(allowlisted).toHaveLength(1);
    expect(allowlisted[0]?.attributes).toMatchObject({
      "harness.app.id": appId,
      "harness.run.id": runId,
      "harness.ui.session_id": sessionId,
      "harness.ui.duration_ms": 100,
    });
    expect(allowlisted[0]?.attributes["harness.ui.start_offset_ms"]).toBeUndefined();
    expect(timeInMilliseconds(allowlisted[0]?.startTime)).toBe(sessionStartTime);
    expect(timeInMilliseconds(allowlisted[0]?.endTime)).toBe(sessionStartTime + 100);
    expect(allowlisted[0]?.parentSpanContext?.spanId).toBe(parent.spanContext().spanId);
  });

  it("rejects app-supplied host identity fields without exporting their canary", () => {
    const canary = "spoofed-run-id-canary";
    const reasons: string[] = [];
    const result = ingestBatch(
      {
        spans: [
          {
            name: "ui.render",
            startOffsetMs: 0,
            durationMs: 1,
            "harness.run.id": canary,
          },
        ],
      },
      {
        stamp: createStampContext(new FakeClock(sessionStartTime + 100), "b".repeat(16)),
        onRejected: (reason) => reasons.push(reason),
      },
    );

    expect(result).toEqual({ accepted: 0, dropped: 1 });
    expect(reasons).toEqual(["schema"]);
    expect(
      JSON.stringify(
        collector.getFinishedSpans().map(({ name, attributes }) => ({ name, attributes })),
      ),
    ).not.toContain(canary);
  });

  it("rejects decision telemetry unless an approval is pending for the session run", () => {
    const reasons: string[] = [];
    const initialCount = collector.getFinishedSpans().length;
    const result = ingestBatch(
      {
        spans: [
          {
            name: "ui.decision",
            decision: "approve",
            startOffsetMs: 0,
            durationMs: 1,
          },
        ],
      },
      {
        stamp: createStampContext(new FakeClock(sessionStartTime + 100), "b".repeat(16), {
          hasPendingApproval: false,
        }),
        onRejected: (reason) => reasons.push(reason),
      },
    );

    expect(result).toEqual({ accepted: 0, dropped: 1 });
    expect(reasons).toEqual(["unknown_span"]);
    expect(collector.getFinishedSpans()).toHaveLength(initialCount);
  });

  it("fails closed when host timing is invalid or the host clock fails", () => {
    const span = { name: "ui.render" as const, startOffsetMs: 0, durationMs: 1 };
    const parentSpanId = "b".repeat(16);

    expect(
      stampAppSpan(span, createStampContext(new FakeClock(sessionStartTime - 1), parentSpanId)),
    ).toBe("schema");
    expect(
      stampAppSpan(span, createStampContext(new FakeClock(sessionStartTime + 100), "0".repeat(16))),
    ).toBe("schema");
    expect(
      stampAppSpan(
        span,
        createStampContext(new FakeClock(sessionStartTime), parentSpanId, {
          sessionStartTime: Number.MAX_SAFE_INTEGER,
        }),
      ),
    ).toBe("schema");
    expect(
      stampAppSpan(
        span,
        createStampContext(new FakeClock(sessionStartTime), parentSpanId, {
          sessionStartTime: Number.NaN,
        }),
      ),
    ).toBe("schema");
    expect(
      stampAppSpan(span, {
        ...createStampContext(new FakeClock(sessionStartTime + 100), parentSpanId),
        clock: {
          now: () => {
            throw new Error("synthetic clock failure");
          },
        },
      }),
    ).toBe("schema");
  });
});
