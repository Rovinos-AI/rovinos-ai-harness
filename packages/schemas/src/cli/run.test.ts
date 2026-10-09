// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { FakeModelScriptSchema, RunInputSchema, RunResultSchema } from "./run.js";

describe("run CLI schemas", () => {
  it("validates task input and the command result", () => {
    const input = RunInputSchema.parse({ goal: "answer", metadata: { count: 2, mode: "safe" } });

    expect(input).toEqual({ goal: "answer", metadata: { count: 2, mode: "safe" } });
    expect(
      RunResultSchema.parse({
        runId: "00000000000000000000000000",
        status: "completed",
      }),
    ).toEqual({ runId: "00000000000000000000000000", status: "completed" });
  });

  it("rejects malformed input and applies fake completion defaults", () => {
    expect(() => RunInputSchema.parse({ goal: "" })).toThrow();
    expect(() => RunInputSchema.parse({ goal: "answer", extra: true })).toThrow();
    expect(FakeModelScriptSchema.parse([{ content: "answer" }])).toEqual([
      {
        content: "answer",
        toolCalls: [],
        usage: { inputTokens: 0, outputTokens: 0 },
        finishReason: "stop",
        provider: "fake",
        model: "script",
        latencyMs: 0,
        schemaValid: true,
        repairAttempts: 0,
        providerBlobs: null,
      },
    ]);
    expect(() => FakeModelScriptSchema.parse([{ content: "answer", unknown: true }])).toThrow();
  });
});
