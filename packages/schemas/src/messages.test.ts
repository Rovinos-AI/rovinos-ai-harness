// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import {
  MessageSchema,
  ModelRequestSchema,
  ModelResponseSchema,
  PartSchema,
  ToolSpecSchema,
} from "./messages.js";

const id = "00000000000000000000000000";
const code = "test";
const sha256 = "a".repeat(64);

describe("normalized model messages", () => {
  it.each([
    { type: "text", text: "hello" },
    { type: "tool_call", callId: id, toolId: code, args: { value: 1 } },
    { type: "tool_result", callId: id, result: null, isError: false },
    { type: "opaque", provider: code, blob: { bytes: [1, 2, 3] } },
  ])("round-trips the $type part", (part) => {
    expect(PartSchema.parse(part)).toEqual(part);
  });

  it.each([
    { type: "text" },
    { type: "unknown", text: "hello" },
    { type: "tool_call", callId: "invalid", toolId: code, args: null },
    { type: "tool_result", callId: id, result: null },
    { type: "opaque", provider: code, blob: {}, extra: true },
  ])("rejects invalid part %#", (part) => {
    expect(PartSchema.safeParse(part).success).toBe(false);
  });

  it("rejects extra message fields and unknown roles", () => {
    expect(MessageSchema.safeParse({ role: "user", parts: [], extra: true }).success).toBe(false);
    expect(MessageSchema.safeParse({ role: "function", parts: [] }).success).toBe(false);
  });

  it("validates request and response contracts", () => {
    const request = {
      requestId: id,
      model: { provider: code, model: code },
      messages: [{ role: "user", parts: [{ type: "text", text: "hello" }] }],
      stablePrefixMessages: 1,
      tools: [{ toolId: code, description: "tool", inputSchema: { type: "object" } }],
      output: { name: code, schema: {}, schemaHash: sha256 },
      toolChoice: { forced: code },
      maxOutputTokens: 3,
      temperature: 0.2,
    };
    expect(ModelRequestSchema.parse(request)).toEqual(request);
    expect(ModelRequestSchema.parse({ ...request, toolChoice: "required" }).toolChoice).toBe(
      "required",
    );
    expect(ModelRequestSchema.safeParse({ ...request, stablePrefixMessages: 2 }).success).toBe(
      false,
    );
    expect(ToolSpecSchema.safeParse({ toolId: code, description: "tool" }).success).toBe(false);

    const response = {
      parts: [{ type: "text", text: "hello" }],
      usage: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 1, cacheWriteTokens: 0 },
      finishReason: "stop",
      provider: code,
      model: code,
      latencyMs: 0,
      schemaValid: true,
      repairAttempts: 0,
      fallbackDepth: 0,
    };
    expect(ModelResponseSchema.parse(response)).toEqual(response);
    expect(ModelResponseSchema.safeParse({ ...response, fallbackDepth: -1 }).success).toBe(false);
    expect(
      ModelResponseSchema.safeParse({
        ...response,
        usage: { inputTokens: 1, outputTokens: 2, cacheReadTokens: -1 },
      }).success,
    ).toBe(false);
  });
});
