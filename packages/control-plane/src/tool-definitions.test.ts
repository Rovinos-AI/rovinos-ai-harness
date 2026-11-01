// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { toolDefinitions, toolScope } from "./tool-definitions.js";

describe("control-plane tool definitions", () => {
  it("assigns each registered tool its required scope and fails closed for unknown tools", () => {
    const scopes = Object.fromEntries(toolDefinitions().map(({ name }) => [name, toolScope(name)]));

    expect(scopes).toEqual({
      list_runs: "read",
      get_run: "read",
      list_pending_inputs: "read",
      get_input: "approve",
      review_input: "approve",
      answer_input: "approve",
      "harness.inputs.answer": "approve",
      "harness.runs.list": "read",
      "harness.runs.get": "read",
      approve: "approve",
      "harness.approvals.get": "approve",
      "harness.approvals.resolve": "approve",
      "harness.approvals.reveal": "reveal",
      deny: "approve",
      review_approval: "approve",
      start_run: "run",
      continue_run: "run",
      resume_run: "run",
      cancel_run: "run",
    });
    expect(toolScope("future_tool")).toBe("run");
  });

  it("links all input tools to the input MCP App resource", () => {
    const tools = toolDefinitions();
    for (const name of ["list_pending_inputs", "get_input", "harness.inputs.answer"]) {
      expect(tools.find((tool) => tool.name === name)?._meta).toMatchObject({
        ui: { resourceUri: "ui://harness/input/v1" },
      });
    }
    expect(tools.find((tool) => tool.name === "harness.inputs.answer")?._meta).toMatchObject({
      ui: { visibility: ["app"] },
    });
  });
});
