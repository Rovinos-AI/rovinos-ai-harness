// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { enforcePromptOutput, withPromptOutput } from "./rung-prompt.js";

const request = {
  requestId: "00000000000000000000000000",
  model: { provider: "openai", model: "test" },
  messages: [],
};
const output = { name: "result", schema: { type: "object" }, schemaHash: "a".repeat(64) };
const outputSchema = z.object({ answer: z.string() }).strict();

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

  it("shifts the stable-prefix boundary when prepending the instruction", () => {
    const result = withPromptOutput(
      {
        ...request,
        messages: [{ role: "user", parts: [{ type: "text", text: "hello" }] }],
        stablePrefixMessages: 1,
      },
      output,
    );

    expect(result.stablePrefixMessages).toBe(2);
    expect(result.messages[1]).toEqual({
      role: "user",
      parts: [{ type: "text", text: "hello" }],
    });
  });

  it("extracts and validates a JSON value from a text response", async () => {
    await expect(
      enforcePromptOutput(
        [{ type: "text", text: 'Result: ```json\n{"answer":"ok"}\n```' }],
        outputSchema,
      ),
    ).resolves.toEqual({
      value: { answer: "ok" },
      valid: true,
      rungUsed: "prompt",
    });
  });

  it("returns value-free typed failures for missing, invalid, and schema-invalid output", async () => {
    for (const [text, code, path] of [
      ["No answer.", "no_json", []],
      ['{"answer":"truncated"', "invalid_json", []],
      ['{"answer":2}', "invalid_type", ["answer"]],
    ] as const) {
      const result = await enforcePromptOutput([{ type: "text", text }], outputSchema);
      expect(result).toMatchObject({
        valid: false,
        rungUsed: "prompt",
        issues: [{ path, code }],
      });
      expect(JSON.stringify(result)).not.toContain(text);
    }
  });

  it("rejects non-text output and unexpected tool calls", async () => {
    await expect(enforcePromptOutput([], outputSchema)).resolves.toMatchObject({
      valid: false,
      rungUsed: "prompt",
      issues: [{ code: "invalid_type" }],
    });
    await expect(
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
    ).resolves.toMatchObject({
      valid: false,
      rungUsed: "prompt",
      issues: [{ code: "unexpected_tool_call" }],
    });
  });

  it("keeps values returned by a transform tokenized", async () => {
    const tokenized = { answer: "<EMAIL_1>" };

    await expect(
      enforcePromptOutput(
        [{ type: "text", text: JSON.stringify(tokenized) }],
        z.object({ answer: z.string().email() }),
        async (_schema, value) => ({ ok: true, tokenized: value }),
      ),
    ).resolves.toEqual({ value: tokenized, valid: true, rungUsed: "prompt" });
  });
});
