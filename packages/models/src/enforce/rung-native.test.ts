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

  it("returns the parsed typed value from the single text part", async () => {
    await expect(
      enforceNativeOutput([{ type: "text", text: '{"answer":"ok"}' }], outputSchema),
    ).resolves.toEqual({
      value: { answer: "ok" },
      valid: true,
      rungUsed: "native",
    });
  });

  it.each(["not-json", '{"answer":2}'])(
    "returns safe issues for invalid text: %s",
    async (text) => {
      const result = await enforceNativeOutput([{ type: "text", text }], outputSchema);
      expect(result).toMatchObject({ valid: false });
      expect(JSON.stringify(result)).not.toContain("not-json");
    },
  );

  it.each([
    { name: "missing", parts: [] },
    {
      name: "multiple",
      parts: [
        { type: "text" as const, text: '{"answer":"first"}' },
        { type: "text" as const, text: '{"answer":"second"}' },
      ],
    },
  ])("rejects $name native text parts", async ({ parts }) => {
    await expect(enforceNativeOutput(parts, outputSchema)).resolves.toMatchObject({
      valid: false,
      rungUsed: "native",
      issues: [{ path: [], code: "invalid_type" }],
    });
  });

  it("rejects tool calls returned despite native structured output", async () => {
    await expect(
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
    ).resolves.toEqual({
      valid: false,
      issues: [{ path: [], code: "unexpected_tool_call" }],
      rungUsed: "native",
    });
  });

  it("keeps transformed values tokenized in successful enforcement results", async () => {
    const tokenized = { answer: "<EMAIL_1>" };

    await expect(
      enforceNativeOutput(
        [{ type: "text", text: JSON.stringify(tokenized) }],
        z.object({ answer: z.email() }),
        (_schema, value) => Promise.resolve({ ok: true, tokenized: value }),
      ),
    ).resolves.toEqual({ value: tokenized, valid: true, rungUsed: "native" });
  });

  it("fails closed when a transform throws or returns raw fields", async () => {
    const tokenized = "<EMAIL_1>";
    const rawCanary = "raw-canary@example.test";
    const schema = z.email();
    const parts = [{ type: "text" as const, text: JSON.stringify(tokenized) }];

    const thrown = await enforceNativeOutput(parts, schema, () =>
      Promise.reject(new Error(rawCanary)),
    );
    const leaked = await enforceNativeOutput(parts, schema, (_schema, value) => {
      const invalidResult = { ok: true as const, tokenized: value, raw: rawCanary };
      return Promise.resolve(invalidResult);
    });

    expect(thrown).toMatchObject({
      valid: false,
      issues: [{ path: [], code: "custom" }],
    });
    expect(leaked).toMatchObject({
      valid: false,
      issues: [{ path: [], code: "custom" }],
    });
    expect(JSON.stringify(thrown)).not.toContain(rawCanary);
    expect(JSON.stringify(leaked)).not.toContain(rawCanary);
  });
});
