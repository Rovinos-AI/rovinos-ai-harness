// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { PolicyDecisionSchema } from "../ports.js";
import { allowAllPolicy } from "./allow-policy.js";

describe("allowAllPolicy", () => {
  it("allows any call with a valid decision and a stable version", () => {
    const decision = allowAllPolicy.decide({ toolId: "any.tool", args: null }, { subagent: true });

    expect(PolicyDecisionSchema.parse(decision)).toEqual({
      decision: "allow",
      ruleId: "test_allow",
      reason: "test_allowed",
      editable: [],
    });
    expect(allowAllPolicy.version).toBe("test.policy");
  });
});
