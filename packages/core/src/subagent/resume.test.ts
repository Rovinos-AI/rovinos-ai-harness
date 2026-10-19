// SPDX-License-Identifier: Apache-2.0
import {
  EventSchema,
  Id,
  RunConfigSchema,
  type Event,
} from "@harness/schemas";
import { InMemoryEventStore } from "@harness/store";
import { describe, expect, it, vi } from "vitest";
import type { ModelToolCall, ToolPort } from "../ports.js";
import { foldRunState } from "../run-state.js";
import type { ResolvedRole } from "../roles.js";
import type { ToolResumeContext } from "../resume-policy.js";
import { RunScopeRegistry } from "./scope.js";
import { recoverSubagentSpawn } from "./resume.js";
import type { SubagentRunRequest, SubagentRunner } from "./supervisor.js";

const parentRunId = Id.parse("00000000000000000000000000");
const childRunId = Id.parse("11111111111111111111111111");
const callId = Id.parse("22222222222222222222222222");
const segmentId = Id.parse("33333333333333333333333333");
const hash = "a".repeat(64);
const role: ResolvedRole = {
  id: "worker",
  tools: [],
  maxDepth: 1,
  maxChildren: 1,
};
const spawnCall: ModelToolCall = {
  callId,
  toolId: "agent.spawn",
  args: { role: "worker", goal: "recover child" },
};

function event(runId: Id, seq: number, payload: Record<string, unknown>): Event {
  return EventSchema.parse({
    runId,
    seq,
    ts: seq + 1,
    traceId: "a".repeat(32),
    spanId: "b".repeat(16),
    segmentId,
    ...payload,
  });
}

function parentHistory(includeSpawn: boolean, includeBudgetMetadata = true): Event[] {
  const events: Event[] = [
    event(parentRunId, 0, {
      type: "run_created",
      v: 1,
      configHash: hash,
      policyVersion: "test",
      scopeId: parentRunId,
      depth: 0,
    }),
    event(parentRunId, 1, {
      type: "run_status_changed",
      v: 1,
      from: "pending",
      to: "running",
      reason: "start",
    }),
    event(parentRunId, 2, {
      type: "tool_intent",
      v: 1,
      callId,
      toolId: "agent.spawn",
      idempotent: false,
      policyDecision: "allow",
      argsHash: hash,
      args: spawnCall.args,
    }),
  ];
  if (includeSpawn) {
    events.push(
      event(parentRunId, 3, {
        type: "subagent_spawned",
        v: 1,
        childRunId,
        role: "worker",
        parentCallId: callId,
        ...(includeBudgetMetadata
          ? {
              budgetLimits: RunConfigSchema.parse({}).budgets,
              budgetDeadlineTs: 1_000,
            }
          : {}),
      }),
    );
  }
  return events;
}

function childHistory(status: "running" | "completed" = "running"): Event[] {
  const events = [
    event(childRunId, 0, {
      type: "run_created",
      v: 1,
      configHash: hash,
      policyVersion: "test",
      parentRunId,
      parentCallId: callId,
      depth: 1,
    }),
    event(childRunId, 1, {
      type: "run_input",
      v: 1,
      input: { goal: "recover child" },
      inputKind: "initial",
    }),
    event(childRunId, 2, {
      type: "run_status_changed",
      v: 1,
      from: "pending",
      to: "running",
      reason: "start",
    }),
  ];
  if (status === "completed") {
    events.push(
      event(childRunId, 3, {
        type: "run_status_changed",
        v: 1,
        from: "running",
        to: "completed",
        reason: "completed",
      }),
    );
  }
  return events;
}

async function seed(store: InMemoryEventStore, options: {
  readonly includeSpawn?: boolean;
  readonly childStatus?: "running" | "completed";
  readonly completed?: boolean;
  readonly budgetMetadata?: boolean;
  readonly childOnlyCreated?: boolean;
} = {}): Promise<Event[]> {
  const events = parentHistory(
    options.includeSpawn ?? true,
    options.budgetMetadata ?? true,
  );
  await store.append(parentRunId, events, 0);
  if (options.includeSpawn !== false && options.childStatus !== undefined) {
    const child = childHistory(options.childStatus);
    if (options.childOnlyCreated === true) {
      child.splice(1);
    }
    await store.append(childRunId, child, 0);
  }
  if (options.completed === true) {
    const completion = event(parentRunId, events.length, {
      type: "subagent_completed",
      v: 1,
      childRunId,
      outcome: "completed",
      inputTokens: 0,
      outputTokens: 0,
      steps: 0,
    });
    await store.append(parentRunId, [completion], events.length);
    events.push(completion);
  }
  return events;
}

function createOptions(
  store: InMemoryEventStore,
  parentEvents: readonly Event[],
  runChild: SubagentRunner = vi.fn<SubagentRunner>(),
  signal = new AbortController().signal,
) {
  const scopes = new RunScopeRegistry();
  scopes.register(parentRunId, parentRunId);
  const tools: ToolPort = {
    describe: () => undefined,
    execute: () => Promise.resolve({ outcome: "ok", result: null }),
  };
  const context: ToolResumeContext = {
    runId: parentRunId,
    signal,
    toolRegistry: tools,
  };
  return {
    store,
    scopes,
    role,
    call: spawnCall,
    state: foldRunState(parentEvents),
    context,
    childTools: tools,
    runConfig: RunConfigSchema.parse({}),
    runChild,
  };
}

function appendTerminalChild(store: InMemoryEventStore): Promise<void> {
  return store
    .append(
      childRunId,
      [
        event(childRunId, 3, {
          type: "model_response",
          v: 1,
          requestId: Id.parse("44444444444444444444444444"),
          provider: "test",
          model: "test",
          inputTokens: 2,
          outputTokens: 3,
          finishReason: "stop",
          latencyMs: 0,
          schemaValid: true,
          repairAttempts: 0,
          content: [{ type: "text", text: "resumed" }],
          providerBlobs: null,
        }),
        event(childRunId, 4, {
          type: "run_status_changed",
          v: 1,
          from: "running",
          to: "completed",
          reason: "completed",
        }),
      ],
      3,
    )
    .then(() => undefined);
}

describe("recoverSubagentSpawn", () => {
  it("reruns safely when the parent never durably announced a child", async () => {
    const store = new InMemoryEventStore();
    const parentEvents = await seed(store, { includeSpawn: false });

    await expect(recoverSubagentSpawn(createOptions(store, parentEvents))).resolves.toEqual({
      kind: "rerun",
    });
  });

  it("records a missing-child error when the spawn exists but its child log does not", async () => {
    const store = new InMemoryEventStore();
    const parentEvents = await seed(store);

    await expect(recoverSubagentSpawn(createOptions(store, parentEvents))).resolves.toMatchObject({
      kind: "result",
      execution: { outcome: "error", errorCode: "subagent_missing" },
      completion: { childRunId, outcome: "failed" },
    });
  });

  it("fails closed and records completion when the announcement has no budget bounds", async () => {
    const store = new InMemoryEventStore();
    const parentEvents = await seed(store, {
      budgetMetadata: false,
      childStatus: "running",
    });

    await expect(recoverSubagentSpawn(createOptions(store, parentEvents))).resolves.toMatchObject({
      kind: "result",
      execution: { outcome: "error", errorCode: "subagent_budget_missing" },
      completion: { childRunId, outcome: "failed" },
    });
  });

  it("delivers a terminal child's result and completion exactly once", async () => {
    const store = new InMemoryEventStore();
    const parentEvents = await seed(store, { childStatus: "completed" });
    const options = createOptions(store, parentEvents);

    await expect(recoverSubagentSpawn(options)).resolves.toMatchObject({
      kind: "result",
      execution: {
        outcome: "ok",
        result: { childRunId, status: "completed", value: { text: "" } },
      },
      completion: { childRunId, outcome: "completed" },
    });
    expect(options.scopes.scopeOf(childRunId)).toBe(parentRunId);
  });

  it("does not duplicate an already-recorded terminal completion", async () => {
    const store = new InMemoryEventStore();
    const parentEvents = await seed(store, { childStatus: "completed", completed: true });

    const decision = await recoverSubagentSpawn(createOptions(store, parentEvents));
    expect(decision).toMatchObject({
      kind: "result",
      execution: { outcome: "ok" },
    });
    expect(decision.kind === "result" && decision.completion).toBeUndefined();
  });

  it("resumes a non-terminal child and delivers its result", async () => {
    const store = new InMemoryEventStore();
    const parentEvents = await seed(store, { childStatus: "running" });
    const runChild = vi.fn<SubagentRunner>(async (request: SubagentRunRequest) => {
      expect(request.runId).toBe(childRunId);
      expect(request.scopeId).toBe(parentRunId);
      await appendTerminalChild(store);
      return {
        childRunId,
        status: "completed",
        value: { text: "resumed" },
        usage: { inputTokens: 2, outputTokens: 3 },
      };
    });

    const options = createOptions(store, parentEvents, runChild);

    await expect(recoverSubagentSpawn(options)).resolves.toMatchObject({
      kind: "result",
      execution: {
        outcome: "ok",
        result: { childRunId, status: "completed", value: { text: "resumed" } },
      },
      completion: { inputTokens: 2, outputTokens: 3, outcome: "completed" },
    });
    expect(runChild).toHaveBeenCalledTimes(1);
    expect(options.scopes.scopeOf(childRunId)).toBe(parentRunId);
  });

  it("recovers a child log containing only run_created", async () => {
    const store = new InMemoryEventStore();
    const parentEvents = await seed(store, {
      childStatus: "running",
      childOnlyCreated: true,
    });
    const runChild = vi.fn<SubagentRunner>(async (request: SubagentRunRequest) => {
      expect(request.input).toEqual({ goal: "recover child" });
      await store.append(
        childRunId,
        [
          event(childRunId, 1, {
            type: "run_input",
            v: 1,
            input: request.input,
            inputKind: "initial",
          }),
          event(childRunId, 2, {
            type: "run_status_changed",
            v: 1,
            from: "pending",
            to: "running",
            reason: "start",
          }),
          event(childRunId, 3, {
            type: "run_status_changed",
            v: 1,
            from: "running",
            to: "completed",
            reason: "completed",
          }),
        ],
        1,
      );
      return {
        childRunId,
        status: "completed",
        value: { text: "recovered" },
        usage: { inputTokens: 0, outputTokens: 0 },
      };
    });

    await expect(
      recoverSubagentSpawn(createOptions(store, parentEvents, runChild)),
    ).resolves.toMatchObject({
      kind: "result",
      execution: { outcome: "ok" },
    });
    expect(runChild).toHaveBeenCalledOnce();
  });

  it("suspends the parent when the resumed child still awaits approval", async () => {
    const store = new InMemoryEventStore();
    const parentEvents = await seed(store, { childStatus: "running" });
    const runChild: SubagentRunner = () =>
      Promise.resolve({
        childRunId,
        status: "suspended",
        usage: { inputTokens: 0, outputTokens: 0 },
      });

    await expect(recoverSubagentSpawn(createOptions(store, parentEvents, runChild))).resolves.toEqual({
      kind: "suspend",
    });
  });

  it("leaves the spawn dangling when shutdown arrives while the child resumes", async () => {
    const store = new InMemoryEventStore();
    const parentEvents = await seed(store, { childStatus: "running" });
    const controller = new AbortController();
    const runChild: SubagentRunner = () => {
      controller.abort("shutdown");
      return Promise.reject(new Error("child shutdown"));
    };

    await expect(
      recoverSubagentSpawn(createOptions(store, parentEvents, runChild, controller.signal)),
    ).resolves.toEqual({ kind: "shutdown" });
  });

  it("returns a missing-child error if the announcement points to an invalid child log", async () => {
    const store = new InMemoryEventStore();
    const parentEvents = await seed(store);
    const malformed = childHistory("running").map((candidate, index) =>
      candidate.runId === childRunId && candidate.type === "run_created" && index === 0
        ? EventSchema.parse({ ...candidate, parentRunId: Id.parse("99999999999999999999999999") })
        : candidate,
    );
    await store.append(childRunId, malformed, 0);

    await expect(recoverSubagentSpawn(createOptions(store, parentEvents))).resolves.toMatchObject({
      kind: "result",
      execution: { outcome: "error", errorCode: "subagent_missing" },
    });
  });
});
