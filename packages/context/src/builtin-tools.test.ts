// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from "vitest";
import { Id, type Event } from "@harness/schemas";
import {
  PlanToolPort,
  READ_PLAN_TOOL_SPEC,
  UPDATE_PLAN_TOOL_SPEC,
  type PlanToolPortLike,
} from "./builtin-tools.js";

const runId = Id.parse("00000000000000000000000000");
const callId = Id.parse("11111111111111111111111111");
const segmentId = Id.parse("22222222222222222222222222");
const context = { runId, signal: new AbortController().signal };
const plan = { items: [{ id: "task.one", text: "Do work", status: "todo" }], notes: "" };

function eventsWithPlan(): Event[] {
  return [
    {
      runId,
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
      args: { plan },
    },
    {
      runId,
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
      result: plan,
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

  it("provides built-in specs when the inner port does not expose any", () => {
    const port = new PlanToolPort({
      describe: () => undefined,
      execute: () => Promise.resolve({ outcome: "ok", result: null }),
    });

    expect(port.getToolSpecs()).toEqual([UPDATE_PLAN_TOOL_SPEC, READ_PLAN_TOOL_SPEC]);
  });
});
