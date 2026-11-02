// SPDX-License-Identifier: Apache-2.0
import { EventSchema, Id, SequentialIdGenerator } from "@rovinos/schemas";
import type { Event, ModelRequest } from "@rovinos/schemas";
import type { ModelPort, RunContext } from "@rovinos/core";
import { variantsOf } from "@rovinos/telemetry";
import { describe, expect, it } from "vitest";
import { TrajectoryAssertionSchema } from "./schema.js";
import type { TrajectoryAssertion } from "./schema.js";
import { createProviderCaptureAdapter, evaluateTrajectory } from "./trajectory.js";

const runId = Id.parse(new SequentialIdGenerator().next());

function envelope(seq: number) {
  return {
    runId,
    seq,
    ts: seq,
    v: 1,
    traceId: "0123456789abcdef0123456789abcdef",
    spanId: "0123456789abcdef",
    segmentId: runId,
  };
}

function toolIntent(
  seq: number,
  toolId: string,
  policyDecision: "allow" | "ask" | "deny" = "allow",
) {
  return EventSchema.parse({
    ...envelope(seq),
    type: "tool_intent",
    callId: runId,
    toolId,
    idempotent: true,
    policyDecision,
    argsHash: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    args: {},
  });
}

function toolResult(seq: number, toolId: string, outcome: "ok" | "denied") {
  return EventSchema.parse({
    ...envelope(seq),
    type: "tool_result",
    callId: runId,
    toolId,
    outcome,
    latencyMs: 1,
    ...(outcome === "denied" ? { errorCode: "policy_denied" } : {}),
    result: null,
  });
}

function modelRequest(seq: number, text = "") {
  return EventSchema.parse({
    ...envelope(seq),
    type: "model_request",
    requestId: runId,
    provider: "synthetic",
    model: "synthetic",
    messages: [{ role: "user", parts: [{ type: "text", text }] }],
  });
}

function statusChanged(seq: number, to: "running" | "completed" | "failed") {
  return EventSchema.parse({
    ...envelope(seq),
    type: "run_status_changed",
    from: "pending",
    to,
    reason: "synthetic",
  });
}

function approvalRequested(seq: number, toolId: string) {
  return EventSchema.parse({
    ...envelope(seq),
    type: "approval_requested",
    approvalId: runId,
    callId: runId,
    payload: { toolId },
  });
}

function budgetExceeded(seq: number) {
  return EventSchema.parse({
    ...envelope(seq),
    type: "budget_exceeded",
    budget: "steps",
    limit: 1,
    observed: 2,
  });
}

const assertionCases: {
  readonly assertion: TrajectoryAssertion;
  readonly passingEvents: readonly Event[];
  readonly failingEvents: readonly Event[];
}[] = [
  {
    assertion: { type: "tool_never_called", toolId: "delete_file" },
    passingEvents: [toolIntent(0, "read_file")],
    failingEvents: [toolIntent(0, "delete_file")],
  },
  {
    assertion: { type: "tool_never_executed", toolId: "delete_file" },
    passingEvents: [toolIntent(0, "delete_file", "deny"), toolResult(1, "delete_file", "denied")],
    failingEvents: [toolIntent(0, "delete_file"), toolResult(1, "delete_file", "ok")],
  },
  {
    assertion: { type: "tool_called", toolId: "read_file", min: 1, max: 2 },
    passingEvents: [toolIntent(0, "read_file"), toolIntent(1, "read_file")],
    failingEvents: [
      toolIntent(0, "read_file"),
      toolIntent(1, "read_file"),
      toolIntent(2, "read_file"),
    ],
  },
  {
    assertion: { type: "max_steps", n: 2 },
    passingEvents: [modelRequest(0), modelRequest(1)],
    failingEvents: [modelRequest(0), modelRequest(1), modelRequest(2)],
  },
  {
    assertion: { type: "no_denied_calls" },
    passingEvents: [toolIntent(0, "read_file")],
    failingEvents: [toolIntent(0, "delete_file", "deny")],
  },
  {
    assertion: { type: "approval_requested_for", toolId: "delete_file" },
    passingEvents: [approvalRequested(0, "delete_file")],
    failingEvents: [approvalRequested(0, "write_file")],
  },
  {
    assertion: { type: "no_budget_exceeded" },
    passingEvents: [],
    failingEvents: [budgetExceeded(0)],
  },
  {
    assertion: { type: "order", first: "read_file", then: "write_file" },
    passingEvents: [
      toolIntent(0, "write_file"),
      toolIntent(1, "read_file"),
      toolIntent(2, "read_file"),
      toolIntent(3, "write_file"),
    ],
    failingEvents: [toolIntent(0, "write_file"), toolIntent(1, "read_file")],
  },
  {
    assertion: { type: "no_raw_pii_at_model_input", canaries: ["private-canary@example.test"] },
    passingEvents: [modelRequest(0, "safe tokenized text")],
    failingEvents: [modelRequest(0, "raw private-canary@example.test")],
  },
  {
    assertion: { type: "final_status", status: "completed" },
    passingEvents: [statusChanged(0, "running"), statusChanged(1, "completed")],
    failingEvents: [statusChanged(0, "running"), statusChanged(1, "failed")],
  },
];

describe("evaluateTrajectory", () => {
  it.each(assertionCases)("evaluates $assertion.type pass and fail cases", (testCase) => {
    const passingResult = evaluateTrajectory(testCase.passingEvents, [testCase.assertion]);
    const failingResult = evaluateTrajectory(testCase.failingEvents, [testCase.assertion]);

    expect(passingResult).toEqual({
      pass: true,
      results: [{ pass: true, code: "trajectory_assertion_passed" }],
    });
    expect(failingResult.pass).toBe(false);
    expect(failingResult.results[0]?.pass).toBe(false);
    expect(failingResult.results[0]?.code).toMatch(/^[a-z0-9_.-]+$/u);
    expect(Object.keys(failingResult.results[0] ?? {}).sort()).toEqual(["code", "pass"]);
  });

  it("uses task-level canaries when an assertion has no local canary list", () => {
    const assertion = TrajectoryAssertionSchema.parse({ type: "no_raw_pii_at_model_input" });
    const result = evaluateTrajectory([modelRequest(0, "contains task-canary-123")], [assertion], {
      canaries: ["task-canary-123"],
    });

    expect(result).toEqual({
      pass: false,
      results: [{ pass: false, code: "raw_pii_at_model_input" }],
    });
  });

  it("requires a tool call when tool_called has no explicit minimum", () => {
    const assertion = TrajectoryAssertionSchema.parse({ type: "tool_called", toolId: "read_file" });

    expect(evaluateTrajectory([toolIntent(0, "read_file")], [assertion]).pass).toBe(true);
    expect(evaluateTrajectory([], [assertion]).pass).toBe(false);
  });

  it.each([
    encodeURIComponent("Canary-Tag+42@Example.test"),
    Buffer.from("Canary-Tag+42@Example.test", "utf8").toString("base64"),
    Buffer.from("Canary-Tag+42@Example.test", "utf8").toString("base64url"),
    Buffer.from("Canary-Tag+42@Example.test", "utf8").toString("hex"),
    Buffer.from("Canary-Tag+42@Example.test", "utf8").toString("hex").toUpperCase(),
    "Canary&#45;Tag&#43;42&#64;Example&#46;test",
    "canarytag+42@example.test",
    "CanaryTag+42@Example.test",
  ])("detects encoded or normalized canary variants in stored model requests", (variant) => {
    const assertion = TrajectoryAssertionSchema.parse({
      type: "no_raw_pii_at_model_input",
      canaries: ["Canary-Tag+42@Example.test"],
    });
    const result = evaluateTrajectory([modelRequest(0, variant)], [assertion]);

    expect(result.results[0]).toEqual({ pass: false, code: "raw_pii_at_model_input" });
    expect(JSON.stringify(result)).not.toContain("Canary-Tag+42@Example.test");
  });

  it("detects each generated Task 8.6 variant in stored model requests", () => {
    const canary = "synthetic-variant-canary@example.test";
    const assertion = TrajectoryAssertionSchema.parse({
      type: "no_raw_pii_at_model_input",
      canaries: [canary],
    });

    for (const variant of variantsOf(canary, 1)) {
      expect(evaluateTrajectory([modelRequest(0, variant)], [assertion]).pass).toBe(false);
    }
  });

  it("scans model message content without treating message roles as content", () => {
    const assertion = TrajectoryAssertionSchema.parse({
      type: "no_raw_pii_at_model_input",
      canaries: ["user"],
    });

    expect(evaluateTrajectory([modelRequest(0)], [assertion]).pass).toBe(true);
  });

  it("rejects provider-facing input when a tokenizer bypass exposes a canary", async () => {
    const canary = "provider-bypass-canary";
    const request: ModelRequest = {
      requestId: runId,
      model: { provider: "synthetic", model: "synthetic" },
      messages: [{ role: "user", parts: [{ type: "text", text: canary }] }],
    };
    const context: RunContext = {
      runId,
      signal: new AbortController().signal,
    };
    let providerCalls = 0;
    const provider: ModelPort = {
      complete: () => {
        providerCalls += 1;
        throw new Error("provider_called");
      },
    };
    const capture = createProviderCaptureAdapter(provider, [canary]);

    await expect(capture.complete(request, context)).rejects.toMatchObject({
      code: "raw_pii_at_model_input",
    });
    expect(providerCalls).toBe(0);
  });
});
