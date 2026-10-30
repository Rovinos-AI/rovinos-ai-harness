// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import {
  applyUpcasterChain,
  upcastEvent,
  upcastSnapshot,
  type EventUpcaster,
} from "./event-versions.js";

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
