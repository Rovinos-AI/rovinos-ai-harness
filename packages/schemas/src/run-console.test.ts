// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { RunConsoleDetailSchema, RunConsoleListSchema } from "./run-console.js";

const runId = "00000000000000000000000001";

describe("runs console contracts", () => {
  it("accepts metadata-only list and detail projections", () => {
    expect(
      RunConsoleListSchema.parse({
        runs: [
          {
            runId,
            status: "running",
            createdAt: 1,
            lastTs: 2,
            lastSeq: 3,
            steps: 4,
            pendingApprovals: 0,
          },
        ],
      }).runs,
    ).toHaveLength(1);
    const detail = RunConsoleDetailSchema.parse({
      runId,
      status: "suspended",
      steps: 4,
      usage: { inputTokens: 1, outputTokens: 2, costMicros: 3 },
      pendingApprovals: [
        {
          approvalId: "00000000000000000000000002",
          toolId: "tool.call",
          ruleId: "policy.review",
          expiresAt: 100,
        },
      ],
      recentEvents: [{ type: "run_created" }],
    });
    expect(detail.pendingApprovals).toHaveLength(1);
    expect(detail).not.toHaveProperty("recentEvents");
  });

  it("rejects hostile identifiers and statuses rather than rendering them", () => {
    expect(
      RunConsoleListSchema.safeParse({
        runs: [
          {
            runId: "<img src=x onerror=alert(1)>",
            status: "<script>alert(1)</script>",
            createdAt: 1,
            lastTs: 2,
            lastSeq: 3,
            steps: 4,
            pendingApprovals: 0,
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      RunConsoleDetailSchema.safeParse({
        runId,
        status: "javascript:alert(1)",
        steps: 0,
        usage: { inputTokens: 0, outputTokens: 0, costMicros: 0 },
        pendingApprovals: [],
      }).success,
    ).toBe(false);
  });
});
