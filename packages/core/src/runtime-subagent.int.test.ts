// SPDX-License-Identifier: Apache-2.0
import {
  Code,
  FakeClock,
  Id,
  ModelsConfigSchema,
  PiiConfigSchema,
  RunConfigSchema,
  SequentialIdGenerator,
  type Detection,
  type Event,
} from "@harness/schemas";
import type { ModelPort, ModelRequest, ModelCompletion, ToolPort } from "./ports.js";
import { InMemoryEventStore } from "@harness/store";
import { InMemoryVault, AuditingVaultResolver } from "@harness/vault";
import { PiiToolPort, Tokenizer } from "@harness/pii";
import { describe, expect, it, vi } from "vitest";
import { createRuntime } from "./runtime.js";
import { allowAllPolicy } from "./testing/allow-policy.js";
import { RunScopeRegistry } from "./subagent/scope.js";

const email = "alice@example.test";
const rootRunId = Id.parse("00000000000000000000000000");
const childRunId = Id.parse("11111111111111111111111111");
const childCallId = Id.parse("22222222222222222222222222");
const makeCallId = Id.parse("33333333333333333333333333");
const spawnCallId = Id.parse("44444444444444444444444444");
const resolveCallId = Id.parse("55555555555555555555555555");
const hash = "a".repeat(64);

function completion(parts: ModelCompletion["parts"]): ModelCompletion {
  return {
    parts,
    usage: { inputTokens: 1, outputTokens: 1 },
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

async function eventsFor(store: InMemoryEventStore, runId: Id): Promise<Event[]> {
  const events: Event[] = [];
  for await (const event of store.read(runId)) {
    events.push(event);
  }
  return events;
}

describe("runtime subagent spawning", () => {
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
    const runtime = await createRuntime(
      {
        run: RunConfigSchema.parse({}),
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
        clock: new FakeClock(4),
        ids: new SequentialIdGenerator(),
        model,
        tool: piiTool(scopes, vault, resolvedValues),
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
        result: { status: "completed", text: "child answer" },
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
      { run: RunConfigSchema.parse({}) },
      {
        store,
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
});
