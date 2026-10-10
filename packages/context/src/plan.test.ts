// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { Id, JsonValue, type Event } from "@harness/schemas";
import { derivePlan, PlanSchema, renderPlanMessage } from "./plan.js";

const runId = Id.parse("00000000000000000000000000");
const segmentId = Id.parse("11111111111111111111111111");
const traceId = "a".repeat(32);
const spanId = "b".repeat(16);
const hash = "c".repeat(64);
const firstCallId = Id.parse("22222222222222222222222222");
const secondCallId = Id.parse("33333333333333333333333333");
const plan = {
  items: [{ id: "task.one", text: "Do the first task", status: "doing" as const }],
  notes: "Keep the result",
};

function envelope(seq: number) {
  return { runId, seq, ts: seq, v: 1, traceId, spanId, segmentId };
}

function updateIntent(seq: number, callId: Id, args: JsonValue): Event {
  return {
    ...envelope(seq),
    type: "tool_intent",
    callId,
    toolId: "update_plan",
    idempotent: true,
    policyDecision: "allow",
    argsHash: hash,
    args,
  };
}

function toolResult(
  seq: number,
  callId: Id,
  outcome: Extract<Event, { type: "tool_result" }>["outcome"] = "ok",
  toolId = "update_plan",
): Event {
  return {
    ...envelope(seq),
    type: "tool_result",
    callId,
    toolId,
    outcome,
    latencyMs: 0,
    result: null,
  };
}

describe("PlanSchema", () => {
  it("accepts valid plans at the configured limits", () => {
    expect(
      PlanSchema.safeParse({
        items: Array.from({ length: 50 }, (_, index) => ({
          id: `task.${String(index)}`,
          text: "x".repeat(500),
          status: "todo",
        })),
        notes: "x".repeat(4000),
      }).success,
    ).toBe(true);
  });

  it("rejects invalid codes, statuses, item counts, and text lengths", () => {
    expect(PlanSchema.safeParse({ items: [], notes: "x".repeat(4001) }).success).toBe(false);
    expect(
      PlanSchema.safeParse({
        items: Array.from({ length: 51 }, () => ({ id: "task.one", text: "", status: "todo" })),
        notes: "",
      }).success,
    ).toBe(false);
    expect(
      PlanSchema.safeParse({
        items: [{ id: "INVALID", text: "x".repeat(501), status: "blocked" }],
        notes: "",
      }).success,
    ).toBe(false);
  });
});

describe("derivePlan", () => {
  it("derives the latest successful update even when events arrive out of order", () => {
    const events = [
      toolResult(4, secondCallId),
      updateIntent(3, secondCallId, { plan: { items: [], notes: "latest" } }),
      toolResult(2, firstCallId),
      updateIntent(1, firstCallId, { plan }),
    ];

    expect(derivePlan(events)).toEqual({ items: [], notes: "latest" });
    expect(events).toHaveLength(4);
  });

  it("ignores failed, mismatched, orphaned, and invalid updates", () => {
    const events = [
      updateIntent(1, firstCallId, { plan }),
      toolResult(2, firstCallId, "error"),
      updateIntent(3, secondCallId, { plan }),
      toolResult(4, secondCallId, "ok", "other_tool"),
      toolResult(5, Id.parse("44444444444444444444444444")),
      updateIntent(6, firstCallId, JsonValue.parse({ plan: { items: [], notes: 1 } })),
      toolResult(7, firstCallId),
    ];

    expect(derivePlan(events)).toBeUndefined();
  });

  it("returns undefined when there are no successful plan updates", () => {
    expect(derivePlan([])).toBeUndefined();
    expect(derivePlan([toolResult(1, firstCallId)])).toBeUndefined();
  });

  it("renders a deterministic user message, including an empty plan when absent", () => {
    const message = renderPlanMessage(plan);

    expect(message).toEqual({
      role: "user",
      parts: [
        {
          type: "text",
          text: 'Current plan: {"items":[{"id":"task.one","text":"Do the first task","status":"doing"}],"notes":"Keep the result"}',
        },
      ],
    });
    expect(renderPlanMessage(plan)).toEqual(message);
    expect(renderPlanMessage(undefined).parts[0]).toEqual({
      type: "text",
      text: 'Current plan: {"items":[],"notes":""}',
    });
  });
});
