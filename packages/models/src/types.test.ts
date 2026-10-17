// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { assembleDeltas, ProviderDeltaSchema, ProviderResultSchema } from "./types.js";

describe("provider result contract", () => {
  it("accepts normalized parts, usage, finish reason, and latency", () => {
    const result = {
      parts: [{ type: "text", text: "hello" }],
      usage: { inputTokens: 2, outputTokens: 3 },
      finishReason: "stop",
      latencyMs: 4,
    };

    expect(ProviderResultSchema.parse(result)).toEqual(result);
  });

  it("rejects invalid usage and negative latency", () => {
    const result = {
      parts: [],
      usage: { inputTokens: -1, outputTokens: 3 },
      finishReason: "stop",
      latencyMs: -1,
    };

    expect(ProviderResultSchema.safeParse(result).success).toBe(false);
  });

  it("assembles ordered text, tool-call arguments, usage, and opaque provider data", () => {
    const opaque = {
      type: "opaque" as const,
      provider: "anthropic",
      blob: { blocks: [{ type: "thinking", signature: "synthetic-signature" }] },
    };
    const deltas = [
      { type: "text", index: 0, text: "Hello " },
      { type: "tool_call", index: 1, callId: "00000000000000000000000000", toolId: "lookup", arguments: "{\"id\":" },
      { type: "text", index: 0, text: "world." },
      { type: "tool_call", index: 1, arguments: "7}" },
      { type: "opaque", part: opaque },
      { type: "usage", usage: { inputTokens: 3, outputTokens: 4 } },
      { type: "finish", finishReason: "tool_use", latencyMs: 12 },
    ];

    expect(assembleDeltas(deltas)).toEqual({
      parts: [
        { type: "text", text: "Hello world." },
        {
          type: "tool_call",
          callId: "00000000000000000000000000",
          toolId: "lookup",
          args: { id: 7 },
        },
        opaque,
      ],
      usage: { inputTokens: 3, outputTokens: 4 },
      finishReason: "tool_use",
      latencyMs: 12,
    });
    expect(ProviderDeltaSchema.safeParse({ type: "text", index: 0, text: "secret", extra: true }).success).toBe(
      false,
    );
  });

  it("marks malformed streamed tool arguments and omits partial visible output", () => {
    expect(
      assembleDeltas([
        { type: "text", index: 0, text: "partial" },
        {
          type: "tool_call",
          index: 1,
          callId: "00000000000000000000000000",
          toolId: "lookup",
          arguments: "{",
        },
        { type: "finish", finishReason: "tool_use", latencyMs: 0 },
      ]),
    ).toEqual({
      parts: [],
      usage: { inputTokens: 0, outputTokens: 0 },
      finishReason: "tool_args_invalid",
      latencyMs: 0,
    });
  });
});
