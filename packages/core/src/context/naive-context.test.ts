// SPDX-License-Identifier: Apache-2.0
import type { Event } from "@harness/schemas";
import { describe, expect, it } from "vitest";
import { NaiveContext } from "./naive-context.js";

const runId = "00000000000000000000000000";
const segmentId = "11111111111111111111111111";
const requestId = "22222222222222222222222222";
const callId = "33333333333333333333333333";
const envelope = (seq: number) => ({
  runId,
  seq,
  ts: 100 + seq,
  v: 1,
  traceId: "a".repeat(32),
  spanId: "b".repeat(16),
  segmentId,
});

describe("NaiveContext", () => {
  it("returns model content and tool results in event order", async () => {
    const events: Event[] = [
      {
        ...envelope(0),
        type: "model_response",
        requestId,
        provider: "fake",
        model: "fake",
        inputTokens: 1,
        outputTokens: 1,
        finishReason: "stop",
        latencyMs: 0,
        schemaValid: true,
        repairAttempts: 0,
        fallbackDepth: 0,
        content: [
          { type: "text", text: "first answer" },
          { type: "tool_call", callId, toolId: "fake_tool", args: { input: "tool args" } },
        ],
        providerBlobs: null,
      },
      {
        ...envelope(1),
        type: "tool_intent",
        callId,
        toolId: "fake_tool",
        idempotent: true,
        policyDecision: "allow",
        argsHash: "a".repeat(64),
        args: { input: "tool args" },
      },
      {
        ...envelope(2),
        type: "tool_result",
        callId,
        toolId: "fake_tool",
        outcome: "ok",
        latencyMs: 0,
        result: { output: "tool result" },
      },
      {
        ...envelope(3),
        type: "tool_result",
        callId,
        toolId: "fake_tool",
        outcome: "timeout",
        errorCode: "tool_timeout",
        latencyMs: 3,
        result: null,
      },
      {
        ...envelope(4),
        type: "model_response",
        requestId,
        provider: "fake",
        model: "fake",
        inputTokens: 1,
        outputTokens: 1,
        finishReason: "stop",
        latencyMs: 0,
        schemaValid: true,
        repairAttempts: 0,
        fallbackDepth: 0,
        content: [{ type: "text", text: "second answer" }],
        providerBlobs: null,
      },
    ];

    await expect(new NaiveContext().build(events)).resolves.toEqual([
      {
        role: "assistant",
        parts: [
          { type: "text", text: "first answer" },
          { type: "tool_call", callId, toolId: "fake_tool", args: { input: "tool args" } },
        ],
      },
      {
        role: "tool",
        parts: [{ type: "tool_result", callId, isError: false, result: { output: "tool result" } }],
      },
      {
        role: "tool",
        parts: [{ type: "tool_result", callId, isError: true, result: null }],
      },
      {
        role: "assistant",
        parts: [{ type: "text", text: "second answer" }],
      },
    ]);
  });

  it("returns no messages when the history has no model responses or tool results", async () => {
    const event: Event = {
      ...envelope(0),
      type: "run_created",
      configHash: "a".repeat(64),
      policyVersion: "test.policy",
    };

    await expect(new NaiveContext().build([event])).resolves.toEqual([]);
  });
});
