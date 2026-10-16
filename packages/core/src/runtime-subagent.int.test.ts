// SPDX-License-Identifier: Apache-2.0
import {
  Code,
  FakeClock,
  Id,
  KeysConfigSchema,
  ModelsConfigSchema,
  PiiConfigSchema,
  RunConfigSchema,
  SequentialIdGenerator,
  type Detection,
  type Event,
  type Id as IdValue,
} from "@harness/schemas";
import type { SandboxBackend } from "@harness/sandbox";
import type { ModelPort, ModelRequest, ModelCompletion, ToolPort } from "./ports.js";
import { InMemoryEventStore, type EventStore } from "@harness/store";
import { InMemoryVault, AuditingVaultResolver, Token } from "@harness/vault";
import { PiiToolPort, Tokenizer } from "@harness/pii";
import { describe, expect, it, vi } from "vitest";
import { createRuntime } from "./runtime.js";
import type { RuntimeConfig } from "./runtime-config.js";
import { allowAllPolicy } from "./testing/allow-policy.js";
import { RunScopeRegistry } from "./subagent/scope.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const email = "alice@example.test";
const rootRunId = Id.parse("00000000000000000000000000");
const childRunId = Id.parse("11111111111111111111111111");
const childCallId = Id.parse("22222222222222222222222222");
const makeCallId = Id.parse("33333333333333333333333333");
const spawnCallId = Id.parse("44444444444444444444444444");
const resolveCallId = Id.parse("55555555555555555555555555");
const hash = "a".repeat(64);

function completion(
  parts: ModelCompletion["parts"],
  usage: ModelCompletion["usage"] = { inputTokens: 1, outputTokens: 1 },
): ModelCompletion {
  return {
    parts,
    usage,
    finishReason: parts.some((part) => part.type === "tool_call") ? "tool_calls" : "stop",
    provider: "fake",
    model: "fake",
    latencyMs: 0,
    schemaValid: true,
    repairAttempts: 0,
    fallbackDepth: 0,
    providerBlobs: null,
  };
}

function detector(): { detect(text: string): readonly Detection[] } {
  return {
    detect: (text) => {
      const start = text.indexOf(email);
      return start < 0
        ? []
        : [
            {
              entityType: "email",
              start,
              end: start + email.length,
              confidence: 1,
              detectorId: "test.email",
            },
          ];
    },
  };
}

function piiTool(
  scopes: RunScopeRegistry,
  vault: InMemoryVault,
  resolvedValues: string[],
  sandboxBackend?: SandboxBackend,
): ToolPort {
  const config = PiiConfigSchema.parse({
    defaultAction: "tokenize",
    detokenize: [{ toolId: "test.resolve", args: ["/token"] }],
  });
  const tools: ToolPort = {
    describe: (toolId) =>
      toolId === "test.make" || toolId === "test.resolve"
        ? { idempotent: true, timeoutMs: 10_000 }
        : undefined,
    getToolSpecs: () => [
      {
        toolId: "test.make",
        description: "Create a synthetic token",
        inputSchema: { type: "object" },
      },
      {
        toolId: "test.resolve",
        description: "Resolve a synthetic token",
        inputSchema: { type: "object" },
      },
    ],
    execute: async (call, context) => {
      await sandboxBackend?.exec(
        context.runId,
        {
          argv: ["/bin/true"],
          timeoutMs: 1000,
          limits: { memoryMb: 32, pids: 2, outputBytes: 0, cpuSeconds: 1 },
        },
        context.signal,
      );
      if (call.toolId === "test.make") {
        return { outcome: "ok", result: { value: email } };
      }
      const token =
        call.args !== null && typeof call.args === "object" && !Array.isArray(call.args)
          ? call.args.token
          : undefined;
      if (typeof token !== "string") {
        return {
          outcome: "error",
          errorCode: "test_token_missing",
          result: null,
        };
      }
      resolvedValues.push(token);
      return { outcome: "ok", result: { value: token } };
    },
  };
  return new PiiToolPort(tools, {
    tokenizer: new Tokenizer({
      detectors: detector(),
      policy: config,
      vault,
      scopeOf: scopes.scopeOf,
    }),
    config,
    resolver: new AuditingVaultResolver(vault, () => undefined, scopes.scopeOf),
  });
}

function leaseAwareSandbox(runIds: IdValue[]): SandboxBackend {
  let owner: IdValue | undefined;
  return {
    acquireLease: (runId) => {
      if (owner !== undefined && owner !== runId) {
        return Promise.reject(new Error("synthetic lease conflict"));
      }
      owner = runId;
      return Promise.resolve();
    },
    releaseLease: (runId) => {
      if (owner === runId) {
        owner = undefined;
      }
      return Promise.resolve();
    },
    exec: (runId) => {
      if (owner !== undefined && owner !== runId) {
        return Promise.reject(new Error("synthetic lease conflict"));
      }
      const temporary = owner === undefined;
      owner = runId;
      runIds.push(runId);
      if (temporary) {
        owner = undefined;
      }
      return Promise.resolve({
        exitCode: 0,
        stdout: "",
        stderr: "",
        stdoutBytes: 0,
        stderrBytes: 0,
        truncated: false,
        timedOut: false,
        durationMs: 0,
      });
    },
  };
}

function runtimePiiTool(resolvedValues: string[]): ToolPort {
  return {
    describe: (toolId) =>
      toolId === "test.make" || toolId === "test.resolve"
        ? { idempotent: true, timeoutMs: 10_000 }
        : undefined,
    getToolSpecs: () => [
      {
        toolId: "test.make",
        description: "Create a synthetic token",
        inputSchema: { type: "object" },
      },
      {
        toolId: "test.resolve",
        description: "Resolve a synthetic token",
        inputSchema: { type: "object" },
      },
    ],
    execute: (call) => {
      if (call.toolId === "test.make") {
        return Promise.resolve({ outcome: "ok", result: { value: email } });
      }
      const token =
        call.args !== null && typeof call.args === "object" && !Array.isArray(call.args)
          ? call.args.token
          : undefined;
      if (typeof token !== "string") {
        return Promise.resolve({
          outcome: "error",
          errorCode: "test_token_missing",
          result: null,
        });
      }
      resolvedValues.push(token);
      return Promise.resolve({ outcome: "ok", result: { value: token } });
    },
  };
}

class SpawnModel implements ModelPort {
  readonly requests: ModelRequest[] = [];
  private parentCall = 0;
  private childCall = 0;

  complete(request: ModelRequest): Promise<ModelCompletion> {
    this.requests.push(request);
    if (request.role === "worker") {
      this.childCall += 1;
      return Promise.resolve(
        this.childCall === 1
          ? completion([
              {
                type: "tool_call",
                callId: resolveCallId,
                toolId: Code.parse("test.resolve"),
                args: { token: "<EMAIL_1>" },
              },
            ])
          : completion([{ type: "text", text: "child answer" }]),
      );
    }
    this.parentCall += 1;
    switch (this.parentCall) {
      case 1:
        return Promise.resolve(
          completion([
            {
              type: "tool_call",
              callId: makeCallId,
              toolId: Code.parse("test.make"),
              args: {},
            },
          ]),
        );
      case 2:
        return Promise.resolve(
          completion([
            {
              type: "tool_call",
              callId: spawnCallId,
              toolId: Code.parse("agent.spawn"),
              args: {
                role: "worker",
                goal: "inspect the shared token",
                inputs: { token: "<EMAIL_1>" },
              },
            },
          ]),
        );
      default:
        return Promise.resolve(completion([{ type: "text", text: "parent answer" }]));
    }
  }
}

class TwoChildBudgetModel implements ModelPort {
  private parentCalls = 0;
  private childCalls = 0;

  complete(request: ModelRequest): Promise<ModelCompletion> {
    if (request.role === "worker") {
      this.childCalls += 1;
      return Promise.resolve(
        completion([{ type: "text", text: "child answer" }], {
          inputTokens: 1,
          outputTokens: 1,
          costMicros: this.childCalls === 1 ? 6 : 4,
        }),
      );
    }
    this.parentCalls += 1;
    if (this.parentCalls <= 2) {
      const callId = this.parentCalls === 1 ? childCallId : makeCallId;
      return Promise.resolve(
        completion([
          {
            type: "tool_call",
            callId,
            toolId: Code.parse("agent.spawn"),
            args: { role: "worker", goal: `child ${String(this.parentCalls)}` },
          },
        ]),
      );
    }
    return Promise.resolve(completion([{ type: "text", text: "parent answer" }]));
  }
}

async function eventsFor(store: EventStore, runId: Id): Promise<Event[]> {
  const events: Event[] = [];
  for await (const event of store.read(runId)) {
    events.push(event);
  }
  return events;
}

describe("runtime subagent spawning", () => {
  it("caps total parent and child step and cost usage over two children", async () => {
    const store = new InMemoryEventStore();
    const runtime = await createRuntime(
      {
        run: RunConfigSchema.parse({
          budgets: { maxSteps: 10, maxCostUsd: 0.00001 },
        }),
        models: ModelsConfigSchema.parse({
          routing: {
            default: [{ provider: "local", model: "parent" }],
            roles: { worker: [{ provider: "local", model: "worker" }] },
          },
        }),
        roles: [{ id: "worker", route: "worker", tools: [], maxDepth: 2, maxChildren: 2 }],
      },
      {
        store,
        transientVault: true,
        clock: new FakeClock(4),
        ids: new SequentialIdGenerator(),
        model: new TwoChildBudgetModel(),
        tool: {
          describe: () => undefined,
          execute: () =>
            Promise.resolve({ outcome: "error", errorCode: "unknown_tool", result: null }),
        },
        policy: allowAllPolicy,
      },
    );
    try {
      const parent = await runtime.run("start");
      const completions = parent.events.filter((event) => event.type === "subagent_completed");

      expect(parent.status).toBe("completed");
      expect(parent.state.steps).toBe(5);
      expect(parent.state.usage.costMicros).toBe(10);
      expect(completions).toMatchObject([
        { outcome: "completed", steps: 1, costMicros: 6 },
        { outcome: "completed", steps: 1, costMicros: 4 },
      ]);
    } finally {
      await runtime.close();
    }
  });

  it("runs a production child after the durable announcement with tokenized input and shared scope", async () => {
    const store = new InMemoryEventStore();
    const appendOrder: { readonly runId: Id; readonly types: readonly string[] }[] = [];
    const append = store.append.bind(store);
    vi.spyOn(store, "append").mockImplementation((runId, events, expectedSeq) => {
      appendOrder.push({ runId, types: events.map(({ type }) => type) });
      return append(runId, events, expectedSeq);
    });
    const scopes = new RunScopeRegistry();
    const vault = new InMemoryVault();
    const resolvedValues: string[] = [];
    const model = new SpawnModel();
    const sandboxRunIds: IdValue[] = [];
    const sandboxBackend = leaseAwareSandbox(sandboxRunIds);
    const runtime = await createRuntime(
      {
        run: RunConfigSchema.parse({}),
        pii: PiiConfigSchema.parse({ enabled: false }),
        models: ModelsConfigSchema.parse({
          routing: {
            default: [{ provider: "local", model: "parent" }],
            roles: { worker: [{ provider: "local", model: "worker" }] },
          },
        }),
        roles: [
          {
            id: "worker",
            route: "worker",
            systemPrompt: "Work carefully.",
            tools: ["test.resolve"],
            contextStrategy: "naive",
            maxDepth: 2,
            maxChildren: 2,
          },
        ],
      },
      {
        store,
        transientVault: true,
        clock: new FakeClock(4),
        ids: new SequentialIdGenerator(),
        model,
        tool: piiTool(scopes, vault, resolvedValues, sandboxBackend),
        sandboxBackend,
        scopeRegistry: scopes,
        policy: allowAllPolicy,
      },
    );
    try {
      const parent = await runtime.run("start");
      const parentId = parent.events[0]?.runId;
      const spawned = parent.events.find((event) => event.type === "subagent_spawned");
      if (parentId === undefined || spawned?.type !== "subagent_spawned") {
        throw new Error("Expected the parent run to spawn a child.");
      }
      const childEvents = await eventsFor(store, spawned.childRunId);
      const childCreated = childEvents[0];
      const childInput = childEvents.find((event) => event.type === "run_input");
      const spawnAppendIndex = appendOrder.findIndex(({ types }) =>
        types.includes("subagent_spawned"),
      );
      const childAppendIndex = appendOrder.findIndex(
        ({ runId, types }) => runId === spawned.childRunId && types.includes("run_created"),
      );
      const childRequest = model.requests.find(({ role }) => role === "worker");

      expect(parent.status).toBe("completed");
      expect(childCreated).toMatchObject({
        type: "run_created",
        parentRunId: parentId,
        parentCallId: spawnCallId,
        scopeId: parentId,
        depth: 1,
      });
      expect(childInput).toMatchObject({
        type: "run_input",
        input: { goal: "inspect the shared token", inputs: { token: "<EMAIL_1>" } },
      });
      expect(spawnAppendIndex).toBeGreaterThanOrEqual(0);
      expect(childAppendIndex).toBeGreaterThan(spawnAppendIndex);
      expect(resolvedValues).toEqual([email]);
      expect(sandboxRunIds).toHaveLength(2);
      expect(new Set(sandboxRunIds).size).toBe(2);
      expect(childRequest?.messages[0]).toEqual({
        role: "system",
        parts: [{ type: "text", text: "Work carefully." }],
      });
      expect(
        parent.events.find(
          (event) => event.type === "tool_result" && event.toolId === "agent.spawn",
        ),
      ).toMatchObject({
        outcome: "ok",
        result: {
          childRunId: spawned.childRunId,
          status: "completed",
          value: { text: "child answer" },
          usage: { inputTokens: 2, outputTokens: 2 },
        },
      });
      expect(parent.events.find((event) => event.type === "subagent_completed")).toMatchObject({
        outcome: "completed",
        inputTokens: 2,
        outputTokens: 2,
      });
    } finally {
      await runtime.close();
    }
  });

  it("restores a durable child scope before resumed tool execution", async () => {
    const store = new InMemoryEventStore();
    const scopes = new RunScopeRegistry();
    const vault = new InMemoryVault();
    const token = await vault.put(rootRunId, Code.parse("email"), email);
    const resolvedValues: string[] = [];
    const recorderEvents = [
      {
        runId: childRunId,
        ts: 1,
        traceId: "a".repeat(32),
        spanId: "b".repeat(16),
        segmentId: Id.parse("66666666666666666666666666"),
        type: "run_created" as const,
        v: 1,
        configHash: hash,
        policyVersion: Code.parse("test"),
        parentRunId: rootRunId,
        parentCallId: childCallId,
        scopeId: rootRunId,
        depth: 1,
      },
      {
        runId: childRunId,
        ts: 2,
        traceId: "a".repeat(32),
        spanId: "b".repeat(16),
        segmentId: Id.parse("66666666666666666666666666"),
        type: "run_input" as const,
        v: 1,
        input: { goal: "resume child", inputs: { token } },
        inputKind: "initial" as const,
      },
      {
        runId: childRunId,
        ts: 3,
        traceId: "a".repeat(32),
        spanId: "b".repeat(16),
        segmentId: Id.parse("66666666666666666666666666"),
        type: "run_status_changed" as const,
        v: 1,
        from: "pending" as const,
        to: "running" as const,
        reason: Code.parse("start"),
      },
    ];
    await store.append(childRunId, recorderEvents, 0);
    const model: ModelPort = {
      complete: (request) =>
        Promise.resolve(
          request.messages.some((message) =>
            message.parts.some((part) => part.type === "tool_result"),
          )
            ? completion([{ type: "text", text: "resumed answer" }])
            : completion([
                {
                  type: "tool_call",
                  callId: resolveCallId,
                  toolId: Code.parse("test.resolve"),
                  args: { token },
                },
              ]),
        ),
    };
    const runtime = await createRuntime(
      { run: RunConfigSchema.parse({}), pii: PiiConfigSchema.parse({ enabled: false }) },
      {
        store,
        transientVault: true,
        clock: new FakeClock(4),
        ids: new SequentialIdGenerator(),
        model,
        tool: piiTool(scopes, vault, resolvedValues),
        scopeRegistry: scopes,
        policy: allowAllPolicy,
      },
    );
    try {
      const resumed = await runtime.resume(childRunId);

      expect(resumed.status).toBe("completed");
      expect(scopes.scopeOf(childRunId)).toBe(rootRunId);
      expect(resolvedValues).toEqual([email]);
    } finally {
      await runtime.close();
    }
  });

  it("resolves a persisted child-run token through runtime.vault after reopening", async () => {
    const directory = await mkdtemp(join(tmpdir(), "harness-runtime-child-vault-"));
    const secretResolver = {
      resolve: () => Promise.resolve({ reveal: () => Buffer.alloc(32, 19).toString("base64") }),
    };
    const config: RuntimeConfig = {
      run: RunConfigSchema.parse({}),
      keys: KeysConfigSchema.parse({
        currentKeyId: "runtime-test",
        keys: [{ id: "runtime-test", secret: "env:RUNTIME_TEST_KEY" }],
      }),
      pii: PiiConfigSchema.parse({
        detokenize: [{ toolId: "test.resolve", args: ["/token"] }],
      }),
      models: ModelsConfigSchema.parse({
        routing: {
          default: [{ provider: "local", model: "parent" }],
          roles: { worker: [{ provider: "local", model: "worker" }] },
        },
      }),
      roles: [
        {
          id: "worker",
          route: "worker",
          systemPrompt: "Work carefully.",
          tools: ["test.resolve"],
          contextStrategy: "naive",
          maxDepth: 2,
          maxChildren: 2,
        },
      ],
    };
    const resolvedValues: string[] = [];
    const runtime = await createRuntime(config, {
      dataDir: directory,
      clock: new FakeClock(4),
      ids: new SequentialIdGenerator(),
      model: new SpawnModel(),
      tool: runtimePiiTool(resolvedValues),
      policy: allowAllPolicy,
      secretResolver,
    });
    let reopened: Awaited<ReturnType<typeof createRuntime>> | undefined;
    let runtimeClosed = false;
    try {
      const parent = await runtime.run("start");
      const parentId = parent.events[0]?.runId;
      const spawned = parent.events.find((event) => event.type === "subagent_spawned");
      if (parentId === undefined || spawned?.type !== "subagent_spawned") {
        throw new Error("Expected the parent run to spawn a child.");
      }
      const childCreated = await eventsFor(runtime.store, spawned.childRunId);
      expect(childCreated[0]).toMatchObject({
        type: "run_created",
        parentRunId: parentId,
        scopeId: parentId,
      });
      expect(resolvedValues).toEqual([email]);
      await runtime.close();
      runtimeClosed = true;

      reopened = await createRuntime(config, {
        dataDir: directory,
        model: new SpawnModel(),
        secretResolver,
      });
      await expect(
        reopened.vault.resolve(spawned.childRunId, Token.parse("<EMAIL_1>"), {
          boundary: "ui",
        }),
      ).resolves.toBe(email);
    } finally {
      if (reopened !== undefined) {
        await reopened.close();
      } else if (!runtimeClosed) {
        await runtime.close();
      }
      await rm(directory, { recursive: true, force: true });
    }
  });
});
