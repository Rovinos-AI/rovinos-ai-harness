// SPDX-License-Identifier: Apache-2.0
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { ContractError, parseYaml } from "./parse.js";
import { PiiConfigSchema } from "./config/pii.js";
import { PiiPolicySchema } from "./pii-policy.js";

function hasIssueMessage(
  result: ReturnType<typeof PiiPolicySchema.safeParse>,
  message: string,
): boolean {
  return !result.success && result.error.issues.some((issue) => issue.message === message);
}

describe("PiiPolicySchema", () => {
  it("defaults the action to tokenize and rules to an empty list", () => {
    expect(PiiPolicySchema.parse({})).toEqual({
      defaultAction: "tokenize",
      rules: [],
    });
  });

  it("rejects a globally permissive default action", () => {
    const result = PiiPolicySchema.safeParse({ defaultAction: "allow" });

    expect(result.success).toBe(false);
    expect(hasIssueMessage(result, "pii_policy_default_allow")).toBe(true);
  });

  it("accepts the built-in entities and constrained custom names", () => {
    expect(() =>
      PiiPolicySchema.parse({
        rules: [
          {
            entities: ["email", "custom_org_id"],
            boundaries: ["model_input"],
            destinations: [{ tool: "tool.payment" }],
            action: "redact",
          },
        ],
      }),
    ).not.toThrow();

    for (const entity of ["custom_", "custom_UPPER", "custom_" + "a".repeat(41), "other"]) {
      expect(() =>
        PiiPolicySchema.parse({
          rules: [
            {
              entities: [entity],
              boundaries: ["model_input"],
              destinations: ["hosted"],
              action: "redact",
            },
          ],
        }),
      ).toThrow();
    }
  });

  it("rejects unknown keys and invalid tool codes", () => {
    expect(() => PiiPolicySchema.parse({ extra: true })).toThrow();
    expect(() =>
      PiiPolicySchema.parse({
        rules: [
          {
            entities: ["email"],
            boundaries: ["model_input"],
            destinations: [{ tool: "Invalid Tool" }],
            action: "allow",
          },
        ],
      }),
    ).toThrow();
  });

  it.each([
    {
      name: "storage boundary",
      boundaries: ["storage"],
      code: "pii_policy_storage_allow",
    },
    {
      name: "wildcard boundary including storage",
      boundaries: "*",
      code: "pii_policy_storage_allow",
    },
  ])("rejects allow at the $name", ({ boundaries, code }) => {
    const result = PiiPolicySchema.safeParse({
      rules: [
        {
          entities: ["email"],
          boundaries,
          destinations: ["hosted"],
          action: "allow",
        },
      ],
    });

    expect(result.success).toBe(false);
    expect(hasIssueMessage(result, code)).toBe(true);
  });

  it.each(["api_key", "credit_card"])("only allows %s for explicit tool destinations", (entity) => {
    for (const destination of ["hosted", "local", "any", "*"]) {
      const result = PiiPolicySchema.safeParse({
        rules: [
          {
            entities: [entity],
            boundaries: ["tool_input"],
            destinations: destination === "*" ? "*" : [destination],
            action: "allow",
          },
        ],
      });

      expect(result.success).toBe(false);
      expect(hasIssueMessage(result, "pii_policy_secret_allow_destination")).toBe(true);
    }

    expect(
      PiiPolicySchema.safeParse({
        rules: [
          {
            entities: [entity],
            boundaries: ["tool_input"],
            destinations: [],
            action: "allow",
          },
        ],
      }).success,
    ).toBe(false);

    expect(
      PiiPolicySchema.safeParse({
        rules: [
          {
            entities: [entity],
            boundaries: ["tool_input"],
            destinations: [{ tool: "tool.payment" }],
            action: "allow",
          },
        ],
      }).success,
    ).toBe(true);
  });

  it("preserves policy validation codes when parsing YAML", () => {
    let error: unknown;
    try {
      parseYaml(
        PiiConfigSchema,
        `rules:
    - entities: [email]
      boundaries: [storage]
      destinations: [hosted]
      action: allow
`,
      );
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(ContractError);
    expect(error).toMatchObject({
      issues: [
        {
          path: ["rules", 0, "boundaries"],
          code: "pii_policy_storage_allow",
        },
      ],
    });
  });

  it("rejects allow rules that apply to every entity", () => {
    const result = PiiPolicySchema.safeParse({
      rules: [
        {
          entities: "*",
          boundaries: ["tool_input"],
          destinations: [{ tool: "tool.payment" }],
          action: "allow",
        },
      ],
    });

    expect(result.success).toBe(false);
    expect(hasIssueMessage(result, "pii_policy_allow_all_entities")).toBe(true);
  });

  it("round-trips the example policy YAML", async () => {
    const yaml = await readFile(
      new URL("../../../examples/pii-policy.yaml", import.meta.url),
      "utf8",
    );
    const parsed = parseYaml(PiiConfigSchema, yaml);

    expect(PiiPolicySchema.parse(parsed)).toEqual(parsed);
  });
});
