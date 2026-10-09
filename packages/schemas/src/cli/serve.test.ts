// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { ServeResultSchema } from "./serve.js";

describe("ServeResultSchema", () => {
  it("accepts the service startup result", () => {
    expect(ServeResultSchema.parse({ status: "serving" })).toEqual({ status: "serving" });
  });

  it("rejects unexpected statuses and properties", () => {
    expect(ServeResultSchema.safeParse({ status: "stopped" }).success).toBe(false);
    expect(ServeResultSchema.safeParse({ status: "serving", detail: "private" }).success).toBe(
      false,
    );
  });
});
