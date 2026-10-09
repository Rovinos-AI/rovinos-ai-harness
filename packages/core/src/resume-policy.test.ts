// SPDX-License-Identifier: Apache-2.0
import { EventSchema } from "@harness/schemas";
import { describe, expect, it } from "vitest";
import { foldRunState } from "./run-state.js";
import { planDanglingIntents } from "./resume-policy.js";
import type { ToolPort } from "./ports.js";

const runId = "00000000000000000000000000";
const segmentId = "11111111111111111111111111";
const callIds = {
  idempotent_tool: "22222222222222222222222222",
  non_idempotent_tool: "33333333333333333333333333",
  unknown: "44444444444444444444444444",
} as const;

function testState(options: { readonly idempotentToolIntent?: boolean } = {}) {
  const events = [
    {
      runId,
      seq: 0,
      ts: 1,
      v: 1,
      traceId: "a".repeat(32),
      spanId: "b".repeat(16),
      segmentId,
      type: "run_created",
      configHash: "c".repeat(64),
      policyVersion: "test.policy",
    },
    {
      runId,
      seq: 1,
      ts: 1,
      v: 1,
      traceId: "a".repeat(32),
      spanId: "b".repeat(16),
      segmentId,
      type: "run_status_changed",
      from: "pending",
      to: "running",
      reason: "start",
    },
    ...Object.entries(callIds).map(([toolId, callId], index) => ({
      runId,
      seq: index + 2,
      ts: 1,
      v: 1,
      traceId: "a".repeat(32),
      spanId: "b".repeat(16),
      segmentId,
      type: "tool_intent",
      callId,
      toolId,
      idempotent: toolId === "idempotent_tool" && (options.idempotentToolIntent ?? true),
      policyDecision: "allow",
      argsHash: "d".repeat(64),
      args: { toolId },
    })),
  ].map((event) => EventSchema.parse(event));
  return foldRunState(events);
}

const toolPort: ToolPort = {
  describe: (toolId) => {
    if (toolId === "idempotent_tool") {
      return { idempotent: true, timeoutMs: 1_000 };
    }
    if (toolId === "non_idempotent_tool") {
      return { idempotent: false, timeoutMs: 1_000 };
    }
    return undefined;
  },
  execute: () => Promise.resolve({ outcome: "ok", result: null }),
};

describe("planDanglingIntents", () => {
  it.each(["escalate", "fail"] as const)(
    "plans idempotent and unknown calls with %s policy",
    (policy) => {
      const actions = planDanglingIntents(testState(), toolPort, policy);

      expect(actions).toEqual([
        { kind: "rerun", callId: callIds.idempotent_tool },
        policy === "escalate"
          ? { kind: "escalate", callId: callIds.non_idempotent_tool }
          : { kind: "fail", callId: callIds.non_idempotent_tool, errorCode: "resume_ambiguous" },
        { kind: "fail", callId: callIds.unknown, errorCode: "unknown_tool" },
      ]);
    },
  );

  it("escalates non-idempotent calls by default", () => {
    expect(planDanglingIntents(testState(), toolPort).map(({ kind }) => kind)).toEqual([
      "rerun",
      "escalate",
      "fail",
    ]);
  });

  it("does not rerun when the durable intent declared the tool non-idempotent", () => {
    const state = testState({ idempotentToolIntent: false });
    expect(planDanglingIntents(state, toolPort)[0]).toEqual({
      kind: "escalate",
      callId: callIds.idempotent_tool,
    });
  });
});
