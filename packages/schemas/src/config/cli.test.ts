// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { CliConfigSchema } from "./cli.js";

describe("CLI config", () => {
  it("accepts an attributable CLI principal", () => {
    expect(CliConfigSchema.parse({ principal: "cli.operator" })).toEqual({
      principal: "cli.operator",
    });
  });

  it("rejects a non-CLI principal", () => {
    expect(CliConfigSchema.safeParse({ principal: "token.operator" }).success).toBe(false);
  });
});
