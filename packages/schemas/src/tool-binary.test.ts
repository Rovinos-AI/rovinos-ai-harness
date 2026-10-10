// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { ToolBinaryPayloadSchema } from "./tool-binary.js";

describe("ToolBinaryPayloadSchema", () => {
  it("round-trips unsigned bytes", () => {
    expect(ToolBinaryPayloadSchema.parse([0, 1, 255])).toEqual([0, 1, 255]);
  });
  it.each(["synthetic@example.test", [256], [-1], [0.5], ["255"], { data: [1] }])(
    "rejects non-binary input %#",
    (value) => {
      expect(ToolBinaryPayloadSchema.safeParse(value).success).toBe(false);
    },
  );
});
