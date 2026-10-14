// SPDX-License-Identifier: Apache-2.0
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { trace } from "@opentelemetry/api";
import { createTestSpanCollector } from "@harness/telemetry/testing";
import type { AppSpanStampContext } from "./stamp.js";
import { ingestBatch } from "./app-telemetry.js";

const collector = createTestSpanCollector();
const validStamp: AppSpanStampContext = {
  appId: "approval",
  runId: "00000000000000000000000001",
  sessionId: "00000000000000000000000002",
  sessionStartTime: 0,
  parent: {
    traceId: "a".repeat(32),
    spanId: "b".repeat(16),
    traceFlags: 1,
  },
  clock: { now: () => 100 },
  hasPendingApproval: true,
};

beforeAll(() => {
  trace.setGlobalTracerProvider(collector.provider);
});

afterAll(async () => {
  await collector.provider.shutdown();
});

describe("ingestBatch", () => {
  it("refuses valid spans without host session context", () => {
    const initialCount = collector.getFinishedSpans().length;
    const reasons: string[] = [];
    const acknowledgment = ingestBatch(
      { spans: [{ name: "ui.render", startOffsetMs: 0, durationMs: 1 }] },
      { onRejected: (reason) => reasons.push(reason) },
    );

    expect(acknowledgment).toEqual({ accepted: 0, dropped: 1 });
    expect(reasons).toEqual(["unknown_app"]);
    expect(collector.getFinishedSpans()).toHaveLength(initialCount);
  });

  it("accepts all registered span kinds with validated attributes only", () => {
    const start = collector.getFinishedSpans().length;
    const acknowledgment = ingestBatch(
      {
        spans: [
          { name: "ui.render", startOffsetMs: 0, durationMs: 5 },
          { name: "ui.decision", decision: "approve", startOffsetMs: 5, durationMs: 10 },
          { name: "ui.error", code: "ui.failure", startOffsetMs: 15, durationMs: 20 },
          { name: "ui.interaction", kind: "click", count: 2, startOffsetMs: 35, durationMs: 25 },
        ],
      },
      { stamp: validStamp },
    );
    const spans = collector.getFinishedSpans().slice(start);

    expect(acknowledgment).toEqual({ accepted: 4, dropped: 0 });
    expect(spans.map((span) => span.name)).toEqual([
      "harness.ui.render",
      "harness.ui.decision",
      "harness.ui.error",
      "harness.ui.interaction",
    ]);
    expect(spans[0]?.attributes).toMatchObject({
      "harness.app.id": "approval",
      "harness.run.id": validStamp.runId,
      "harness.ui.session_id": validStamp.sessionId,
      "harness.ui.duration_ms": 5,
    });
    expect(spans[0]?.attributes["harness.ui.start_offset_ms"]).toBeUndefined();
    expect(spans[1]?.attributes["harness.ui.decision"]).toBe("approve");
    expect(spans[2]?.attributes["harness.error.code"]).toBe("ui.failure");
    expect(spans[3]?.attributes).toMatchObject({
      "harness.ui.interaction.kind": "click",
      "harness.ui.interaction.count": 2,
    });
  });

  it("drops invalid and unknown spans independently and never exports their canary values", () => {
    const canary = "INVALID-CANARY-9f2865";
    const start = collector.getFinishedSpans().length;
    const reasons: string[] = [];
    const acknowledgment = ingestBatch(
      {
        spans: [
          { name: "ui.render", startOffsetMs: "0", durationMs: 1 },
          {
            name: "ui.render",
            startOffsetMs: 0,
            durationMs: 1,
            "harness.run.id": canary,
          },
          { name: "ui.error", code: canary, startOffsetMs: 0, durationMs: 1 },
          { name: "ui.interaction", kind: "click", count: 1001, startOffsetMs: 0, durationMs: 1 },
          { name: "ui.unknown", value: canary },
          { name: "ui.render", startOffsetMs: 0, durationMs: 1 },
        ],
      },
      { stamp: validStamp, onRejected: (reason) => reasons.push(reason) },
    );
    const spans = collector.getFinishedSpans().slice(start);
    const exported = JSON.stringify(spans.map(({ name, attributes }) => ({ name, attributes })));

    expect(acknowledgment).toEqual({ accepted: 1, dropped: 5 });
    expect(reasons).toEqual(["schema", "schema", "schema", "schema", "unknown_span"]);
    expect(exported).not.toContain(canary);
    expect(JSON.stringify(reasons)).not.toContain(canary);
    expect(spans.map((span) => span.name)).toEqual(["harness.ui.render"]);
  });

  it("silently drops valid spans refused by the session cap", () => {
    const reasons: string[] = [];
    let accepted = 0;
    const acknowledgment = ingestBatch(
      {
        spans: [
          { name: "ui.render", startOffsetMs: 0, durationMs: 1 },
          { name: "ui.render", startOffsetMs: 1, durationMs: 1 },
        ],
      },
      {
        acceptSpan: () => {
          accepted += 1;
          return accepted === 1 ? true : "session_cap";
        },
        stamp: validStamp,
        onRejected: (reason) => reasons.push(reason),
      },
    );

    expect(acknowledgment).toEqual({ accepted: 1, dropped: 1 });
    expect(reasons).toEqual(["session_cap"]);
  });

  it("reports a missing host stamp as an unknown app", () => {
    const reasons: string[] = [];
    expect(
      ingestBatch(
        { spans: [{ name: "ui.render", startOffsetMs: 0, durationMs: 1 }] },
        { onRejected: (reason) => reasons.push(reason) },
      ),
    ).toEqual({ accepted: 0, dropped: 1 });
    expect(reasons).toEqual(["unknown_app"]);
  });

  it("rejects malformed batches, extra keys, and arrays over fifty spans", () => {
    const reasons: string[] = [];
    expect(
      ingestBatch(null, { stamp: validStamp, onRejected: (reason) => reasons.push(reason) }),
    ).toEqual({
      accepted: 0,
      dropped: 1,
    });
    expect(
      ingestBatch(
        { spans: [{ name: "ui.render", startOffsetMs: 0, durationMs: 1 }], extra: true },
        { stamp: validStamp, onRejected: (reason) => reasons.push(reason) },
      ),
    ).toEqual({ accepted: 0, dropped: 1 });
    expect(
      ingestBatch(
        { spans: Array.from({ length: 51 }, () => ({ name: "ui.render" })) },
        { onRejected: (reason) => reasons.push(reason) },
      ),
    ).toEqual({ accepted: 0, dropped: 51 });
    expect(reasons).toEqual(["schema", "schema", "size"]);
  });

  it("allows exactly sixteen KiB and rejects a batch one byte larger", () => {
    const size = 16 * 1024;
    const prefix = '{"spans":[{"padding":"';
    const suffix = '"}]}';
    const exactBatch = { spans: [{ padding: "x".repeat(size - prefix.length - suffix.length) }] };
    const oversizedBatch = {
      spans: [{ padding: "x".repeat(size + 1 - prefix.length - suffix.length) }],
    };
    const reasons: string[] = [];
    const exactAck = ingestBatch(exactBatch, { onRejected: (reason) => reasons.push(reason) });
    const oversizedAck = ingestBatch(oversizedBatch, {
      onRejected: (reason) => reasons.push(reason),
    });

    expect(Buffer.byteLength(JSON.stringify(exactBatch), "utf8")).toBe(size);
    expect(Buffer.byteLength(JSON.stringify(oversizedBatch), "utf8")).toBe(size + 1);
    expect(exactAck).toEqual({ accepted: 0, dropped: 1 });
    expect(oversizedAck).toEqual({ accepted: 0, dropped: 1 });
    expect(reasons).toEqual(["schema", "size"]);
  });

  it("rejects non-JSON input safely and returns only nonnegative integer counts", () => {
    const reasons: string[] = [];
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const acknowledgments = [
      ingestBatch(undefined, {
        stamp: validStamp,
        onRejected: (reason) => reasons.push(reason),
      }),
      ingestBatch(cyclic, { stamp: validStamp, onRejected: (reason) => reasons.push(reason) }),
      ingestBatch(
        { spans: [{ name: "ui.render", startOffsetMs: 0, durationMs: 0 }] },
        {
          stamp: validStamp,
          onRejected: () => {
            throw new Error("observer failure");
          },
        },
      ),
    ];

    expect(acknowledgments[0]).toEqual({ accepted: 0, dropped: 1 });
    expect(acknowledgments[1]).toEqual({ accepted: 0, dropped: 1 });
    expect(acknowledgments[2]).toEqual({ accepted: 1, dropped: 0 });
    for (const acknowledgment of acknowledgments) {
      expect(Object.keys(acknowledgment).sort()).toEqual(["accepted", "dropped"]);
      expect(
        Object.values(acknowledgment).every((value) => Number.isInteger(value) && value >= 0),
      ).toBe(true);
    }
    expect(reasons).toEqual(["schema", "schema"]);
  });
});
