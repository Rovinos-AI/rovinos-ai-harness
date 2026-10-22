// SPDX-License-Identifier: Apache-2.0
import { ContractError } from "@harness/schemas";
import { describe, expect, it } from "vitest";
import basicSuite from "../../../examples/evals/basic.suite.js";
import {
  defineSuite,
  EvalSuiteSchema,
  GraderSpecSchema,
  HumanScriptSchema,
  TrajectoryAssertionSchema,
} from "./index.js";

const validSuite = {
  schemaVersion: 1,
  tasks: [
    {
      id: "synthetic_task",
      input: {
        goal: "Complete a synthetic task.",
        metadata: { synthetic: true, attempts: 2, category: "eval" },
      },
      graders: [{ type: "no_canary_leak" }],
      tags: ["synthetic"],
    },
  ],
};

function expectContractError(action: () => unknown): ContractError {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(ContractError);
    if (error instanceof ContractError) {
      return error;
    }
  }
  throw new Error("Expected a contract validation error.");
}

describe("eval suite schemas", () => {
  it("validates suites and supplies the simulated-human resume default", () => {
    const suite = defineSuite({
      ...validSuite,
      tasks: [
        {
          ...validSuite.tasks[0],
          human: { rules: [], default: "deny" },
        },
      ],
    });

    expect(suite.tasks[0]?.human?.maxResumes).toBe(10);
    expect(EvalSuiteSchema.parse(suite)).toEqual(suite);
  });

  it("validates the committed example suite", () => {
    expect(defineSuite(basicSuite)).toMatchObject({
      schemaVersion: 1,
      tasks: [{ id: "create_readme" }],
    });
  });

  it("reports path-level errors for invalid codes and unknown versions", () => {
    const invalidVersion = expectContractError(() =>
      defineSuite({ schemaVersion: 2, tasks: [validSuite.tasks[0]] }),
    );
    const invalidTask = expectContractError(() =>
      defineSuite({
        ...validSuite,
        tasks: [{ ...validSuite.tasks[0], id: "Bad Code" }],
      }),
    );
    const duplicateIds = expectContractError(() =>
      defineSuite({
        ...validSuite,
        tasks: [validSuite.tasks[0], validSuite.tasks[0]],
      }),
    );

    expect(invalidVersion.issues).toContainEqual({
      path: ["schemaVersion"],
      code: "invalid_value",
    });
    expect(invalidTask.issues).toContainEqual({
      path: ["tasks", 0, "id"],
      code: "invalid_format",
    });
    expect(duplicateIds.issues).toContainEqual({
      path: ["tasks", 1, "id"],
      code: "eval_task_id_duplicate",
    });
  });

  it("rejects unknown grader types and missing file diff expectations", () => {
    const unknownGrader = expectContractError(() =>
      defineSuite({
        ...validSuite,
        tasks: [
          {
            ...validSuite.tasks[0],
            graders: [{ type: "unknown_grader" }],
          },
        ],
      }),
    );
    const missingExpectation = expectContractError(() =>
      defineSuite({
        ...validSuite,
        tasks: [
          {
            ...validSuite.tasks[0],
            graders: [{ type: "file_diff", path: "README.md" }],
          },
        ],
      }),
    );

    expect(unknownGrader.issues[0]?.path).toEqual(["tasks", 0, "graders", 0, "type"]);
    expect(missingExpectation.issues).toContainEqual({
      path: ["tasks", 0, "graders", 0, "expectedFile"],
      code: "file_diff_expectation_required",
    });
  });

  it("validates each grader type and rejects out-of-range thresholds", () => {
    const graders = [
      { type: "file_diff", path: "README.md", expectedContains: "Hello" },
      { type: "test_command", argv: ["node", "--version"] },
      { type: "schema_valid", schemaRef: "./schema.ts#OutputSchema" },
      {
        type: "trajectory",
        assertions: [
          { type: "tool_never_called", toolId: "delete_file" },
          { type: "tool_called", toolId: "write_file", min: 1, max: 2 },
          { type: "max_steps", n: 3 },
          { type: "no_denied_calls" },
          { type: "approval_requested_for", toolId: "delete_file" },
          { type: "no_budget_exceeded" },
          { type: "order", first: "read_file", then: "write_file" },
          { type: "no_raw_pii_at_model_input", canaries: ["synthetic-canary"] },
          { type: "final_status", status: "completed" },
        ],
      },
      {
        type: "llm_judge",
        rubricId: "readability",
        rubric: "Check the synthetic response for clarity.",
        model: { provider: "test", model: "fixture" },
        passThreshold: 0.75,
      },
      { type: "no_canary_leak" },
    ];

    expect(graders.map((grader) => GraderSpecSchema.parse(grader))).toHaveLength(6);
    expect(
      TrajectoryAssertionSchema.safeParse({
        type: "tool_called",
        toolId: "write_file",
        min: 3,
        max: 1,
      }).success,
    ).toBe(false);
    expect(
      GraderSpecSchema.safeParse({
        type: "llm_judge",
        rubricId: "readability",
        rubric: "Check the synthetic response.",
        model: { provider: "test", model: "fixture" },
        passThreshold: 1.1,
      }).success,
    ).toBe(false);
  });

  it("requires explicit unsafe opt-in for default approval", () => {
    const implicitApproval = expectContractError(() =>
      defineSuite({
        ...validSuite,
        tasks: [
          {
            ...validSuite.tasks[0],
            human: { rules: [], default: "approve" },
          },
        ],
      }),
    );

    expect(implicitApproval.issues).toContainEqual({
      path: ["tasks", 0, "human", "unsafeAutoApprove"],
      code: "human_auto_approve_unsafe_flag_required",
    });
    expect(
      HumanScriptSchema.parse({
        rules: [],
        default: "approve",
        unsafeAutoApprove: true,
      }).unsafeAutoApprove,
    ).toBe(true);
  });

  it("rejects unexpected fields on task and suite objects", () => {
    expect(
      EvalSuiteSchema.safeParse({
        ...validSuite,
        unexpected: true,
      }).success,
    ).toBe(false);
    expect(
      EvalSuiteSchema.safeParse({
        schemaVersion: 1,
        tasks: [{ ...validSuite.tasks[0], unexpected: true }],
      }).success,
    ).toBe(false);
  });
});
