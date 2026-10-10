// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { ProviderResultSchema } from "./types.js";

describe("provider result contract", () => {
  it("accepts normalized parts, usage, finish reason, and latency", () => {
    const result = {
      parts: [{ type: "text", text: "hello" }],
      usage: { inputTokens: 2, outputTokens: 3 },
      finishReason: "stop",
      latencyMs: 4,
    };

    expect(ProviderResultSchema.parse(result)).toEqual(result);
  });

  it("rejects invalid usage and negative latency", () => {
    const result = {
      parts: [],
      usage: { inputTokens: -1, outputTokens: 3 },
      finishReason: "stop",
      latencyMs: -1,
    };

    expect(ProviderResultSchema.safeParse(result).success).toBe(false);
  });
});
