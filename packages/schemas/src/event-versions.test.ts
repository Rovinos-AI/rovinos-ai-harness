// SPDX-License-Identifier: Apache-2.0
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  RawEventEnvelopeSchema,
  applyUpcasterChain,
  upcastEvent,
  upcastSnapshot,
  type EventUpcaster,
} from "./event-versions.js";
import { parseJson } from "./parse.js";
import { JsonValue } from "./json.js";

const envelope = {
  runId: "00000000000000000000000001",
  seq: 4,
  ts: 10,
  type: "approval_resolved",
  v: 1,
  traceId: "a".repeat(32),
  spanId: "b".repeat(16),
  segmentId: "00000000000000000000000001",
};

function addFlag(payload: unknown, key: string): unknown {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return payload;
  }
  return { ...payload, [key]: true };
}

describe("event schema upcasting", () => {
  it("upcasts v1 model requests without inventing hashes of unrecorded parameters", () => {
    const raw = {
      ...envelope,
      type: "model_request",
      requestId: "00000000000000000000000002",
      provider: "synthetic",
      model: "synthetic",
      requestHash: "c".repeat(64),
      messages: [{ role: "user", parts: [{ type: "text", text: "<EMAIL_1>" }] }],
    };
    expect(upcastEvent(raw)).toEqual({ ...raw, v: 2, requestParametersHash: null });
    expect(raw).not.toHaveProperty("requestParametersHash");
    expect(() => upcastEvent({ ...raw, unexpected: true })).toThrow();
  });

  it("applies every consecutive upcaster in a 1-to-3 chain", () => {
    const upcasters: Readonly<Record<number, EventUpcaster>> = {
      1: (payload) => addFlag(payload, "first"),
      2: (payload) => addFlag(payload, "second"),
    };

    expect(
      applyUpcasterChain({
        payload: {},
        initialVersion: 1,
        currentVersion: 3,
        upcasters,
        path: "test",
      }),
    ).toEqual({
      payload: { first: true, second: true },
      version: 3,
    });
  });

  it("reports missing and failing upcasters without exposing thrown messages", () => {
    expect(() =>
      applyUpcasterChain({ payload: {}, initialVersion: 1, currentVersion: 2, path: "test" }),
    ).toThrow(expect.objectContaining({ code: "contract_invalid" }));
    expect(() =>
      applyUpcasterChain({
        payload: {},
        initialVersion: 1,
        currentVersion: 2,
        path: "test",
        upcasters: {
          1: () => {
            throw new Error("synthetic private detail");
          },
        },
      }),
    ).toThrow(expect.objectContaining({ code: "contract_invalid" }));
  });

  it("upcasts v1 approval resolutions before strict current-schema validation", () => {
    const event = upcastEvent({
      ...envelope,
      approvalId: "00000000000000000000000002",
      decision: "approve",
      approverId: "cli.synthetic",
      waitMs: 1,
    });

    expect(event).toMatchObject({ type: "approval_resolved", v: 2, decidedBy: "human" });
    expect(() => upcastEvent({ ...event, unexpected: true })).toThrow();
    expect(() =>
      upcastEvent({
        ...envelope,
        approvalId: "00000000000000000000000002",
        decision: "approve",
        approverId: "cli.synthetic",
        waitMs: -1,
      }),
    ).toThrow();
  });

  it("wraps v1 tool results without changing their original JSON value", () => {
    const result = {
      content: [{ type: "text", text: "legacy value" }],
      binary: [0, 255, 7],
    };
    const event = upcastEvent({
      ...envelope,
      type: "tool_result",
      callId: "00000000000000000000000002",
      toolId: "legacy.tool",
      outcome: "ok",
      latencyMs: 1,
      result,
    });

    expect(event).toMatchObject({
      type: "tool_result",
      v: 2,
      result: { format: "legacy-json", version: 1, value: result },
    });
    expect(result).toEqual({
      content: [{ type: "text", text: "legacy value" }],
      binary: [0, 255, 7],
    });
  });

  it("reads legacy tool results from the committed v1 log fixture", async () => {
    const source = await readFile(
      new URL("../../../test/fixtures/legacy-logs/v1/golden.jsonl", import.meta.url),
      "utf8",
    );
    const events = source
      .split("\n")
      .filter((line) => line.length > 0)
      .filter((line) =>
        RawEventEnvelopeSchema.safeParse(parseJson(JsonValue, line)).success,
      )
      .map((line) => parseJson(RawEventEnvelopeSchema, line));
    const raw = events.find((event) => event.type === "tool_result");
    if (raw === undefined) {
      throw new Error("Missing legacy tool result fixture.");
    }

    const event = upcastEvent(raw);
    expect(event.type).toBe("tool_result");
    if (event.type === "tool_result") {
      expect(event.v).toBe(2);
      expect(event.result).toMatchObject({
        format: "legacy-json",
        version: 1,
        value: { tool: "synthetic.idempotent", value: { key: "synthetic" } },
      });
    }
  });

  it("preserves explicit v1 resolution decisions and rejects malformed or future envelopes", () => {
    const event = upcastEvent({
      ...envelope,
      approvalId: "00000000000000000000000002",
      decision: "deny",
      decidedBy: "expiry",
      reason: "expired",
      waitMs: 1,
    });

    expect(event).toMatchObject({ v: 2, decidedBy: "expiry", reason: "expired" });
    expect(() => upcastEvent({ ...envelope, v: 3 })).toThrow();
    expect(() => upcastEvent({ ...envelope, seq: -1 })).toThrow();
  });

  it("upcasts snapshots with the shared version-chain mechanism", () => {
    const snapshot = upcastSnapshot({
      snapshotId: "00000000000000000000000002",
      runId: "00000000000000000000000001",
      atSeq: 4,
      createdAt: 10,
      traceparent: `00-${"a".repeat(32)}-${"b".repeat(16)}-01`,
      context: {},
      plan: [],
    });

    expect(snapshot.v).toBe(1);
    expect(() => upcastSnapshot({ ...snapshot, v: 2 })).toThrow();
    expect(() => upcastSnapshot({ snapshotId: snapshot.snapshotId })).toThrow();
  });
});
