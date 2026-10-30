// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { PiiExplainResultSchema } from "./pii.js";

describe("PII explain CLI output schema", () => {
  it("accepts a single policy explanation", () => {
    expect(
      PiiExplainResultSchema.parse({
        mode: "explain",
        result: {
          boundary: "model_input",
          destination: "hosted",
          entity: "email",
          action: "tokenize",
          ruleIndex: "default",
        },
      }),
    ).toMatchObject({ mode: "explain", result: { action: "tokenize" } });
  });

  it("accepts a complete matrix with tool destinations", () => {
    const result = PiiExplainResultSchema.parse({
      mode: "matrix",
      results: [
        {
          boundary: "tool_input",
          destination: { tool: "mail.send" },
          entity: "email",
          action: "allow",
          ruleIndex: 0,
        },
      ],
    });

    if (result.mode !== "matrix") {
      throw new Error("Expected a matrix result");
    }
    expect(result.results).toHaveLength(1);
  });

  it("rejects unrecognized output fields", () => {
    expect(
      PiiExplainResultSchema.safeParse({
        mode: "matrix",
        results: [],
        policyContents: "not allowed",
      }).success,
    ).toBe(false);
  });
});
