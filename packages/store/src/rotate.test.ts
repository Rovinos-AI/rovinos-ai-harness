// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import {
  decodeStoreRotationCursor,
  encodeStoreRotationCursor,
  ReencryptBatchInputSchema,
  StoreKeyRowCountSchema,
} from "./rotate.js";

describe("event-store key rotation contracts", () => {
  it("validates batch inputs and key counts with the default batch size", () => {
    expect(ReencryptBatchInputSchema.parse({ targetKeyId: "key-b" })).toEqual({
      targetKeyId: "key-b",
      limit: 500,
    });
    expect(ReencryptBatchInputSchema.safeParse({ targetKeyId: "key-b", limit: 0 }).success).toBe(
      false,
    );
    expect(StoreKeyRowCountSchema.parse({ keyId: "key-b", count: 2 })).toEqual({
      keyId: "key-b",
      count: 2,
    });
  });

  it.each([
    { table: "events" as const, after: 12 },
    { table: "snapshots" as const, after: "snapshot-id" },
    { table: "snapshots" as const },
  ])("round-trips $table cursors", (cursor) => {
    expect(decodeStoreRotationCursor(encodeStoreRotationCursor(cursor))).toEqual(cursor);
  });

  it("rejects invalid cursors", () => {
    let error: unknown;
    try {
      decodeStoreRotationCursor("invalid");
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({ code: "store_unavailable" });
  });
});
