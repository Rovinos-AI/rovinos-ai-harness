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

  it.each(["agent", "token.", "cli.", "eval.operator", "system.operator"])(
    "rejects %s",
    (principal) => {
      expect(Principal.safeParse(principal).success).toBe(false);
    },
  );
});
