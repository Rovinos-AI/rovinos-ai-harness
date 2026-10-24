// SPDX-License-Identifier: Apache-2.0
import { context, trace } from "@opentelemetry/api";
import {
  createRuntime,
  type ModelCompletion,
  type ModelToolCall,
  type PolicyPort,
  type ToolPort,
} from "@harness/core";
import { FakeModelPort, FakeToolPort } from "@harness/core/testing";
import { InMemoryEventStore } from "@harness/store";
import type { EventStore } from "@harness/store";
import {
  Code,
  Event,
  Id,
  RunConfigSchema,
  type Event as EventValue,
} from "@harness/schemas";
import { createTestContextManager, createTestSpanCollector } from "@harness/telemetry/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { replayRun } from "./replay.js";
import { ResolvedRunSchema } from "./resolve.js";
import type { ResolvedRun } from "./resolve.js";

const runConfig = { run: RunConfigSchema.parse({}) };
const toolId = Code.parse("synthetic.write");
let spanCollector: ReturnType<typeof createTestSpanCollector> | undefined;

function completion(parts: ModelCompletion["parts"]): ModelCompletion {
  return {
    parts,
    usage: { inputTokens: 1, outputTokens: 1 },
    finishReason: "stop",
    provider: "synthetic",
    model: "synthetic",
    latencyMs: 1,
    schemaValid: true,
    repairAttempts: 0,
    fallbackDepth: 0,
    providerBlobs: null,
  };
}

function fakeTool(): ToolPort {
  return new FakeToolPort(
    new Map([
      [
        toolId,
        {
          idempotent: true,
          timeoutMs: 1000,
          execute: () => Promise.resolve({ outcome: "ok", result: { complete: true } }),
        },
      ],
    ]),
  );
}

const askPolicy: PolicyPort = {
  version: Code.parse("synthetic.policy"),
  decide: () => ({
    decision: "ask",
    ruleId: Code.parse("synthetic.ask"),
    reason: Code.parse("approval_required"),
    editable: [],
  }),
};

async function readEvents(store: EventStore, runId: Id): Promise<EventValue[]> {
  const events: EventValue[] = [];
  for await (const event of store.read(runId)) {
    events.push(event);
  }
  return events;
}

async function recordRun(
  script: readonly ModelCompletion[],
  policy?: PolicyPort,
): Promise<ResolvedRun> {
  const store = new InMemoryEventStore();
  const runtime = await createRuntime(runConfig, {
    store,
    model: new FakeModelPort(script),
    tool: fakeTool(),
    sandboxBackend: { exec: () => Promise.reject(new Error("Unused synthetic sandbox backend")) },
    transientVault: true,
    ...(policy === undefined ? {} : { policy }),
  });
  try {
    const started = runtime.start("synthetic replay goal");
    let result = await started.completion;
    while (result.status === "suspended") {
      const approval = result.state.pendingApprovals.values().next().value;
      if (approval === undefined) {
        throw new Error("Expected a pending synthetic approval.");
      }
      await runtime.resolveApproval(started.runId, approval.approvalId, "approve", {
        metadata: { decidedBy: "human", approverId: Code.parse("cli.synthetic") },
      });
      result = await runtime.resume(started.runId);
    }
    const events = await readEvents(runtime.store, started.runId);
    return ResolvedRunSchema.parse({
      rootRunId: started.runId,
      runs: [{ runId: started.runId, role: "root", events }],
    });
  } finally {
    await runtime.close();
  }
}

function toolCall(): ModelToolCall {
  return {
    callId: Id.parse("00000000000000000000000071"),
    toolId,
    args: { value: "synthetic" },
  };
}

function withRootEvents(resolved: ResolvedRun, events: readonly EventValue[]): ResolvedRun {
  const root = resolved.runs.find(({ runId }) => runId === resolved.rootRunId);
  if (root === undefined) {
    throw new Error("Expected the synthetic root run.");
  }
  return ResolvedRunSchema.parse({
    rootRunId: resolved.rootRunId,
    runs: [{ ...root, events }],
  });
}

beforeEach(() => {
  trace.disable();
  context.disable();
  spanCollector = createTestSpanCollector();
  trace.setGlobalTracerProvider(spanCollector.provider);
  context.setGlobalContextManager(createTestContextManager());
});

afterEach(async () => {
  await spanCollector?.provider.shutdown();
  trace.disable();
  context.disable();
  spanCollector = undefined;
});

describe("replayRun", () => {
  it("re-executes a run with replayOf and a linked replay span", async () => {
    const original = await recordRun([completion([{ type: "text", text: "synthetic answer" }])]);
    const originalEvents = original.runs[0]?.events ?? [];
    const originalCreated = originalEvents[0];
    const outcome = await replayRun(original, { config: runConfig });
    const replayCreated = outcome.events[0];
    const replaySpan = spanCollector?.getFinishedSpans().find(({ name }) => name === "harness.replay");
    const originalRequest = originalEvents.find((event) => event.type === "model_request");
    const replayRequest = outcome.events.find((event) => event.type === "model_request");

    if (originalRequest?.type !== "model_request" || replayRequest?.type !== "model_request") {
      throw new Error("Expected the original and replay logs to include model requests.");
    }
    expect(replayRequest.messages).toEqual(originalRequest.messages);
    expect({
      provider: replayRequest.provider,
      model: replayRequest.model,
      role: replayRequest.role,
    }).toEqual({
      provider: originalRequest.provider,
      model: originalRequest.model,
      role: originalRequest.role,
    });
    expect(outcome.status).toBe("completed");
    expect(outcome.events.map(({ type }) => type)).toEqual(originalEvents.map(({ type }) => type));
    expect(replayCreated?.type).toBe("run_created");
    if (replayCreated?.type !== "run_created" || originalCreated?.type !== "run_created") {
      throw new Error("Expected both logs to begin with run_created.");
    }
    expect(replayCreated.replayOf).toBe(original.rootRunId);
    expect(outcome.traceId).toBe(replayCreated.traceId);
    expect(replaySpan?.links).toHaveLength(1);
    expect(replaySpan?.links[0]?.context).toMatchObject({
      traceId: originalCreated.traceId,
      spanId: originalCreated.spanId,
    });
    expect(outcome.configDrift).toBe(true);
    expect(outcome.policyDrift).toBe(false);
  });

  it("reports config and policy drift from the original run metadata", async () => {
    const original = await recordRun([completion([{ type: "text", text: "synthetic answer" }])]);
    const events = original.runs[0]?.events ?? [];
    const changed = events.map((event) =>
      event.type === "run_created"
        ? Event.parse({ ...event, configHash: "d".repeat(64), policyVersion: "old.policy" })
        : event,
    );
    const outcome = await replayRun(withRootEvents(original, changed), { config: runConfig });

    expect(outcome.configDrift).toBe(true);
    expect(outcome.policyDrift).toBe(true);
  });

  it("returns model divergence as metadata instead of throwing", async () => {
    const original = await recordRun([completion([{ type: "text", text: "synthetic answer" }])]);
    const events = original.runs[0]?.events ?? [];
    const changed = events.map((event) =>
      event.type === "model_request"
        ? Event.parse({ ...event, requestHash: "d".repeat(64) })
        : event,
    );
    const outcome = await replayRun(withRootEvents(original, changed), { config: runConfig });

    expect(outcome.status).toBe("error");
    expect(outcome.divergence).toMatchObject({ code: "replay_divergence" });
  });

  it("captures a missing recorded response", async () => {
    const original = await recordRun([completion([{ type: "text", text: "synthetic answer" }])]);
    const events = original.runs[0]?.events ?? [];
    const requestIndex = events.findIndex((event) => event.type === "model_request");
    const truncated = events.slice(0, requestIndex + 1);
    const outcome = await replayRun(withRootEvents(original, truncated), { config: runConfig });

    expect(outcome.status).toBe("error");
    expect(outcome.divergence).toMatchObject({ code: "replay_missing_result" });
  });

  it("captures a run without its initial input", async () => {
    const original = await recordRun([completion([{ type: "text", text: "synthetic answer" }])]);
    const events = original.runs[0]?.events ?? [];
    const withoutInput = events.filter((event) => event.type !== "run_input");
    const outcome = await replayRun(withRootEvents(original, withoutInput), { config: runConfig });

    expect(outcome.status).toBe("error");
    expect(outcome.divergence).toMatchObject({ code: "replay_missing_result" });
  });

  it("rejects a resolved log without its root run", async () => {
    const resolved = ResolvedRunSchema.parse({
      rootRunId: Id.parse("00000000000000000000000072"),
      runs: [],
    });

    await expect(replayRun(resolved, { config: runConfig })).rejects.toMatchObject({
      code: "replay_missing_result",
    });
  });

  it("replays subagent logs and surfaces child divergence in the root outcome", async () => {
    const original = await recordRun([completion([{ type: "text", text: "root answer" }])]);
    const child = await recordRun([completion([{ type: "text", text: "child answer" }])]);
    const childRunId = Id.parse("00000000000000000000000072");
    const rootEvents = original.runs[0]?.events ?? [];
    const childEvents = (child.runs[0]?.events ?? []).map((event) =>
      Event.parse({
        ...event,
        runId: childRunId,
        ...(event.type === "run_created" ? { parentRunId: original.rootRunId } : {}),
        ...(event.type === "model_request" ? { requestHash: "d".repeat(64) } : {}),
      }),
    );
    const resolved = ResolvedRunSchema.parse({
      rootRunId: original.rootRunId,
      runs: [
        { runId: original.rootRunId, role: "root", events: rootEvents },
        {
          runId: childRunId,
          role: "subagent",
          parentRunId: original.rootRunId,
          events: childEvents,
        },
      ],
    });

    const outcome = await replayRun(resolved, { config: runConfig });
    const created = outcome.events.filter((event) => event.type === "run_created");
    const replayRoot = created.find((event) => event.type === "run_created" && event.replayOf === original.rootRunId);
    const replayChild = created.find((event) => event.type === "run_created" && event.replayOf === childRunId);

    expect(outcome.status).toBe("error");
    expect(outcome.divergence).toMatchObject({ code: "replay_divergence" });
    expect(replayRoot?.type).toBe("run_created");
    expect(replayChild).toMatchObject({
      type: "run_created",
      replayOf: childRunId,
      parentRunId: outcome.replayRunId,
    });
    expect(replayChild?.traceId).toBe(outcome.traceId);
  });

  it("resolves recorded approvals and completes suspended runs", async () => {
    const original = await recordRun(
      [
        completion([{ type: "tool_call", ...toolCall() }]),
        completion([{ type: "text", text: "approved synthetic action" }]),
      ],
      askPolicy,
    );
    const outcome = await replayRun(original, { config: runConfig, policy: askPolicy });

    expect(outcome.status).toBe("completed");
    expect(outcome.events.some((event) => event.type === "approval_resolved")).toBe(true);
    expect(outcome.events.every((event) => event.type !== "run_created" || event.replayOf !== undefined))
      .toBe(true);
  });
});
