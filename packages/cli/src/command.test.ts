// SPDX-License-Identifier: Apache-2.0
import { HarnessConfigSchema } from "@harness/config";
import { HarnessError } from "@harness/schemas";
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
    let error: unknown;
    try {
      cliPrincipal(HarnessConfigSchema.parse({}), "invalid name");
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(HarnessError);
    expect(error).toMatchObject({ code: "usage" });
  });
});
