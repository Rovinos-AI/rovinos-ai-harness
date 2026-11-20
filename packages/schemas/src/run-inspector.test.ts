// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { RunContentSchema, RunInspectorRunIdSchema, RunTimelineSchema } from "./run-inspector.js";

const runId = "00000000000000000000000001";

describe("run inspector contracts", () => {
  it("accepts metadata timelines and tokenized content projections", () => {
    expect(RunInspectorRunIdSchema.parse({ runId, recentEvents: ["content is ignored"] })).toEqual({
      runId,
    });
    expect(
      RunTimelineSchema.parse({
        runId,
        status: "running",
        lastSeq: 2,
        steps: [
          {
            type: "tool_call",
            seq: 1,
            lastSeq: 2,
            startedAt: 1,
            endedAt: 2,
            durationMs: 1,
            status: "completed",
            toolId: "test.tool",
            policyDecision: "allow",
            outcome: "ok",
          },
        ],
        usage: {
          steps: 1,
          inputTokens: 2,
          outputTokens: 3,
          cost: {
            version: 1,
            state: "known",
            knownMicros: 4,
            estimatedMicros: 0,
            partialMicros: 0,
            knownCount: 1,
            estimatedCount: 0,
            partialCount: 0,
            unknownCount: 0,
          },
        },
      }).steps,
    ).toHaveLength(1);
    expect(
      RunContentSchema.parse({
        runId,
        truncated: false,
        events: [{ seq: 1, type: "model_request", value: "<EMAIL_1>" }],
      }).events,
    ).toHaveLength(1);
  });

  it("rejects content fields in metadata timelines and invalid tokenized payloads", () => {
    expect(
      RunTimelineSchema.safeParse({
        runId,
        status: "running",
        lastSeq: 1,
        steps: [
          {
            type: "model_call",
            seq: 1,
            lastSeq: 1,
            startedAt: 1,
            content: "private input",
          },
        ],
        usage: {
          steps: 0,
          inputTokens: 0,
          outputTokens: 0,
          cost: {
            version: 1,
            state: "known",
            knownMicros: 0,
            estimatedMicros: 0,
            partialMicros: 0,
            knownCount: 0,
            estimatedCount: 0,
            partialCount: 0,
            unknownCount: 0,
          },
        },
      }).success,
    ).toBe(false);
    expect(
      RunContentSchema.safeParse({
        runId,
        truncated: false,
        events: [{ seq: -1, type: "model_request", value: "invalid" }],
      }).success,
    ).toBe(false);
  });
});
