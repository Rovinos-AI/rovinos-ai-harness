// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import type { ModelRequest } from "@harness/schemas";
import { z } from "zod";
import { enforcePromptOutput } from "./rung-prompt.js";
import { appendRepairMessages } from "./repair.js";

const request: ModelRequest = {
  requestId: "00000000000000000000000000",
  model: { provider: "sample", model: "model-a" },
  messages: [{ role: "user", parts: [{ type: "text", text: "produce a result" }] }],
};

describe("bounded repair requests", () => {
  it.each(["CANARY_ALPHA", "CANARY_BETA", "CANARY_GAMMA"])(
    "includes issue paths without echoing invalid values such as %s",
    (canary) => {
      const result = enforcePromptOutput(
        [{ type: "text", text: `{"items":[{"count":"${canary}"}]}` }],
        z.object({ items: z.array(z.object({ count: z.number().int() })) }),
      );
      if (result.valid) {
        throw new Error("Expected the synthetic output to fail validation.");
      }
      const repaired = appendRepairMessages(request, [{ type: "text", text: canary }], result.issues);
      const repairMessage = repaired.messages.at(-1);
      expect(repairMessage).toMatchObject({
        role: "user",
        parts: [
          {
            type: "text",
            text: "Correct the structured output to match the requested schema. Return only the corrected output.\n$.items[0].count: expected number",
          },
        ],
      });
      expect(JSON.stringify(repairMessage)).not.toContain(canary);
      expect(repaired.messages.at(-2)).toEqual({
        role: "assistant",
        parts: [{ type: "text", text: canary }],
      });
    },
  );

  it("formats unusual property names and value-free fallback descriptors", () => {
    const result = appendRepairMessages(request, [], [
      { path: ["field.with.dots"], code: "invalid_json" },
      { path: ["field.with.dots"], code: "too_small" },
    ]);
    expect(result.messages.at(-1)).toMatchObject({
      role: "user",
      parts: [
        {
          type: "text",
          text: 'Correct the structured output to match the requested schema. Return only the corrected output.\n$["field.with.dots"]: expected valid JSON\n$["field.with.dots"]: expected a value meeting the minimum constraint',
        },
      ],
    });
  });
});
