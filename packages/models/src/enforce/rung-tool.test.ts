// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { enforceToolOutput, withForcedOutputTool } from "./rung-tool.js";

const request = {
  requestId: "00000000000000000000000000",
  model: { provider: "anthropic", model: "test" },
  messages: [],
  tools: [{ toolId: "lookup", description: "Lookup", inputSchema: {} }],
};
const output = {
  name: "result",
  schema: { type: "object", properties: { answer: { type: "string" } } },
  schemaHash: "a".repeat(64),
};
const outputSchema = z.object({ answer: z.string() }).strict();
const resultCall = {
  type: "tool_call" as const,
  callId: "00000000000000000000000001",
  toolId: "emit_result",
  args: { answer: "ok" },
};

describe("forced-tool structured output", () => {
  it("registers only the synthetic tool and forces its selection", () => {
    expect(withForcedOutputTool(request, output)).toMatchObject({
      output,
      tools: [{ toolId: "emit_result", inputSchema: output.schema }],
      toolChoice: { forced: "emit_result" },
    });
  });

  it("returns a validated value, canonical JSON text, and no synthetic tool call", () => {
    const response = enforceToolOutput(
      [
        resultCall,
        {
          type: "opaque",
          provider: "anthropic",
          blob: null,
        },
      ],
      outputSchema,
    );
    expect(response.result).toEqual({
      value: { answer: "ok" },
      valid: true,
      rungUsed: "tool",
    });
    expect(response.parts).toEqual([
      { type: "opaque", provider: "anthropic", blob: null },
      { type: "text", text: '{"answer":"ok"}' },
    ]);
  });

  it("canonicalizes nested JSON values", () => {
    const schema = z.object({
      nested: z.array(z.union([z.string(), z.number(), z.boolean(), z.null()])),
      z: z.string(),
    });
    const response = enforceToolOutput(
      [
        {
          ...resultCall,
          args: { z: "last", nested: ["text", 2, true, null] },
        },
      ],
      schema,
    );
    expect(response.parts).toEqual([
      { type: "text", text: '{"nested":["text",2,true,null],"z":"last"}' },
    ]);
  });

  it("returns structured issues and strips the synthetic call for invalid args", () => {
    const response = enforceToolOutput([{ ...resultCall, args: { answer: 2 } }], outputSchema);
    expect(response.result.valid).toBe(false);
    expect(response.parts).toEqual([]);
  });

  it("rejects transformed values that cannot be represented as JSON", () => {
    const response = enforceToolOutput(
      [{ ...resultCall, args: "date" }],
      z.string().transform(() => new Date(0)),
    );
    expect(response.result).toMatchObject({
      valid: false,
      rungUsed: "tool",
      issues: [{ path: [], code: "invalid_union" }],
    });
    expect(response.parts).toEqual([]);
  });

  it.each([
    { name: "missing", parts: [] },
    { name: "duplicate", parts: [resultCall, resultCall] },
  ])("rejects $name synthetic calls", ({ parts }) => {
    expect(enforceToolOutput(parts, outputSchema)).toMatchObject({
      result: {
        valid: false,
        issues: [{ path: [], code: "invalid_type" }],
      },
    });
  });
});
