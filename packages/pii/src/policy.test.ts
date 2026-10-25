// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { PiiPolicySchema } from "@rovinos/schemas";
import { evaluatePiiPolicy, explainPiiPolicy } from "./index.js";

describe("PII policy evaluation", () => {
  const context = {
    entity: "email",
    boundary: "model_input",
    destination: "hosted",
  } as const;

  it.each([
    {
      name: "the first matching rule wins",
      policy: {
        rules: [
          {
            entities: ["email"],
            boundaries: ["model_input"],
            destinations: ["hosted"],
            action: "redact",
          },
          {
            entities: ["email"],
            boundaries: ["model_input"],
            destinations: ["hosted"],
            action: "block",
          },
        ],
      },
      action: "redact",
      ruleIndex: 0,
    },
    {
      name: "wildcards match all selectors",
      policy: {
        rules: [
          {
            entities: "*",
            boundaries: "*",
            destinations: "*",
            action: "block",
          },
        ],
      },
      action: "block",
      ruleIndex: 0,
    },
    {
      name: "the configured default applies without a matching rule",
      policy: {
        defaultAction: "redact",
        rules: [
          {
            entities: ["phone"],
            boundaries: ["tool_input"],
            destinations: [{ tool: "tool.search" }],
            action: "block",
          },
        ],
      },
      action: "redact",
      ruleIndex: "default",
    },
  ])("$name", ({ policy, action, ruleIndex }) => {
    const parsedPolicy = PiiPolicySchema.parse(policy);

    expect(explainPiiPolicy(parsedPolicy, context)).toEqual({ action, ruleIndex });
    expect(evaluatePiiPolicy(parsedPolicy, context)).toBe(action);
  });

  it("matches tool destinations by tool code", () => {
    const policy = PiiPolicySchema.parse({
      rules: [
        {
          entities: ["email"],
          boundaries: ["tool_input"],
          destinations: [{ tool: "tool.search" }],
          action: "block",
        },
      ],
    });

    expect(
      evaluatePiiPolicy(policy, {
        entity: "email",
        boundary: "tool_input",
        destination: { tool: "tool.search" },
      }),
    ).toBe("block");
    expect(
      evaluatePiiPolicy(policy, {
        entity: "email",
        boundary: "tool_input",
        destination: { tool: "tool.other" },
      }),
    ).toBe("tokenize");
  });

  it("does not mutate policy or evaluation context", () => {
    const policy = PiiPolicySchema.parse({
      rules: [
        {
          entities: ["email"],
          boundaries: ["model_input"],
          destinations: ["hosted"],
          action: "redact",
        },
      ],
    });
    const originalPolicy = structuredClone(policy);
    const originalContext = structuredClone(context);

    expect(evaluatePiiPolicy(policy, context)).toBe("redact");
    expect(policy).toEqual(originalPolicy);
    expect(context).toEqual(originalContext);
  });
});
