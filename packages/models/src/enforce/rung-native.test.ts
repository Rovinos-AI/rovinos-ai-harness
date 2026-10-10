// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { enforceNativeOutput, withNativeOutputSchema } from "./rung-native.js";

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
