// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { SnapshotSchema } from "./snapshot.js";

const snapshot = {
  snapshotId: "00000000000000000000000001",
  runId: "00000000000000000000000002",
  atSeq: 3,
  createdAt: 10,
  traceparent: `00-${"a".repeat(32)}-${"b".repeat(16)}-01`,
  context: { messages: ["synthetic context"] },
  plan: ["synthetic plan"],
};

describe("SnapshotSchema", () => {
  it("parses snapshots with and without a workspace reference", () => {
    expect(SnapshotSchema.parse(snapshot)).toEqual(snapshot);
    expect(
      SnapshotSchema.parse({ ...snapshot, workspaceRef: "workspace:synthetic" }),
    ).toMatchObject({ workspaceRef: "workspace:synthetic" });
  });

  it("rejects invalid identifiers, sequences, JSON content, and extra keys", () => {
    expect(SnapshotSchema.safeParse({ ...snapshot, snapshotId: "invalid" }).success).toBe(false);
    expect(SnapshotSchema.safeParse({ ...snapshot, atSeq: -1 }).success).toBe(false);
    expect(SnapshotSchema.safeParse({ ...snapshot, context: { nested: undefined } }).success).toBe(
      false,
    );
    expect(SnapshotSchema.safeParse({ ...snapshot, unexpected: true }).success).toBe(false);
  });
});
