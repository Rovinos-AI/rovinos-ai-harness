// SPDX-License-Identifier: Apache-2.0
import { HarnessConfigSchema } from "@rovinos/config";
import { HarnessError } from "@rovinos/schemas";
import { describe, expect, it } from "vitest";
import { cliPrincipal } from "./command.js";

describe("cliPrincipal", () => {
  it("uses the configured CLI principal or the default", () => {
    expect(cliPrincipal(HarnessConfigSchema.parse({ cli: { principal: "cli.operator" } }))).toBe(
      "cli.operator",
    );
    expect(cliPrincipal(HarnessConfigSchema.parse({}))).toBe("cli.local");
  });

  it("validates names supplied with --as", () => {
    expect(cliPrincipal(HarnessConfigSchema.parse({}), "operator")).toBe("cli.operator");
    expect(cliPrincipal(HarnessConfigSchema.parse({}), "a".repeat(60))).toBe(
      `cli.${"a".repeat(60)}`,
    );
    let error: unknown;
    try {
      cliPrincipal(HarnessConfigSchema.parse({}), "a".repeat(61));
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(HarnessError);
    expect(error).toMatchObject({ code: "usage" });
  });
});
