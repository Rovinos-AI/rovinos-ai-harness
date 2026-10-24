// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from "vitest";
import { Id, type Event } from "@rovinos/schemas";
import {
  PlanToolPort,
  READ_PLAN_TOOL_SPEC,
  UPDATE_PLAN_TOOL_SPEC,
  type PlanToolPortLike,
} from "./builtin-tools.js";

const runId = Id.parse("00000000000000000000000000");
const otherRunId = Id.parse("33333333333333333333333333");
const thirdRunId = Id.parse("44444444444444444444444444");
const callId = Id.parse("11111111111111111111111111");
const segmentId = Id.parse("22222222222222222222222222");
const context = { runId, signal: new AbortController().signal };
const plan = { items: [{ id: "task.one", text: "Do work", status: "todo" }], notes: "" };

function eventsWithPlan(restoredPlan = plan, eventRunId = runId): Event[] {
  return [
    {
      runId: eventRunId,
      seq: 0,
      ts: 0,
      v: 1,
      traceId: "a".repeat(32),
      spanId: "b".repeat(16),
      segmentId,
      type: "tool_intent",
      callId,
      toolId: "update_plan",
      idempotent: true,
      policyDecision: "allow",
      argsHash: "c".repeat(64),
      args: { plan: restoredPlan },
    },
    {
      runId: eventRunId,
      seq: 1,
      ts: 1,
      v: 1,
      traceId: "a".repeat(32),
      spanId: "b".repeat(16),
      segmentId,
      type: "tool_result",
      callId,
      toolId: "update_plan",
      outcome: "ok",
      latencyMs: 0,
      result: restoredPlan,
    },
  ];
}

function fakePort() {
  const execute = vi.fn<PlanToolPortLike["execute"]>(() =>
    Promise.resolve({ outcome: "ok", result: "delegated" }),
  );
  const inner: PlanToolPortLike = {
    describe: (toolId) =>
      toolId === "sample_tool" ? { idempotent: false, timeoutMs: 1000 } : undefined,
    getToolSpecs: () => [
      UPDATE_PLAN_TOOL_SPEC,
      { toolId: "sample_tool", description: "Sample", inputSchema: { type: "object" } },
    ],
    execute,
  };
  return { inner, execute };
}

describe("PlanToolPort", () => {
  it("restores plan state, declares the built-ins idempotent, and advertises unique specs", () => {
    const { inner } = fakePort();
    const port = new PlanToolPort(inner, eventsWithPlan());

    expect(port.describe("update_plan")).toEqual({ idempotent: true, timeoutMs: 1000 });
    expect(port.describe("read_plan")).toEqual({ idempotent: true, timeoutMs: 1000 });
    expect(port.describe("sample_tool")).toEqual({ idempotent: false, timeoutMs: 1000 });
    expect(port.describe("missing_tool")).toBeUndefined();
    expect(port.getToolSpecs()).toEqual([
      { toolId: "sample_tool", description: "Sample", inputSchema: { type: "object" } },
      UPDATE_PLAN_TOOL_SPEC,
      READ_PLAN_TOOL_SPEC,
    ]);
  });

  it("updates and reads plans in-process and rejects invalid plan or read arguments", async () => {
    const { inner, execute } = fakePort();
    const port = new PlanToolPort(inner);

    await expect(port.execute({ callId, toolId: "read_plan", args: {} }, context)).resolves.toEqual(
      { outcome: "ok", result: { items: [], notes: "" } },
    );
    await expect(
      port.execute({ callId, toolId: "update_plan", args: { plan } }, context),
    ).resolves.toEqual({ outcome: "ok", result: plan });
    await expect(port.execute({ callId, toolId: "read_plan", args: {} }, context)).resolves.toEqual(
      { outcome: "ok", result: plan },
    );
    await expect(
      port.execute(
        { callId, toolId: "update_plan", args: { plan: { items: [], notes: 1 } } },
        context,
      ),
    ).resolves.toEqual({ outcome: "error", errorCode: "invalid_plan", result: null });
    await expect(
      port.execute({ callId, toolId: "read_plan", args: { unexpected: true } }, context),
    ).resolves.toEqual({ outcome: "error", errorCode: "invalid_arguments", result: null });
    await expect(
      port.execute({ callId, toolId: "sample_tool", args: {} }, context),
    ).resolves.toEqual({ outcome: "ok", result: "delegated" });
    expect(execute).toHaveBeenCalledOnce();
  });

  it("isolates restored and in-process plans by run ID", async () => {
    const otherPlan = { items: [], notes: "other run" };
    const updatedPlan = { items: [], notes: "updated run" };
    const { inner } = fakePort();
    const port = new PlanToolPort(inner, [
      ...eventsWithPlan(),
      ...eventsWithPlan(otherPlan, otherRunId),
    ]);
    const otherContext = { ...context, runId: otherRunId };
    const thirdContext = { ...context, runId: thirdRunId };

    await expect(port.execute({ callId, toolId: "read_plan", args: {} }, context)).resolves.toEqual(
      {
        outcome: "ok",
        result: plan,
      },
    );
    await expect(
      port.execute({ callId, toolId: "read_plan", args: {} }, otherContext),
    ).resolves.toEqual({ outcome: "ok", result: otherPlan });
    await expect(
      port.execute({ callId, toolId: "update_plan", args: { plan: updatedPlan } }, context),
    ).resolves.toMatchObject({ outcome: "ok" });
    await expect(port.execute({ callId, toolId: "read_plan", args: {} }, context)).resolves.toEqual(
      {
        outcome: "ok",
        result: updatedPlan,
      },
    );
    await expect(
      port.execute({ callId, toolId: "read_plan", args: {} }, otherContext),
    ).resolves.toEqual({ outcome: "ok", result: otherPlan });
    await expect(
      port.execute({ callId, toolId: "read_plan", args: {} }, thirdContext),
    ).resolves.toEqual({ outcome: "ok", result: { items: [], notes: "" } });
  });

  it("provides built-in specs when the inner port does not expose any", () => {
    const port = new PlanToolPort({
      describe: () => undefined,
      execute: () => Promise.resolve({ outcome: "ok", result: null }),
    });

    expect(port.getToolSpecs()).toEqual([UPDATE_PLAN_TOOL_SPEC, READ_PLAN_TOOL_SPEC]);
  });
});
