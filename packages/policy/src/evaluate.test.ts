// SPDX-License-Identifier: Apache-2.0
import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";
import type { JsonValue } from "@harness/schemas";
import { compilePolicy, evaluate, type PolicyCall, PolicyCallSchema } from "./index.js";
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
  context: PolicyCall["context"] = { subagent: false },
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
const scalarJsonArbitrary: fc.Arbitrary<JsonValue> = fc.oneof(
  fc.constant(null),
  fc.boolean(),
  fc.integer({ min: -10, max: 10 }),
  fc.constantFrom("", "mail", "x", "<EMAIL_1>", "<PATH_2>"),
);
const argsArbitrary: fc.Arbitrary<JsonValue> = fc.oneof(
  scalarJsonArbitrary,
  fc.array(scalarJsonArbitrary, { maxLength: 4 }),
  fc.record({
    value: scalarJsonArbitrary,
    nested: fc.record({ value: scalarJsonArbitrary }),
    token: fc.constantFrom("<EMAIL_1>", "<PATH_2>"),
  }),
);
const pointerArbitrary = fc.constantFrom("", "/value", "/nested/value", "/missing");
const matcherArbitrary: fc.Arbitrary<ArgMatcher> = fc.oneof(
  fc
    .tuple(pointerArbitrary, scalarJsonArbitrary)
    .map(([pointer, value]) => ({ pointer, op: "equals", value }) satisfies ArgMatcher),
  fc
    .tuple(pointerArbitrary, fc.array(scalarJsonArbitrary, { maxLength: 4 }))
    .map(([pointer, value]) => ({ pointer, op: "in", value }) satisfies ArgMatcher),
  fc
    .tuple(pointerArbitrary, fc.constantFrom("", "mail", "x"))
    .map(([pointer, value]) => ({ pointer, op: "startsWith", value }) satisfies ArgMatcher),
  fc
    .tuple(pointerArbitrary, fc.constantFrom("^x$", "^mail$", "mail"))
    .map(([pointer, value]) => ({ pointer, op: "matches", value }) satisfies ArgMatcher),
  pointerArbitrary.map((pointer) => ({ pointer, op: "exists" }) satisfies ArgMatcher),
  fc
    .tuple(pointerArbitrary, fc.constantFrom("email", "path"))
    .map(([pointer, value]) => ({ pointer, op: "tokenType", value }) satisfies ArgMatcher),
);

interface GeneratedRule {
  readonly decision: Rule["decision"];
  readonly tools: Rule["match"]["tools"];
  readonly args: ArgMatcher[];
  readonly contextSubagent: boolean | null;
  readonly contextServer: string | null;
}

const generatedRuleMatchData = {
  tools: fc.constantFrom<Rule["match"]["tools"]>(
    "*",
    ["mail.send"],
    ["fs.read"],
    ["fs.*"],
    ["mail.*"],
  ),
  args: fc.array(matcherArbitrary, { maxLength: 2 }),
  contextSubagent: fc.option(fc.boolean(), { nil: null }),
  contextServer: fc.option(fc.constantFrom("mail", "fs"), { nil: null }),
};
const generatedRuleArbitrary: fc.Arbitrary<GeneratedRule> = fc.record({
  decision: fc.constantFrom<Rule["decision"]>("allow", "ask", "deny"),
  ...generatedRuleMatchData,
});
const generatedAllowRuleArbitrary: fc.Arbitrary<GeneratedRule> = fc.record({
  decision: fc.constant<Rule["decision"]>("allow"),
  ...generatedRuleMatchData,
});
const generatedRulesArbitrary = fc.array(generatedRuleArbitrary, { maxLength: 12 });
const generatedDefaultArbitrary = fc.constantFrom<PolicyDocument["defaultDecision"]>("ask", "deny");
const generatedCallArbitrary: fc.Arbitrary<PolicyCall> = fc
  .record({
    args: argsArbitrary,
    toolId: fc.constantFrom("mail.send", "mail.read", "fs.read", "fs.read.file"),
    subagent: fc.boolean(),
    server: fc.option(fc.constantFrom("mail", "fs"), { nil: null }),
  })
  .map(({ args, toolId, subagent, server }) =>
    createCall(args, toolId, { subagent, ...(server === null ? {} : { server }) }),
  );

function generatedMatch(data: GeneratedRule): Rule["match"] {
  const context = {
    ...(data.contextSubagent === null ? {} : { subagent: data.contextSubagent }),
    ...(data.contextServer === null ? {} : { server: data.contextServer }),
  };
  const tools = data.decision === "allow" && data.tools === "*" ? ["mail.send"] : data.tools;
  return {
    tools,
    ...(data.args.length === 0 ? {} : { args: data.args }),
    ...(Object.keys(context).length === 0 ? {} : { context }),
  };
}

function generatedRules(data: readonly GeneratedRule[]): Rule[] {
  return data.map((rule, index) =>
    createRule(`generated_${String(index)}`, rule.decision, generatedMatch(rule)),
  );
}

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

  it("matches policy rules against the calling app id", () => {
    const rule = createRule("app_context", "ask", {
      tools: ["mail.send"],
      context: { subagent: false, app: "approval" },
    });

    expect(
      evaluateTokenized(
        createPolicy([rule]),
        createCall({}, "mail.send", { subagent: false, app: "approval" }),
      ).decision,
    ).toBe("ask");
    expect(
      evaluateTokenized(
        createPolicy([rule]),
        createCall({}, "mail.send", { subagent: false, app: "other" }),
      ).decision,
    ).toBe("deny");
  });

  it("requires subagent context and treats a missing server as a non-MCP call", () => {
    const callWithoutServer = createCall({}, "mail.send", { subagent: false });
    const callWithServer = createCall({}, "mail.send", { subagent: false, server: "mail" });
    const subagentRule = createRule("not_subagent", "deny", {
      tools: "*",
      context: { subagent: false },
    });
    const serverRule = createRule("mail_server", "deny", {
      tools: "*",
      context: { server: "mail" },
    });

    expect(evaluateTokenized(createPolicy([subagentRule], "ask"), callWithoutServer).decision).toBe(
      "deny",
    );
    expect(evaluateTokenized(createPolicy([subagentRule], "ask"), callWithServer).decision).toBe(
      "deny",
    );
    expect(
      evaluateTokenized(
        createPolicy([subagentRule], "ask"),
        createCall({}, "mail.send", { subagent: true, server: "mail" }),
      ).decision,
    ).toBe("ask");
    expect(evaluateTokenized(createPolicy([serverRule], "ask"), callWithServer).decision).toBe(
      "deny",
    );
    expect(evaluateTokenized(createPolicy([serverRule], "ask"), callWithoutServer).decision).toBe(
      "ask",
    );
    expect(
      evaluateTokenized(
        createPolicy([serverRule], "ask"),
        createCall({}, "mail.send", { subagent: false, server: "fs" }),
      ).decision,
    ).toBe("ask");
  });

  it("rejects the reserved default rule id with a closed validation code", () => {
    const result = RuleSchema.safeParse({
      id: "default",
      decision: "deny",
      reason: "reserved_id",
      match: { tools: ["mail.send"] },
    });

    if (result.success) {
      throw new Error("The reserved rule id was accepted.");
    }
    expect(result.error.issues).toContainEqual(
      expect.objectContaining({
        path: ["id"],
        params: { errorCode: "policy_rule_id_reserved" },
      }),
    );
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
        context: { subagent: false },
      }),
    ).toThrow();
    expect(
      PolicyCallSchema.safeParse({
        toolId: "mail.send",
        args: {},
        context: {},
      }).success,
    ).toBe(false);
  });

  it("property: adding a deny never makes a call more permitted", () => {
    fc.assert(
      fc.property(
        generatedRulesArbitrary,
        generatedDefaultArbitrary,
        generatedCallArbitrary,
        (ruleData, defaultDecision, call) => {
          const rules = generatedRules(ruleData);
          const doc = createPolicy(rules, defaultDecision);
          const before = evaluateTokenized(doc, call);
          const withDeny = createPolicy(
            [...rules, createRule("appended_deny", "deny", { tools: "*" })],
            defaultDecision,
          );
          const after = evaluateTokenized(withDeny, call);

          expect(decisionRank(after.decision)).toBeGreaterThanOrEqual(
            decisionRank(before.decision),
          );
          expect(before.decision !== "deny" || after.decision === "deny").toBe(true);
        },
      ),
      { numRuns: 500 },
    );
  });

  it("property: removing allow rules never makes a call more permitted", () => {
    fc.assert(
      fc.property(
        generatedAllowRuleArbitrary,
        generatedRulesArbitrary,
        generatedDefaultArbitrary,
        generatedCallArbitrary,
        (allowRuleData, ruleData, defaultDecision, call) => {
          const rules = generatedRules([allowRuleData, ...ruleData]);
          const before = evaluateTokenized(createPolicy(rules, defaultDecision), call);

          for (const [index, rule] of rules.entries()) {
            if (rule.decision !== "allow") {
              continue;
            }
            const withoutAllow = createPolicy(
              rules.filter((_, candidateIndex) => candidateIndex !== index),
              defaultDecision,
            );
            const after = evaluateTokenized(withoutAllow, call);
            expect(decisionRank(after.decision)).toBeGreaterThanOrEqual(
              decisionRank(before.decision),
            );
          }
        },
      ),
      { numRuns: 500 },
    );
  });

  it("property: decision is independent of rule order", () => {
    const shuffledRulesArbitrary = generatedRulesArbitrary.chain((ruleData) => {
      const rules = generatedRules(ruleData);
      return fc
        .shuffledSubarray(rules, {
          minLength: rules.length,
          maxLength: rules.length,
        })
        .map((shuffled) => ({ rules, shuffled }));
    });
    fc.assert(
      fc.property(
        shuffledRulesArbitrary,
        generatedDefaultArbitrary,
        generatedCallArbitrary,
        ({ rules, shuffled }, defaultDecision, call) => {
          expect(evaluateTokenized(createPolicy(shuffled, defaultDecision), call).decision).toBe(
            evaluateTokenized(createPolicy(rules, defaultDecision), call).decision,
          );
        },
      ),
      { numRuns: 500 },
    );
  });

  it("matches the root JSON pointer without throwing for any JSON argument type and operation", () => {
    const matchers: ArgMatcher[] = [
      { pointer: "", op: "equals", value: null },
      { pointer: "", op: "in", value: [null] },
      { pointer: "", op: "startsWith", value: "x" },
      { pointer: "", op: "matches", value: "^x$" },
      { pointer: "", op: "exists" },
      { pointer: "", op: "tokenType", value: "email" },
    ];
    const doc = createPolicy(
      matchers.map((matcher, index) =>
        createRule(`json_type_${String(index)}`, "ask", { tools: "*", args: [matcher] }),
      ),
    );
    const argsByType: JsonValue[] = [null, 42, false, "text", [], { nested: { value: 1 } }];

    for (const args of argsByType) {
      expect(() => evaluate(doc, createCall(args))).not.toThrow();
    }
  });

  it("reuses the compiled and validated document for repeated calls", () => {
    const doc = createPolicy([
      createRule("pattern_rule", "ask", {
        tools: "*",
        args: [{ pointer: "/to", op: "matches", value: "^<EMAIL_1>$" }],
      }),
    ]);
    const parseSpy = vi.spyOn(PolicyDocumentSchema, "parse");
    const compiled = compilePolicy(doc);

    expect(compiled.evaluate(CALL).decision).toBe("ask");
    expect(compiled.evaluate(CALL).decision).toBe("ask");
    expect(parseSpy).toHaveBeenCalledTimes(1);

    parseSpy.mockRestore();
  });
});
