// SPDX-License-Identifier: Apache-2.0
import {
  Code,
  FakeClock,
  Id,
  ModelsConfigSchema,
  RunConfigSchema,
  SequentialIdGenerator,
} from "@harness/schemas";
import type { Event, Id as IdType } from "@harness/schemas";
import { InMemoryEventStore } from "@harness/store";
import { ensureTracingFallback } from "@harness/telemetry";
import { describe, expect, it } from "vitest";
import type {
  ModelCompletion,
  ModelPort,
  ModelRequest,
  PolicyPort,
  RunContext,
  ToolPort,
} from "../ports.js";
import { RUN_SPAN, TOOL_CALL_SPAN } from "../spans.js";
import { RunRecorder } from "../recorder.js";
import { resolveRuntimeRoles, createSubagentTool } from "./runtime.js";
import { RunScopeRegistry } from "./scope.js";

const parentRunId = Id.parse("99999999999999999999999999");
const parentCallId = Id.parse("11111111111111111111111111");
const configHash = "a".repeat(64);

function ensureTracing(): void {
  ensureTracingFallback(
    RUN_SPAN.start({
      "harness.run.id": parentRunId,
      "harness.segment.id": Id.parse("77777777777777777777777777"),
    }),
  );
}

function completion(): ModelCompletion {
  return {
    parts: [{ type: "text", text: "child answer" }],
    usage: { inputTokens: 1, outputTokens: 1 },
    finishReason: "stop",
    provider: "test",
    model: "worker-model",
    latencyMs: 0,
    schemaValid: true,
    repairAttempts: 0,
    fallbackDepth: 0,
    providerBlobs: null,
  };
}

async function readEvents(store: InMemoryEventStore, runId: IdType): Promise<Event[]> {
  const events: Event[] = [];
  for await (const event of store.read(runId)) {
    events.push(event);
  }
  return events;
}

describe("production subagent runtime", () => {
  it("routes the child through its role and persists isolated run metadata", async () => {
    ensureTracing();
    const store = new InMemoryEventStore();
    const clock = new FakeClock(10);
    const ids = new SequentialIdGenerator();
    const scopes = new RunScopeRegistry();
    const modelRequests: ModelRequest[] = [];
    const model: ModelPort = {
      complete: (request) => {
        modelRequests.push(request);
        return Promise.resolve(completion());
      },
    };
    const parentTools: ToolPort = {
      describe: (toolId) =>
        toolId === "test.read" ? { idempotent: true, timeoutMs: 1_000 } : undefined,
      getToolSpecs: () => [{ toolId: "test.read", description: "Read a fixture", inputSchema: {} }],
      execute: () => Promise.resolve({ outcome: "ok", result: null }),
    };
    const config = {
      run: RunConfigSchema.parse({}),
      models: ModelsConfigSchema.parse({
        routing: {
          default: [{ provider: "local", model: "parent" }],
          roles: { worker_route: [{ provider: "local", model: "worker-model" }] },
        },
      }),
      roles: [
        {
          id: "worker",
          route: "worker_route",
          systemPrompt: "Follow the task.",
          contextStrategy: "naive",
          tools: ["test.read"],
          maxDepth: 2,
          maxChildren: 2,
        },
      ],
    };
    const roles = await resolveRuntimeRoles(config, process.cwd(), parentTools, () => undefined);
    const policy: PolicyPort = {
      version: Code.parse("test.policy"),
      decide: () => ({
        decision: "allow",
        ruleId: "test_allow",
        reason: "test_allowed",
        editable: [],
      }),
    };
    const childTool = createSubagentTool({
      config,
      clock,
      ids,
      store,
      model,
      parentTool: parentTools,
      policy,
      policyVersion: policy.version,
      roles,
      scopes,
    });
    const parentRecorder = new RunRecorder(
      store,
      parentRunId,
      Id.parse("88888888888888888888888888"),
      0,
      clock,
    );
    await parentRecorder.withStepSpan(RUN_SPAN, {}, async () => {
      const events = await parentRecorder.recordBatch([
        {
          type: "run_created",
          v: 1,
          configHash,
          policyVersion: "test",
          scopeId: parentRunId,
        },
        {
          type: "run_status_changed",
          v: 1,
          from: "pending",
          to: "running",
          reason: "start",
        },
      ]);
      const last = events.at(-1);
      if (last === undefined) {
        throw new Error("Expected parent seed events.");
      }
      return last;
    });

    let spawnResult: Awaited<ReturnType<ToolPort["execute"]>> | undefined;
    await parentRecorder.withStepSpan(TOOL_CALL_SPAN, {}, async () => {
      const context: RunContext = {
        runId: parentRunId,
        signal: new AbortController().signal,
        toolRegistry: childTool,
        depth: 0,
        recordSubagentSpawned: async ({ childRunId, role, parentCallId: callId }) => {
          await parentRecorder.record({
            type: "subagent_spawned",
            v: 1,
            childRunId,
            role,
            parentCallId: callId,
          });
        },
      };
      spawnResult = await childTool.execute(
        {
          callId: parentCallId,
          toolId: Code.parse("agent.spawn"),
          args: { role: "worker", goal: "inspect this" },
        },
        context,
      );
      const events = await readEvents(store, parentRunId);
      const last = events.at(-1);
      if (last === undefined) {
        throw new Error("Expected a durable spawn announcement.");
      }
      return last;
    });

    const childId = (await readEvents(store, parentRunId)).find(
      (event) => event.type === "subagent_spawned",
    );
    if (childId?.type !== "subagent_spawned") {
      throw new Error("Expected a child run id.");
    }
    const childEvents = await readEvents(store, childId.childRunId);

    expect(spawnResult).toMatchObject({
      outcome: "ok",
      result: { status: "completed", text: "child answer" },
    });
    expect(childEvents[0]).toMatchObject({
      type: "run_created",
      parentRunId,
      parentCallId,
      scopeId: parentRunId,
      depth: 1,
    });
    expect(childEvents.find((event) => event.type === "run_input")).toMatchObject({
      input: { goal: "inspect this" },
    });
    expect(modelRequests[0]?.role).toBe("worker_route");
    expect(modelRequests[0]?.messages[0]).toEqual({
      role: "system",
      parts: [{ type: "text", text: "Follow the task." }],
    });
    expect(modelRequests[0]?.tools?.map(({ toolId }) => toolId)).toEqual(["test.read"]);
  });
});
