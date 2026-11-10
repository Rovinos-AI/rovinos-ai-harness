// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { ToolProfilesConfigSchema } from "./tool-profiles.js";

describe("ToolProfilesConfigSchema", () => {
  it("accepts named subsets including an empty profile", () => {
    expect(
      ToolProfilesConfigSchema.parse({
        inspect: ["server.read", "server.list"],
        disabled: [],
      }),
    ).toEqual({
      inspect: ["server.read", "server.list"],
      disabled: [],
    });
  });

  it("rejects duplicate tool IDs and bounds profile sizes", () => {
    const duplicate = ToolProfilesConfigSchema.safeParse({
      inspect: ["server.read", "server.read"],
    });
    expect(duplicate.success).toBe(false);
    expect(duplicate.error?.issues[0]?.params).toMatchObject({
      errorCode: "tool_profile_tool_duplicate",
    });

    expect(
      ToolProfilesConfigSchema.safeParse({
        inspect: Array.from({ length: 1_001 }, (_, index) => `tool.${String(index)}`),
      }).success,
    ).toBe(false);
  });

  it("rejects non-code profile names and tool IDs", () => {
    expect(ToolProfilesConfigSchema.safeParse({ "not valid": ["server.read"] }).success).toBe(
      false,
    );
    expect(ToolProfilesConfigSchema.safeParse({ inspect: ["not valid"] }).success).toBe(false);
  });
});
