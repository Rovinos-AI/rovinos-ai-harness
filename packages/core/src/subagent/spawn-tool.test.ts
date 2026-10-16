// SPDX-License-Identifier: Apache-2.0
import { Code, Id, ModelsConfigSchema, type JsonValue, type ToolSpec } from "@harness/schemas";
import { InMemoryEventStore } from "@harness/store";
import { describe, expect, it, vi } from "vitest";
import { RoleRegistry } from "../roles.js";
import type { ModelToolCall, RunContext, ToolPort } from "../ports.js";
import { AgentSpawnInputSchema, AgentSpawnTool } from "./spawn-tool.js";
import { SubagentSupervisor } from "./supervisor.js";
import type { SubagentRunRequest } from "./supervisor.js";
import { RunScopeRegistry } from "./scope.js";

const parentRunId = Id.parse("00000000000000000000000000");
const parentCallId = Id.parse("11111111111111111111111111");
const childRunId = Id.parse("22222222222222222222222222");

async function roles(): Promise<RoleRegistry> {
  return RoleRegistry.create({
    roles: [{ id: "worker", tools: ["fs.read"], maxDepth: 2, maxChildren: 2 }],
    models: ModelsConfigSchema.parse({
      routing: {
        default: [{ provider: "local", model: "model" }],
        roles: { worker: [{ provider: "local", model: "model" }] },
      },
    }),
    registeredTools: ["agent.spawn", "fs.read", "fs.write"],
    contextStrategies: new Set(["naive"]),
    configDirectory: process.cwd(),
  });
}

function call(toolId: string, args: JsonValue): ModelToolCall {
  return { callId: parentCallId, toolId: Code.parse(toolId), args };
}

function innerTools(): ToolPort {
  return {
    describe: (toolId) =>
      toolId === "fs.read" || toolId === "fs.write"
        ? { idempotent: true, timeoutMs: 1_000 }
        : undefined,
    getToolSpecs: () =>
      [
        { toolId: "agent.spawn", description: "duplicate", inputSchema: {} },
        { toolId: "fs.read", description: "read", inputSchema: {} },
        { toolId: "fs.write", description: "write", inputSchema: {} },
      ] satisfies ToolSpec[],
    prepare: vi.fn((toolCall) => Promise.resolve(toolCall)),
    execute: vi.fn(() => Promise.resolve({ outcome: "ok" as const, result: { ok: true } })),
  };
}

function runContext(tools: ToolPort): RunContext {
  return {
    runId: parentRunId,
    signal: new AbortController().signal,
    toolRegistry: tools,
    depth: 0,
    recordSubagentSpawned: vi.fn(() => Promise.resolve()),
    recordSubagentCompleted: vi.fn(() => Promise.resolve()),
  };
}

function createSpawnTool(
  inner: ToolPort,
  registry: RoleRegistry,
  onChild: (request: SubagentRunRequest) => void = () => undefined,
): AgentSpawnTool {
  const supervisor = new SubagentSupervisor({
    store: new InMemoryEventStore(),
    ids: { next: () => childRunId },
    scopes: new RunScopeRegistry(),
    parentTools: inner,
    parentSpanContext: () => ({
      traceId: "a".repeat(32),
      spanId: "b".repeat(16),
      traceFlags: 1,
    }),
    runChild: (request) => {
      onChild(request);
      return Promise.resolve({
        childRunId: request.runId,
        status: "completed",
        value: { input: request.input },
        usage: { inputTokens: 0, outputTokens: 0 },
      });
    },
  });
  return new AgentSpawnTool(inner, registry, supervisor);
}

describe("agent.spawn tool", () => {
  it("validates the strict role, goal, and optional JSON input schema", () => {
    expect(
      AgentSpawnInputSchema.safeParse({
        role: "worker",
        goal: "A".repeat(8_000),
        inputs: { token: "<EMAIL_1>" },
      }).success,
    ).toBe(true);
    expect(
      AgentSpawnInputSchema.safeParse({ role: "worker", goal: "A".repeat(8_001) }).success,
    ).toBe(false);
    expect(
      AgentSpawnInputSchema.safeParse({ role: "worker", goal: "goal", extra: true }).success,
    ).toBe(false);
  });

  it("advertises a non-idempotent built-in and preserves other tool behavior", async () => {
    const inner = innerTools();
    const prepare = vi.spyOn(inner, "prepare");
    const tool = createSpawnTool(inner, await roles());
    const spawnCall = call("agent.spawn", { role: "worker", goal: "goal" });

    expect(tool.describe("agent.spawn")).toMatchObject({
      idempotent: false,
      timeoutMs: 300_000,
      longRunning: true,
    });
    expect(tool.describe("agent.spawn")?.inputSchema).toEqual(
      tool.getToolSpecs().find(({ toolId }) => toolId === "agent.spawn")?.inputSchema,
    );
    expect(tool.describe("fs.read")).toEqual({ idempotent: true, timeoutMs: 1_000 });
    expect(tool.getToolSpecs().map(({ toolId }) => toolId)).toEqual([
      "fs.read",
      "fs.write",
      "agent.spawn",
    ]);
    const context = runContext(inner);
    await expect(tool.prepare(spawnCall, context)).resolves.toBe(spawnCall);
    expect(prepare).toHaveBeenCalledWith(spawnCall, context);
    await expect(tool.prepare(call("fs.read", {}), runContext(inner))).resolves.toEqual(
      call("fs.read", {}),
    );
    await expect(tool.execute(call("fs.read", {}), runContext(inner))).resolves.toEqual({
      outcome: "ok",
      result: { ok: true },
    });
  });

  it("returns a schema failure without starting a child", async () => {
    const runChild = vi.fn();
    const tool = createSpawnTool(innerTools(), await roles(), runChild);

    await expect(
      tool.execute(call("agent.spawn", { role: "worker", goal: 3 }), runContext(innerTools())),
    ).resolves.toEqual({ outcome: "error", errorCode: "agent_spawn_invalid", result: null });
    expect(runChild).not.toHaveBeenCalled();
  });

  it("awaits a child with role-filtered tools and returns its JSON result", async () => {
    const inner = innerTools();
    const seen: SubagentRunRequest[] = [];
    const tool = createSpawnTool(inner, await roles(), (request) => seen.push(request));
    const context = runContext(tool);

    await expect(
      tool.execute(
        call("agent.spawn", {
          role: "worker",
          goal: "tokenized goal",
          inputs: { ref: "<EMAIL_1>" },
        }),
        context,
      ),
    ).resolves.toEqual({
      outcome: "ok",
      result: {
        childRunId,
        status: "completed",
        value: { input: { goal: "tokenized goal", inputs: { ref: "<EMAIL_1>" } } },
        usage: { inputTokens: 0, outputTokens: 0 },
      },
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.role.id).toBe("worker");
    expect(seen[0]?.tools.describe("fs.read")).toBeDefined();
    expect(seen[0]?.tools.describe("fs.write")).toBeUndefined();
  });

  it("does not handle calls for another tool ID", async () => {
    const inner = innerTools();
    const tool = createSpawnTool(inner, await roles());

    await expect(tool.execute(call("fs.read", {}), runContext(inner))).resolves.toMatchObject({
      result: { ok: true },
    });
  });
});
