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

  it("returns a validated value, canonical JSON text, and no synthetic tool call", async () => {
    const response = await enforceToolOutput(
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

  it("removes the matching synthetic call from provider blobs without changing other content", async () => {
    const response = await enforceToolOutput(
      [
        resultCall,
        {
          type: "opaque",
          provider: "anthropic",
          blob: {
            content: [
              { type: "thinking", thinking: "keep" },
              { type: "tool_use", id: "toolu_emit", name: "emit_result", input: { answer: "ok" } },
              { type: "tool_use", id: "toolu_lookup", name: "lookup", input: {} },
            ],
            toolUseIdByCallId: {
              [resultCall.callId]: "toolu_emit",
              "00000000000000000000000002": "toolu_lookup",
            },
          },
        },
        {
          type: "opaque",
          provider: "openai",
          blob: {
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "call_emit",
                  type: "function",
                  function: { name: "emit_result", arguments: "{}" },
                },
                {
                  id: "call_lookup",
                  type: "function",
                  function: { name: "lookup", arguments: "{}" },
                },
              ],
            },
            openaiCallIdByCallId: {
              [resultCall.callId]: "call_emit",
              "00000000000000000000000002": "call_lookup",
            },
          },
        },
      ],
      outputSchema,
    );

    expect(response.parts).toEqual([
      {
        type: "opaque",
        provider: "anthropic",
        blob: {
          content: [
            { type: "thinking", thinking: "keep" },
            { type: "tool_use", id: "toolu_lookup", name: "lookup", input: {} },
          ],
          toolUseIdByCallId: { "00000000000000000000000002": "toolu_lookup" },
        },
      },
      {
        type: "opaque",
        provider: "openai",
        blob: {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_lookup",
                type: "function",
                function: { name: "lookup", arguments: "{}" },
              },
            ],
          },
          openaiCallIdByCallId: { "00000000000000000000000002": "call_lookup" },
        },
      },
      { type: "text", text: '{"answer":"ok"}' },
    ]);
  });

  it("strips raw synthetic calls even when the adapter could not normalize their arguments", async () => {
    const response = await enforceToolOutput(
      [
        {
          type: "opaque",
          provider: "anthropic",
          blob: {
            content: [{ type: "tool_use", id: "toolu_emit", name: "emit_result", input: {} }],
            toolUseIdByCallId: {},
          },
        },
        {
          type: "opaque",
          provider: "openai",
          blob: {
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "call_emit",
                  type: "function",
                  function: { name: "emit_result", arguments: "{invalid" },
                },
              ],
            },
            openaiCallIdByCallId: {},
          },
        },
      ],
      outputSchema,
    );

    expect(response.result).toMatchObject({ valid: false });
    expect(response.parts).toEqual([
      {
        type: "opaque",
        provider: "anthropic",
        blob: { content: [], toolUseIdByCallId: {} },
      },
      {
        type: "opaque",
        provider: "openai",
        blob: {
          message: { role: "assistant", content: null, tool_calls: [] },
          openaiCallIdByCallId: {},
        },
      },
    ]);
  });

  it("canonicalizes nested JSON values", async () => {
    const schema = z.object({
      nested: z.array(z.union([z.string(), z.number(), z.boolean(), z.null()])),
      z: z.string(),
    });
    const response = await enforceToolOutput(
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

  it("returns structured issues and strips the synthetic call for invalid args", async () => {
    const response = await enforceToolOutput(
      [{ ...resultCall, args: { answer: 2 } }],
      outputSchema,
    );
    expect(response.result.valid).toBe(false);
    expect(response.parts).toEqual([]);
  });

  it("rejects transformed values that cannot be represented as JSON", async () => {
    const response = await enforceToolOutput(
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
  ])("rejects $name synthetic calls", async ({ parts }) => {
    await expect(enforceToolOutput(parts, outputSchema)).resolves.toMatchObject({
      result: {
        valid: false,
        issues: [{ path: [], code: "invalid_type" }],
      },
    });
  });

  it("preserves tokenized tool output in parts after asynchronous validation", async () => {
    const tokenized = { answer: "<EMAIL_1>" };

    const response = await enforceToolOutput(
      [{ ...resultCall, args: tokenized }],
      z.object({ answer: z.email() }),
      (_schema, value) => Promise.resolve({ ok: true, tokenized: value }),
    );

    expect(response.result).toEqual({
      value: tokenized,
      valid: true,
      rungUsed: "tool",
    });
    expect(response.parts).toEqual([{ type: "text", text: '{"answer":"<EMAIL_1>"}' }]);
  });
});
