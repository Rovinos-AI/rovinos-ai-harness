// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { PolicyConfigSchema } from "./policy.js";

describe("PolicyConfigSchema", () => {
  it("defaults to an empty config and accepts a policy file", () => {
    expect(PolicyConfigSchema.parse({})).toEqual({});
    expect(PolicyConfigSchema.parse({ file: "examples/policy.yaml" })).toEqual({
      file: "examples/policy.yaml",
    });
  });

  it("rejects empty paths and unknown config fields", () => {
    expect(PolicyConfigSchema.safeParse({ file: "" }).success).toBe(false);
    expect(PolicyConfigSchema.safeParse({ unknown: true }).success).toBe(false);
  });
});
