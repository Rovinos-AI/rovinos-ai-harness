// SPDX-License-Identifier: Apache-2.0
import { Event, Id } from "@rovinos/schemas";
import { describe, expect, it } from "vitest";
import { reportGrade, reportTrial } from "../../test-utils/report.js";
import { computeTrialMetrics, executionMetricsFromEvents } from "./metrics.js";

const envelope = {
  runId: Id.parse("00000000000000000000000001"),
  ts: 1,
  v: 1,
  traceId: "11111111111111111111111111111111",
  spanId: "2222222222222222",
  segmentId: Id.parse("00000000000000000000000002"),
};

function modelResponse(seq: number, repairAttempts: number, fallbackDepth: number) {
  return Event.parse({
    ...envelope,
    seq,
    type: "model_response",
    requestId: Id.parse("00000000000000000000000003"),
    provider: "test",
    model: "test_model",
    inputTokens: 1,
    outputTokens: 1,
    finishReason: "stop",
    latencyMs: 1,
    schemaValid: true,
    repairAttempts,
    fallbackDepth,
    content: [],
    providerBlobs: {},
  });
}

describe("eval report metrics", () => {
  it("derives only bounded execution counters from events", () => {
    const events = [
      modelResponse(0, 1, 1),
      modelResponse(1, 2, 3),
      Event.parse({
        ...envelope,
        seq: 2,
        type: "tool_result",
        callId: Id.parse("00000000000000000000000004"),
        toolId: "test_tool",
        outcome: "denied",
        latencyMs: 1,
        result: {},
      }),
      Event.parse({
        ...envelope,
        seq: 3,
        type: "budget_exceeded",
        budget: "steps",
        limit: 1,
        observed: 2,
      }),
    ];

    expect(executionMetricsFromEvents(events, 4)).toEqual({
      steps: 4,
      repairAttempts: 3,
      fallbackDepth: 3,
      deniedToolCalls: 1,
      budgetExceeded: true,
    });
  });

  it("includes grade usage and records failures using codes only", () => {
    const record = reportTrial({
      result: {
        usage: { inputTokens: 2, outputTokens: 3, costMicros: 4 },
        durationMs: 50,
        metrics: {
          steps: 1,
          repairAttempts: 2,
          fallbackDepth: 1,
          deniedToolCalls: 3,
          budgetExceeded: false,
        },
      },
    });
    const metric = computeTrialMetrics(record, [
      reportGrade(false, ["content_mismatch"], "file_diff", {
        inputTokens: 5,
        outputTokens: 6,
        costMicros: 7,
      }),
    ]);

    expect(metric).toMatchObject({
      passed: false,
      graders: [{ graderId: "file_diff", pass: false, codes: ["content_mismatch"] }],
      inputTokens: 7,
      outputTokens: 9,
      costMicros: 11,
      wallTimeMs: 50,
      repairAttempts: 2,
      fallbackDepth: 1,
      deniedToolCalls: 3,
    });
  });

  it("retains a status code for a failed trial without grader failures", () => {
    const record = reportTrial({
      result: { status: "error", errorCode: "synthetic_error" },
    });
    const metric = computeTrialMetrics(record, [reportGrade(true)]);

    expect(metric).toMatchObject({
      passed: false,
      graders: [
        { graderId: "file_diff", pass: true, codes: [] },
        { graderId: "trial_status", pass: false, codes: ["synthetic_error"] },
      ],
    });
  });
});
