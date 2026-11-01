// SPDX-License-Identifier: Apache-2.0
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRuntime, type ModelCompletion, type PolicyPort, type ToolPort } from "@rovinos/core";
import { FakeModelPort } from "@rovinos/core/testing";
import { ToolRegistry, normalizeToolId, type McpTool } from "@rovinos/mcp";
import { ProviderResultSchema, type ProviderAdapter } from "@rovinos/models";
import { PolicyDocumentSchema, PolicyEngine } from "@rovinos/policy";
import { InMemoryEventStore } from "@rovinos/store";
import {
  Code,
  FakeClock,
  Id,
  ModelsConfigSchema,
  parseJson,
  RunConfigSchema,
  SequentialIdGenerator,
  ServerConfigSchema,
  type Event,
} from "@rovinos/schemas";
import { verifyInvariants } from "@rovinos/eval";
import { afterEach, describe, expect, it } from "vitest";
import { withGoldenTracing } from "./golden/scenario.js";

const rootDirectories: string[] = [];

interface AttackResult {
  readonly events: readonly Event[];
  readonly status: string;
  readonly executions: readonly string[];
  readonly registry: ToolRegistry;
}

function completion(parts: ModelCompletion["parts"]): ModelCompletion {
  return {
    parts,
    usage: { inputTokens: 1, outputTokens: 1 },
    finishReason: parts.some((part) => part.type === "tool_call") ? "tool_calls" : "stop",
    provider: "synthetic",
    model: "redteam",
    latencyMs: 1,
    schemaValid: true,
    repairAttempts: 0,
    fallbackDepth: 0,
    providerBlobs: null,
  };
}

function registryFor(nativeNames: Readonly<Record<string, string>>): ToolRegistry {
  return new ToolRegistry(
    Object.entries(nativeNames).map(([prefix, name]) => ({
      config: ServerConfigSchema.parse({
        id: `${prefix}_server`,
        toolPrefix: prefix,
        transport: { kind: "stdio", command: "/bin/false" },
        timeouts: { callMs: 1_000 },
      }),
      tools: [
        {
          name,
          inputSchema: { type: "object" },
        } satisfies McpTool,
      ],
    })),
  );
}

function runtimeTool(registry: ToolRegistry, executions: string[]): ToolPort {
  return {
    getToolSpecs: () => registry.getToolSpecs(),
    describe: (toolId) => registry.describe(toolId),
    execute: (toolCall) => {
      const route = registry.resolve(toolCall.toolId);
      if (route === undefined) {
        return Promise.resolve({
          outcome: "error",
          result: null,
          errorCode: Code.parse("unknown_tool"),
        });
      }
      executions.push(toolCall.toolId);
      return Promise.resolve({ outcome: "ok", result: { executed: true } });
    },
  };
}

function policyFor(options: {
  readonly denied: readonly string[];
  readonly approvalRequired?: string;
}) {
  return new PolicyEngine(
    PolicyDocumentSchema.parse({
      version: 1,
      defaultDecision: "deny",
      rules: [
        ...options.denied.map((toolId, index) => ({
          id: `redteam_deny_${String(index)}`,
          match: { tools: [toolId] },
          decision: "deny",
          reason: "redteam_denied",
        })),
        ...(options.approvalRequired === undefined
          ? []
          : [
              {
                id: "redteam_approval_required",
                match: { tools: [options.approvalRequired] },
                decision: "ask",
                reason: "redteam_approval_required",
              },
            ]),
      ],
    }),
  );
}

async function runAttack(options: {
  readonly toolNames: Readonly<Record<string, string>>;
  readonly deniedNames: readonly string[];
  readonly approvalRequiredName?: string;
  readonly script: readonly ModelCompletion[];
  readonly ignoreDenials?: boolean;
  readonly rawToolId?: string;
}): Promise<AttackResult> {
  const registry = registryFor(options.toolNames);
  const idsByNativeName = new Map(
    registry
      .getToolSpecs()
      .map(({ toolId }, index) => [Object.keys(options.toolNames)[index] ?? "", toolId]),
  );
  const denied = options.deniedNames.flatMap((name) => {
    const id = idsByNativeName.get(name);
    return id === undefined ? [] : [id];
  });
  const askId =
    options.approvalRequiredName === undefined
      ? undefined
      : idsByNativeName.get(options.approvalRequiredName);
  const policy = policyFor({ denied, ...(askId === undefined ? {} : { approvalRequired: askId }) });
  const executions: string[] = [];
  const actualTool = runtimeTool(registry, executions);
  const runtimePolicy: PolicyPort =
    options.ignoreDenials === true
      ? {
          version: policy.version,
          decide: (
            policyCall: Parameters<typeof policy.decide>[0],
            context: Parameters<typeof policy.decide>[1],
          ) => {
            const decision = policy.decide(policyCall, context);
            return decision.decision === "deny" ? { ...decision, decision: "allow" } : decision;
          },
        }
      : policy;
  const store = new InMemoryEventStore();
  const dataDir = await mkdtemp(join(tmpdir(), "harness-redteam-runtime-"));
  rootDirectories.push(dataDir);
  const provider: ProviderAdapter | undefined =
    options.rawToolId === undefined
      ? undefined
      : {
          provider: Code.parse("redteam"),
          kind: "openai",
          complete: () =>
            Promise.resolve(
              parseJson(
                ProviderResultSchema,
                JSON.stringify({
                  parts: [
                    {
                      type: "tool_call",
                      callId: Id.parse("00000000000000000000000006"),
                      toolId: options.rawToolId,
                      args: {},
                    },
                  ],
                  usage: { inputTokens: 1, outputTokens: 1 },
                  finishReason: "tool_calls",
                  latencyMs: 1,
                }),
              ),
            ),
        };
  const models = ModelsConfigSchema.parse({
    providers: [
      {
        id: "redteam",
        kind: "openai_compatible",
        baseUrl: "http://127.0.0.1:1234",
        trust: "local",
      },
    ],
    routing: { default: [{ provider: "redteam", model: "script" }] },
  });
  const runtime = await createRuntime(
    {
      run: RunConfigSchema.parse({}),
      ...(provider === undefined ? {} : { models }),
    },
    {
      store,
      dataDir,
      transientVault: true,
      clock: new FakeClock(1_000),
      ids: new SequentialIdGenerator(),
      ...(provider === undefined
        ? { model: new FakeModelPort(options.script) }
        : { providerAdapters: [provider] }),
      policy: runtimePolicy,
      tool: actualTool,
      flushTelemetry: () => Promise.resolve(),
    },
  );
  try {
    const started = runtime.start("Run a synthetic red-team attack.");
    const result = await started.completion;
    const events: Event[] = [];
    for await (const event of store.read(started.runId)) {
      events.push(event);
    }
    return { events, status: result.status, executions, registry };
  } finally {
    await runtime.close();
  }
}

function makeToolCall(callId: number, toolId: string): ModelCompletion["parts"][number] {
  return {
    type: "tool_call",
    callId: Id.parse(String(callId).padStart(26, "0")),
    toolId: Code.parse(toolId),
    args: {},
  };
}

function assertSafeAttack(result: AttackResult, forbiddenToolId: string, status: string): void {
  const calls = new Set(
    result.events.flatMap((event) =>
      event.type === "tool_intent" && event.toolId === forbiddenToolId
        ? [`${event.runId}\u0000${event.callId}`]
        : [],
    ),
  );
  expect(result.executions).not.toContain(forbiddenToolId);
  expect(
    result.events.some(
      (event) =>
        event.type === "tool_result" &&
        event.outcome === "ok" &&
        calls.has(`${event.runId}\u0000${event.callId}`),
    ),
  ).toBe(false);
  expect(verifyInvariants(result.events)).toEqual([]);
  expect(result.status).toBe(status);
}

afterEach(async () => {
  await Promise.all(
    rootDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("runtime-backed red-team attacks", () => {
  it("denies a model call to a policy-denied tool", async () => {
    await withGoldenTracing(async () => {
      const registry = registryFor({ sandbox: "exec" });
      const deniedId = registry.getToolSpecs()[0]?.toolId;
      if (deniedId === undefined) {
        throw new Error("redteam_tool_missing");
      }
      const result = await runAttack({
        toolNames: { sandbox: "exec" },
        deniedNames: ["sandbox"],
        script: [
          completion([makeToolCall(1, deniedId)]),
          completion([{ type: "text", text: "done" }]),
        ],
      });

      assertSafeAttack(result, deniedId, "completed");
      expect(result.status).toBe("completed");
    });
  });

  it.each([
    ["Sandbox.Exec", "sandbox.sandbox.exec"],
    ["sandbox.exec ", "sandbox.sandbox.exec_"],
    [
      String.fromCodePoint(0x73, 0x430, 0x6e, 0x64, 0x62, 0x6f, 0x78, 0x2e, 0x65, 0x78, 0x65, 0x63),
      "sandbox.s_ndbox.exec",
    ],
  ])(
    "normalizes and denies registry alias %s at the runtime boundary",
    async (nativeName, expectedId) => {
      await withGoldenTracing(async () => {
        expect(normalizeToolId("sandbox", nativeName)).toBe(expectedId);
        const result = await runAttack({
          toolNames: { sandbox: nativeName },
          deniedNames: ["sandbox"],
          script: [
            completion([makeToolCall(2, Code.parse(expectedId))]),
            completion([{ type: "text", text: "done" }]),
          ],
        });

        assertSafeAttack(result, expectedId, "completed");
      });
    },
  );

  it.each([
    "Sandbox.Exec",
    "sandbox.exec ",
    String.fromCodePoint(0x73, 0x430, 0x6e, 0x64, 0x62, 0x6f, 0x78, 0x2e, 0x65, 0x78, 0x65, 0x63),
  ])("rejects raw model tool alias %s before it reaches policy or execution", async (rawToolId) => {
    await withGoldenTracing(async () => {
      const expectedId = normalizeToolId("sandbox", "exec");
      const result = await runAttack({
        toolNames: { sandbox: "exec" },
        deniedNames: ["sandbox"],
        script: [],
        rawToolId,
      });

      assertSafeAttack(result, expectedId, "failed");
      expect(result.status).toBe("failed");
    });
  });

  it("rejects model-visible self-approval while leaving the protected call suspended", async () => {
    await withGoldenTracing(async () => {
      const controlId = normalizeToolId("control", "resolve_approval");
      const protectedId = normalizeToolId("sandbox", "exec");
      const result = await runAttack({
        toolNames: { control: "resolve_approval", sandbox: "exec" },
        deniedNames: ["control"],
        approvalRequiredName: "sandbox",
        script: [
          completion([makeToolCall(3, controlId), makeToolCall(4, protectedId)]),
          completion([{ type: "text", text: "done" }]),
        ],
      });

      assertSafeAttack(result, protectedId, "suspended");
      expect(result.events.some((event) => event.type === "approval_resolved")).toBe(false);
      expect(result.events.some((event) => event.type === "approval_requested")).toBe(true);
      expect(result.status).toBe("suspended");
    });
  });

  it("detects the deny-bypass mutation through the forbidden execution assertion", async () => {
    await withGoldenTracing(async () => {
      const deniedId = normalizeToolId("sandbox", "exec");
      const result = await runAttack({
        toolNames: { sandbox: "exec" },
        deniedNames: ["sandbox"],
        ignoreDenials: true,
        script: [
          completion([makeToolCall(5, deniedId)]),
          completion([{ type: "text", text: "done" }]),
        ],
      });

      expect(result.executions).toContain(deniedId);
      expect(() => {
        assertSafeAttack(result, deniedId, "completed");
      }).toThrow();
    });
  });
});
