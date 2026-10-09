// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { InspectResultSchema } from "./inspect.js";

describe("inspect CLI schema", () => {
  it("accepts content-free event summaries and optional stored content", () => {
    const summary = {
      runId: "00000000000000000000000000",
      status: "suspended",
      steps: 1,
      usage: { inputTokens: 2, outputTokens: 3, costMicros: 0 },
      lastCheckpoint: null,
      pendingApprovals: [{ approvalId: "11111111111111111111111111", toolId: "test_tool" }],
      events: [
        { type: "model_response", seq: 3 },
        { type: "tool_intent", seq: 4, event: { args: { token: "<EMAIL_1>" } } },
      ],
    };

    expect(InspectResultSchema.parse(summary)).toEqual(summary);
    expect(() => InspectResultSchema.parse({ ...summary, unsafe: true })).toThrow();
  });
});
