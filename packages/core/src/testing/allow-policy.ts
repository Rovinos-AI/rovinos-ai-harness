// SPDX-License-Identifier: Apache-2.0
// Runtimes without a policy deny every tool; tests that exercise tool execution opt in here.
import { Code } from "@harness/schemas";
import type { PolicyPort } from "../ports.js";

/** Test policy that allows every tool call with a fixed rule, reason, and version. */
export const allowAllPolicy: PolicyPort = Object.freeze({
  version: Code.parse("test.policy"),
  decide: () => ({
    decision: "allow" as const,
    ruleId: Code.parse("test_allow"),
    reason: Code.parse("test_allowed"),
    editable: [],
  }),
});
