// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { enforceNativeOutput, withNativeOutputSchema } from "./rung-native.js";
import { enforcePromptOutput, withPromptOutput } from "./rung-prompt.js";

const request = {
  requestId: "00000000000000000000000000",
  model: { provider: "openai", model: "test" },
  messages: [],
};
const output = { name: "result", schema: { type: "object" }, schemaHash: "a".repeat(64) };
const outputSchema = z.object({ answer: z.string() }).strict();

describe("native structured output", () => {
  it("sends the lowered output schema on the request", () => {
    expect(withNativeOutputSchema(request, output).output).toEqual(output);
  });

  describe("prompt-and-validate structured output", () => {
    it("adds a compact schema instruction to the system message", () => {
      const result = withPromptOutput(request, output);
      expect(result.output).toEqual(output);
      expect(result.messages[0]).toEqual({
        role: "system",
        parts: [
          {
            type: "text",
            text: 'Respond with a single JSON value matching this JSON Schema. Do not include commentary.\n{"type":"object"}',
          },
        ],
      });
      expect(result.messages.slice(1)).toEqual(request.messages);
    });

    it("extracts and validates a JSON value from a text response", () => {
      expect(
        enforcePromptOutput(
          [{ type: "text", text: 'Result: ```json\n{"answer":"ok"}\n```' }],
          outputSchema,
        ),
      ).toEqual({
        value: { answer: "ok" },
        valid: true,
        rungUsed: "prompt",
      });
    });

    it("returns value-free typed failures for missing, invalid, and schema-invalid output", () => {
      for (const [text, code, path] of [
        ["No answer.", "no_json", []],
        ['{"answer":"truncated"', "invalid_json", []],
        ['{"answer":2}', "invalid_type", ["answer"]],
      ] as const) {
        const result = enforcePromptOutput([{ type: "text", text }], outputSchema);
        expect(result).toMatchObject({
          valid: false,
          rungUsed: "prompt",
          issues: [{ path, code }],
        });
        expect(JSON.stringify(result)).not.toContain(text);
      }
    });

    it("rejects non-text output and unexpected tool calls", () => {
      expect(enforcePromptOutput([], outputSchema)).toMatchObject({
        valid: false,
        rungUsed: "prompt",
        issues: [{ code: "invalid_type" }],
      });
      expect(
        enforcePromptOutput(
          [
            {
              type: "tool_call",
              callId: "00000000000000000000000000",
              toolId: "lookup",
              args: {},
            },
          ],
          outputSchema,
        ),
      ).toMatchObject({
        valid: false,
        rungUsed: "prompt",
        issues: [{ code: "unexpected_tool_call" }],
      });
    });
  });

  it("returns the parsed typed value from the single text part", () => {
    expect(enforceNativeOutput([{ type: "text", text: '{"answer":"ok"}' }], outputSchema)).toEqual({
      value: { answer: "ok" },
      valid: true,
      rungUsed: "native",
    });
  });

  it.each(["not-json", '{"answer":2}'])("returns safe issues for invalid text: %s", (text) => {
    const result = enforceNativeOutput([{ type: "text", text }], outputSchema);
    expect(result).toMatchObject({ valid: false });
    expect(JSON.stringify(result)).not.toContain("not-json");
  });

  it.each([
    { name: "missing", parts: [] },
    {
      name: "multiple",
      parts: [
        { type: "text" as const, text: '{"answer":"first"}' },
        { type: "text" as const, text: '{"answer":"second"}' },
      ],
    },
  ])("rejects $name native text parts", ({ parts }) => {
    expect(enforceNativeOutput(parts, outputSchema)).toMatchObject({
      valid: false,
      rungUsed: "native",
      issues: [{ path: [], code: "invalid_type" }],
    });
  });

  it("rejects tool calls returned despite native structured output", () => {
    expect(
      enforceNativeOutput(
        [
          { type: "text", text: '{"answer":"ok"}' },
          {
            type: "tool_call",
            callId: "00000000000000000000000000",
            toolId: "lookup",
            args: {},
          },
        ],
        outputSchema,
      ),
    ).toEqual({
      valid: false,
      issues: [{ path: [], code: "unexpected_tool_call" }],
      rungUsed: "native",
    });
  });
});
