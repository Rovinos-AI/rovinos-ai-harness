// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { lookupCapabilities } from "@harness/schemas";
import { z } from "zod";
import {
  createEnforcementResultSchema,
  OutputWithToolsUnsupportedError,
  parseEnforcementResult,
  selectEnforcementRung,
  stripSyntheticToolCall,
} from "./index.js";

describe("structured-output enforcement selection", () => {
  it.each([
    [{ structuredOutput: "native", forcedToolChoice: false }, undefined, "native"],
    [{ structuredOutput: "tool", forcedToolChoice: true }, undefined, "tool"],
    [{ structuredOutput: "none", forcedToolChoice: true }, undefined, "tool"],
    [{ structuredOutput: "json_mode", forcedToolChoice: false }, undefined, "prompt"],
    [{ structuredOutput: "none", forcedToolChoice: false }, undefined, "prompt"],
    [{ structuredOutput: "tool", forcedToolChoice: false }, undefined, "prompt"],
    [{ structuredOutput: "native", forcedToolChoice: false }, "native", "native"],
    [{ structuredOutput: "tool", forcedToolChoice: true }, "native", undefined],
    [{ structuredOutput: "tool", forcedToolChoice: true }, "tool", "tool"],
    [{ structuredOutput: "none", forcedToolChoice: false }, "tool", undefined],
    [{ structuredOutput: "none", forcedToolChoice: false }, "prompt", "prompt"],
  ] as const)("selects the available capped rung", (capabilityOverrides, maxRung, expected) => {
    const capabilities = lookupCapabilities(
      { provider: "openai", model: "test" },
      capabilityOverrides,
    ).capabilities;
    expect(selectEnforcementRung(capabilities, maxRung)).toBe(expected);
  });

  it("strips only the synthetic result-tool call", () => {
    const parts = [
      { type: "text" as const, text: "keep" },
      {
        type: "tool_call" as const,
        callId: "00000000000000000000000000",
        toolId: "emit_result",
        args: {},
      },
      {
        type: "tool_call" as const,
        callId: "00000000000000000000000001",
        toolId: "other",
        args: {},
      },
    ];

    expect(stripSyntheticToolCall(parts)).toEqual([parts[0], parts[2]]);
  });

  it("uses a stable typed error for output requests with tools", () => {
    expect(new OutputWithToolsUnsupportedError().code).toBe("output_with_tools_unsupported");
  });

  it("validates enforcement results against the requested output schema", () => {
    const outputSchema = z.object({ answer: z.string() });
    const resultSchema = createEnforcementResultSchema(outputSchema);
    const result = parseEnforcementResult(outputSchema, {
      value: { answer: "ok" },
      valid: true,
      rungUsed: "native",
    });

    expect(resultSchema.parse(result)).toEqual(result);
    expect(
      resultSchema.safeParse({ value: { answer: 42 }, valid: true, rungUsed: "native" }).success,
    ).toBe(false);
  });
});
