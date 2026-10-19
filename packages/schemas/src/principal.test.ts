// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { Principal } from "./principal.js";

describe("Principal", () => {
  it.each(["token.agent", "cli.operator", "eval.simulated", "system.sweeper"])(
    "accepts %s",
    (principal) => {
      expect(Principal.safeParse(principal).success).toBe(true);
    },
  );

  it("accepts token and CLI principals at the Code length limit", () => {
    expect(Principal.safeParse(`token.${"a".repeat(58)}`).success).toBe(true);
    expect(Principal.safeParse(`cli.${"a".repeat(60)}`).success).toBe(true);
  });

  it("rejects token and CLI principals that exceed the Code length limit", () => {
    expect(Principal.safeParse(`token.${"a".repeat(59)}`).success).toBe(false);
    expect(Principal.safeParse(`cli.${"a".repeat(61)}`).success).toBe(false);
  });

  it.each(["agent", "token.", "cli.", "eval.operator", "system.operator"])(
    "rejects %s",
    (principal) => {
      expect(Principal.safeParse(principal).success).toBe(false);
    },
  );
});
