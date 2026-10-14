// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { AppRequestResultSchema } from "./app-request.js";

describe("AppRequestResultSchema", () => {
  it("accepts only the minimal gate result", () => {
    expect(AppRequestResultSchema.parse({ allowed: true })).toEqual({ allowed: true });
    expect(AppRequestResultSchema.safeParse({ allowed: false, payload: "synthetic" }).success).toBe(
      false,
    );
  });
});
