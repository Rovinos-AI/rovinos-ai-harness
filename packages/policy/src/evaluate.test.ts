// SPDX-License-Identifier: Apache-2.0
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { JsonValue } from "@harness/schemas";
import { evaluate, type PolicyCall, PolicyCallSchema } from "./index.js";
import { PolicyDocumentSchema, RuleSchema } from "./schema.js";
import type { ArgMatcher, PolicyDocument, Rule } from "./schema.js";

const RAW_CANARY = "policy-raw-canary@example.test";

class PolicyRawValueSuspectedError extends Error {
  readonly code = "policy_raw_value_suspected";

  constructor() {
    super("policy_raw_value_suspected");
  }
}

function containsRawCanary(value: JsonValue): boolean {
  if (typeof value === "string") {
    return value.includes(RAW_CANARY);
  }
  if (Array.isArray(value)) {
    return value.some(containsRawCanary);
  }
  if (value !== null && typeof value === "object") {
    return Object.keys(value).some((key) => {
      const child = value[key];
      return child !== undefined && containsRawCanary(child);
    });
  }
  return false;
}

function evaluateTokenized(doc: PolicyDocument, call: PolicyCall) {
  if (containsRawCanary(call.args)) {
    throw new PolicyRawValueSuspectedError();
  }
  return evaluate(doc, call);
}

function createRule(
  id: string,
  decision: Rule["decision"],
  match: Rule["match"] = { tools: ["mail.send"] },
  options: Partial<Pick<Rule, "editable" | "approvalTtlMs" | "escalateAfterMs">> = {},
): Rule {
  return RuleSchema.parse({
    id,
    decision,
    reason: `reason_${id}`,
    match,
    ...options,
  });
}

function createPolicy(
  rules: Rule[] = [],
  defaultDecision: PolicyDocument["defaultDecision"] = "deny",
): PolicyDocument {
  return PolicyDocumentSchema.parse({ version: 1, defaultDecision, rules });
}

function createCall(
  args: JsonValue = { to: "<EMAIL_1>" },
  toolId = "mail.send",
  context: PolicyCall["context"] = {},
): PolicyCall {
  return PolicyCallSchema.parse({ toolId, args, context });
}

function decisionRank(decision: Rule["decision"]): number {
  switch (decision) {
    case "allow":
      return 0;
    case "ask":
      return 1;
    case "deny":
      return 2;
  }
}

const CALL = createCall();
const argumentCases: {
  readonly name: string;
  readonly args: JsonValue;
  readonly matcher: ArgMatcher;
  readonly matches: boolean;
}[] = [
  {
    name: "equals",
    args: { to: "<EMAIL_1>" },
    matcher: { pointer: "/to", op: "equals", value: "<EMAIL_1>" },
    matches: true,
  },
  {
    name: "in",
    args: { to: "<EMAIL_1>" },
    matcher: { pointer: "/to", op: "in", value: ["<EMAIL_2>", "<EMAIL_1>"] },
    matches: true,
  },
  {
    name: "startsWith",
    args: { recipient: "mailto:person@example.test" },
    matcher: { pointer: "/recipient", op: "startsWith", value: "mailto:" },
    matches: true,
  },
  {
    name: "matches",
    args: { recipient: "hello@example.test" },
    matcher: { pointer: "/recipient", op: "matches", value: "^hello" },
    matches: true,
  },
  {
    name: "exists for null",
    args: { value: null },
    matcher: { pointer: "/value", op: "exists" },
    matches: true,
  },
  {
    name: "tokenType",
    args: { to: "<EMAIL_1>" },
    matcher: { pointer: "/to", op: "tokenType", value: "email" },
    matches: true,
  },
  {
    name: "missing pointers",
    args: { to: "<EMAIL_1>" },
    matcher: { pointer: "/missing", op: "equals", value: "anything" },
    matches: false,
  },
  {
    name: "non-string startsWith",
    args: { count: 1 },
    matcher: { pointer: "/count", op: "startsWith", value: "1" },
    matches: false,
  },
  {
    name: "non-string matches",
    args: { count: 1 },
    matcher: { pointer: "/count", op: "matches", value: "1" },
    matches: false,
  },
  {
    name: "tokenType rejects non-token strings",
    args: { to: "EMAIL_1" },
    matcher: { pointer: "/to", op: "tokenType", value: "email" },
    matches: false,
  },
];

describe("evaluate", () => {
  it.each([
    { decisions: ["allow", "deny"], selected: "rule_1" },
    { decisions: ["deny", "allow"], selected: "rule_0" },
    { decisions: ["ask", "deny", "allow"], selected: "rule_1" },
    { decisions: ["deny", "ask"], selected: "rule_0" },
  ] as const)("applies restrictive precedence for $decisions", ({ decisions, selected }) => {
    const rules = decisions.map((decision, index) => createRule(`rule_${String(index)}`, decision));
    const explanation = evaluateTokenized(createPolicy(rules, "ask"), CALL);

    expect(explanation.decision).toBe("deny");
    expect(explanation.ruleId).toBe(selected);
    expect(explanation.matched).toEqual(
      rules.map(({ id, decision }) => ({ ruleId: id, decision })),
    );
  });

  it("uses the first document rule when matching decisions tie", () => {
    const explanation = evaluateTokenized(
      createPolicy([createRule("first_deny", "deny"), createRule("second_deny", "deny")]),
      CALL,
    );

    expect(explanation).toMatchObject({
      decision: "deny",
      ruleId: "first_deny",
      reason: "reason_first_deny",
    });
  });

  it.each(["ask", "deny"] as const)(
    "uses the %s default when no rule matches",
    (defaultDecision) => {
      const explanation = evaluateTokenized(
        createPolicy([createRule("other_tool", "allow", { tools: ["fs.read"] })], defaultDecision),
        CALL,
      );

      expect(explanation).toEqual({
        decision: defaultDecision,
        ruleId: "default",
        reason: "default_decision",
        matched: [],
        editable: [],
      });
    },
  );

  it("returns approval details from the selected ask rule", () => {
    const explanation = evaluateTokenized(
      createPolicy([
        createRule("allow_rule", "allow"),
        createRule(
          "ask_rule",
          "ask",
          { tools: ["mail.send"] },
          {
            editable: ["/subject"],
            approvalTtlMs: 30_000,
            escalateAfterMs: 10_000,
          },
        ),
        createRule("later_ask", "ask"),
      ]),
      CALL,
    );

    expect(explanation).toMatchObject({
      decision: "ask",
      ruleId: "ask_rule",
      reason: "reason_ask_rule",
      editable: ["/subject"],
      approvalTtlMs: 30_000,
      escalateAfterMs: 10_000,
      matched: [
        { ruleId: "allow_rule", decision: "allow" },
        { ruleId: "ask_rule", decision: "ask" },
        { ruleId: "later_ask", decision: "ask" },
      ],
    });
  });

  it.each(argumentCases)("matches the $name argument operation", ({ args, matcher, matches }) => {
    const rule = createRule("argument_rule", "ask", {
      tools: ["mail.send"],
      args: [matcher],
    });
    const explanation = evaluateTokenized(createPolicy([rule]), createCall(args));

    expect(explanation.decision).toBe(matches ? "ask" : "deny");
  });

  it.each([
    { pointer: "/items/0", expected: "first", matches: true },
    { pointer: "/items/1", expected: "missing", matches: false },
    { pointer: "/items/00", expected: "first", matches: false },
    { pointer: "/items/name", expected: "first", matches: false },
    { pointer: "/items/0/child", expected: "first", matches: false },
    { pointer: "/a~1b/~0key", expected: null, matches: true },
  ])(
    "resolves JSON pointer $pointer with safe object and array traversal",
    ({ pointer, expected, matches }) => {
      const rule = createRule("pointer_rule", "ask", {
        tools: ["mail.send"],
        args: [{ pointer, op: "equals", value: expected }],
      });
      const args: JsonValue = {
        items: ["first"],
        "a/b": { "~key": null },
      };

      expect(evaluateTokenized(createPolicy([rule]), createCall(args)).decision).toBe(
        matches ? "ask" : "deny",
      );
    },
  );

  it("supports root pointers and structural JSON equality independent of object key order", () => {
    const args: JsonValue = { nested: { first: 1, second: [true, null] } };
    const rule = createRule("root_pointer", "ask", {
      tools: ["mail.send"],
      args: [
        {
          pointer: "",
          op: "equals",
          value: { nested: { second: [true, null], first: 1 } },
        },
      ],
    });

    expect(evaluateTokenized(createPolicy([rule]), createCall(args)).decision).toBe("ask");
  });

  it.each([
    { toolId: "fs.read", matches: true },
    { toolId: "fs.read.file", matches: true },
    { toolId: "fs", matches: false },
    { toolId: "filesystem.read", matches: false },
  ])("matches a trailing wildcard for $toolId", ({ toolId, matches }) => {
    const rule = createRule("wildcard_rule", "ask", { tools: ["fs.*"] });

    expect(evaluateTokenized(createPolicy([rule]), createCall({}, toolId)).decision).toBe(
      matches ? "ask" : "deny",
    );
  });

  it("matches a global wildcard and applies all specified context conditions", () => {
    const rule = createRule("context_rule", "ask", {
      tools: "*",
      context: { subagent: false, server: "mail" },
    });
    const matchingCall = createCall({}, "mail.send", { subagent: false, server: "mail" });
    const wrongSubagent = createCall({}, "mail.send", { subagent: true, server: "mail" });
    const wrongServer = createCall({}, "mail.send", { subagent: false, server: "fs" });

    expect(evaluateTokenized(createPolicy([rule]), matchingCall).decision).toBe("ask");
    expect(evaluateTokenized(createPolicy([rule]), wrongSubagent).decision).toBe("deny");
    expect(evaluateTokenized(createPolicy([rule]), wrongServer).decision).toBe("deny");
  });

  it("does not mutate policy or call inputs", () => {
    const doc = createPolicy([createRule("deny_rule", "deny")]);
    const call = createCall({ to: "<EMAIL_1>" });
    const docBefore = JSON.stringify(doc);
    const callBefore = JSON.stringify(call);

    evaluateTokenized(doc, call);

    expect(JSON.stringify(doc)).toBe(docBefore);
    expect(JSON.stringify(call)).toBe(callBefore);
  });

  it("rejects a known raw-value canary in the test-only token guard", () => {
    let errorCode: string | undefined;
    try {
      evaluateTokenized(createPolicy(), createCall({ nested: [RAW_CANARY] }));
    } catch (error) {
      if (error instanceof PolicyRawValueSuspectedError) {
        errorCode = error.code;
      }
    }

    expect(errorCode).toBe("policy_raw_value_suspected");
  });

  it("validates call input at the evaluator boundary", () => {
    expect(() =>
      evaluate(createPolicy(), {
        toolId: "invalid tool",
        args: {},
        context: {},
      }),
    ).toThrow();
  });

  it("property: adding a deny never makes a call more permitted", () => {
    const decisions = fc.array(fc.constantFrom<Rule["decision"]>("allow", "ask", "deny"), {
      maxLength: 12,
    });
    const defaults = fc.constantFrom<PolicyDocument["defaultDecision"]>("ask", "deny");

    fc.assert(
      fc.property(decisions, defaults, (ruleDecisions, defaultDecision) => {
        const rules = ruleDecisions.map((decision, index) =>
          createRule(`rule_${String(index)}`, decision),
        );
        const doc = createPolicy(rules, defaultDecision);
        const before = evaluateTokenized(doc, CALL);
        const withDeny = createPolicy(
          [...rules, createRule(`appended_deny_${String(rules.length)}`, "deny")],
          defaultDecision,
        );
        const after = evaluateTokenized(withDeny, CALL);

        expect(decisionRank(after.decision)).toBeGreaterThanOrEqual(decisionRank(before.decision));
        expect(before.decision !== "deny" || after.decision === "deny").toBe(true);
      }),
    );
  });

  it("property: removing allow rules never makes a call more permitted", () => {
    const decisions = fc.array(fc.constantFrom<Rule["decision"]>("allow", "ask", "deny"), {
      maxLength: 12,
    });
    const defaults = fc.constantFrom<PolicyDocument["defaultDecision"]>("ask", "deny");

    fc.assert(
      fc.property(decisions, defaults, (ruleDecisions, defaultDecision) => {
        const rules = ruleDecisions.map((decision, index) =>
          createRule(`rule_${String(index)}`, decision),
        );
        const doc = createPolicy(rules, defaultDecision);
        const withoutAllows = createPolicy(
          rules.filter((rule) => rule.decision !== "allow"),
          defaultDecision,
        );

        expect(
          decisionRank(evaluateTokenized(withoutAllows, CALL).decision),
        ).toBeGreaterThanOrEqual(decisionRank(evaluateTokenized(doc, CALL).decision));
      }),
    );
  });
});
