// SPDX-License-Identifier: Apache-2.0
import { eventSamples } from "@rovinos/schemas";
import { describe, expect, it } from "vitest";
import { groupRunTimeline } from "./run-timeline.js";

describe("run timeline grouping", () => {
  it("groups every supported event type into content-free steps", () => {
    const events = eventSamples.map((event, seq) => ({
      ...event,
      seq,
      ts: seq + 1,
    }));
    const steps = groupRunTimeline(events);

    expect(steps.map(({ type }) => type)).toEqual(
      expect.arrayContaining([
        "model_call",
        "tool_call",
        "approval_wait",
        "input_wait",
        "checkpoint",
        "compaction",
        "subagent_spawn",
        "subagent_completion",
        "budget_exceeded",
        "run_status",
      ]),
    );
    expect(steps.find(({ type }) => type === "tool_call")).toMatchObject({
      policyDecision: "allow",
      outcome: "ok",
      status: "completed",
    });
    expect(steps.find(({ type }) => type === "model_call")).toMatchObject({
      inputTokens: 1,
      outputTokens: 2,
      durationMs: 3,
    });
    expect(steps.find(({ type }) => type === "approval_wait")).toMatchObject({
      status: "approved",
      durationMs: 1,
    });
    expect(steps.find(({ type }) => type === "subagent_spawn")).toMatchObject({
      maxSteps: 10,
      role: "researcher",
    });
    expect(JSON.stringify(steps)).not.toContain("hello");
    expect(JSON.stringify(steps)).not.toContain("app content");
  });

  it("includes a step completed after sinceSeq even when it started before it", () => {
    const events = eventSamples
      .filter((event) => event.type === "approval_requested" || event.type === "approval_resolved")
      .map((event, seq) => ({ ...event, seq, ts: seq + 1 }));

    expect(groupRunTimeline(events, 0)).toMatchObject([
      {
        type: "approval_wait",
        seq: 0,
        lastSeq: 1,
        status: "approved",
      },
    ]);
  });

  it("preserves run status transitions in status timeline steps", () => {
    const sample = eventSamples.find((event) => event.type === "run_status_changed");
    if (sample?.type !== "run_status_changed") {
      throw new Error("Missing run status fixture.");
    }
    const targets = [
      "pending",
      "running",
      "suspended",
      "completed",
      "failed",
      "cancelled",
    ] as const;
    const events = targets.map((to, seq) => ({
      ...sample,
      from: "running" as const,
      to,
      seq,
      ts: seq + 1,
    }));

    expect(groupRunTimeline(events).map(({ status }) => status)).toEqual(targets);
  });
});
