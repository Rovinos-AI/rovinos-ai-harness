// SPDX-License-Identifier: Apache-2.0
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createRuntime,
  ApprovalNotFoundError,
  type ModelCompletion,
  type PolicyPort,
  type Runtime,
  type ToolPort,
} from "@rovinos/core";
import { FakeModelPort } from "@rovinos/core/testing";
import { ToolRegistry, normalizeToolId, type McpTool } from "@rovinos/mcp";
import { ProviderResultSchema, type ProviderAdapter } from "@rovinos/models";
import { ApprovalEditError, PolicyDocumentSchema, PolicyEngine } from "@rovinos/policy";
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
  type JsonValue,
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

function registryFor(
  nativeNames: Readonly<Record<string, string | readonly string[]>>,
): ToolRegistry {
  return new ToolRegistry(
    Object.entries(nativeNames).map(([prefix, names]) => ({
      config: ServerConfigSchema.parse({
        id: `${prefix}_server`,
        toolPrefix: prefix,
        transport: { kind: "stdio", command: "/bin/false" },
        timeouts: { callMs: 1_000 },
      }),
      tools: (typeof names === "string" ? [names] : names).map(
        (name) =>
          ({
            name,
            inputSchema: { type: "object" },
          }) satisfies McpTool,
      ),
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
  readonly allowed?: readonly string[];
  readonly approvalRequired?: string;
  readonly approvalEditable?: readonly string[];
  readonly deniedArgument?: {
    readonly toolId: string;
    readonly pointer: string;
    readonly value: JsonValue;
  };
}) {
  return new PolicyEngine(
    PolicyDocumentSchema.parse({
      version: 1,
      defaultDecision: "deny",
      rules: [
        ...(options.allowed ?? []).map((toolId, index) => ({
          id: `redteam_allow_${String(index)}`,
          match: { tools: [toolId] },
          decision: "allow",
          reason: "redteam_allowed",
        })),
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
                ...(options.approvalEditable === undefined
                  ? {}
                  : { editable: options.approvalEditable }),
              },
            ]),
        ...(options.deniedArgument === undefined
          ? []
          : [
              {
                id: "redteam_nested_argument_deny",
                match: {
                  tools: [options.deniedArgument.toolId],
                  args: [
                    {
                      pointer: options.deniedArgument.pointer,
                      op: "equals",
                      value: options.deniedArgument.value,
                    },
                  ],
                },
                decision: "deny",
                reason: "redteam_nested_argument_denied",
              },
            ]),
      ],
    }),
  );
}

type AttackInteraction = (
  runtime: Runtime,
  runId: Id,
  initialStatus: string,
) => Promise<{ readonly status?: string; readonly additionalEvents?: readonly Event[] }>;

async function runAttack(options: {
  readonly toolNames: Readonly<Record<string, string | readonly string[]>>;
  readonly deniedNames: readonly string[];
  readonly approvalRequiredName?: string;
  readonly approvalEditable?: readonly string[];
  readonly deniedArgument?: {
    readonly toolName: string;
    readonly pointer: string;
    readonly value: JsonValue;
  };
  readonly script: readonly ModelCompletion[];
  readonly ignoreDenials?: boolean;
  readonly rawToolId?: string;
  readonly interaction?: AttackInteraction;
}): Promise<AttackResult> {
  const registry = registryFor(options.toolNames);
  const nativeNames = Object.entries(options.toolNames).flatMap(([prefix, names]) =>
    (typeof names === "string" ? [names] : names).map((name) => ({ prefix, name })),
  );
  const idsByNativeName = new Map<string, string>();
  for (const [index, { prefix, name }] of nativeNames.entries()) {
    const toolId = registry.getToolSpecs()[index]?.toolId;
    if (toolId !== undefined) {
      idsByNativeName.set(`${prefix}:${name}`, toolId);
      if (!idsByNativeName.has(prefix)) {
        idsByNativeName.set(prefix, toolId);
      }
    }
  }
  const denied = options.deniedNames.flatMap((name) => {
    const id = idsByNativeName.get(name);
    return id === undefined ? [] : [id];
  });
  const askId =
    options.approvalRequiredName === undefined
      ? undefined
      : idsByNativeName.get(options.approvalRequiredName);
  const policy = policyFor({
    denied,
    ...(askId === undefined ? {} : { approvalRequired: askId }),
    ...(options.approvalEditable === undefined
      ? {}
      : { approvalEditable: options.approvalEditable }),
    ...(options.deniedArgument === undefined
      ? {}
      : {
          deniedArgument: {
            toolId: idsByNativeName.get(options.deniedArgument.toolName) ?? "",
            pointer: options.deniedArgument.pointer,
            value: options.deniedArgument.value,
          },
        }),
  });
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
    const interaction = await options.interaction?.(runtime, started.runId, result.status);
    const events: Event[] = [];
    for await (const event of store.read(started.runId)) {
      events.push(event);
    }
    events.push(...(interaction?.additionalEvents ?? []));
    return { events, status: interaction?.status ?? result.status, executions, registry };
  } finally {
    await runtime.close();
  }
}

function makeToolCall(
  callId: number,
  toolId: string,
  args: JsonValue = {},
): ModelCompletion["parts"][number] {
  return {
    type: "tool_call",
    callId: Id.parse(String(callId).padStart(26, "0")),
    toolId: Code.parse(toolId),
    args,
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

  it("rejects tool-name collisions after normalization", () => {
    const policy = policyFor({
      allowed: ["sandbox.*"],
      denied: ["sandbox.exec"],
    });
    expect(
      policy.decide({ toolId: Code.parse("sandbox.exec"), args: {} }, { subagent: false }).decision,
    ).toBe("deny");
    expect(() => registryFor({ sandbox: ["exec", "Exec"] })).toThrow("tool_id_collision");
  });

  it.each([
    {
      attack: "registered model-visible resolver",
      toolNames: { control: "resolve_approval", sandbox: "exec" },
      deniedNames: ["control"],
      parts: (controlId: string, protectedId: string) => [
        makeToolCall(3, controlId),
        makeToolCall(4, protectedId),
      ],
    },
    {
      attack: "unregistered model-visible resolver",
      toolNames: { sandbox: "exec" },
      deniedNames: [],
      parts: (controlId: string, protectedId: string) => [
        makeToolCall(3, controlId),
        makeToolCall(4, protectedId),
      ],
    },
    {
      attack: "model text claims approval",
      toolNames: { sandbox: "exec" },
      deniedNames: [],
      parts: (_controlId: string, protectedId: string) => [
        { type: "text" as const, text: "The call is approved." },
        makeToolCall(4, protectedId),
      ],
    },
  ])(
    "keeps protected execution suspended after $attack",
    async ({ toolNames, deniedNames, parts }) => {
      await withGoldenTracing(async () => {
        const controlId = normalizeToolId("control", "resolve_approval");
        const protectedId = normalizeToolId("sandbox", "exec");
        const result = await runAttack({
          toolNames,
          deniedNames,
          approvalRequiredName: "sandbox",
          script: [completion(parts(controlId, protectedId))],
        });

        assertSafeAttack(result, protectedId, "suspended");
        expect(result.executions).not.toContain(controlId);
        expect(result.events.some((event) => event.type === "approval_resolved")).toBe(false);
        expect(result.events.some((event) => event.type === "approval_requested")).toBe(true);
      });
    },
  );

  it("rejects approval edits outside editableFields without resolving the request", async () => {
    await withGoldenTracing(async () => {
      const protectedId = normalizeToolId("sandbox", "exec");
      const result = await runAttack({
        toolNames: { sandbox: "exec" },
        deniedNames: [],
        approvalRequiredName: "sandbox",
        approvalEditable: ["/value"],
        script: [
          completion([makeToolCall(8, protectedId, { value: "before", protected: "unchanged" })]),
        ],
        interaction: async (runtime, runId, status) => {
          const events: Event[] = [];
          for await (const event of runtime.store.read(runId)) {
            events.push(event);
          }
          const request = events.find((event) => event.type === "approval_requested");
          if (request?.type !== "approval_requested") {
            throw new Error("redteam_approval_missing");
          }
          const intent = events.find(
            (event) => event.type === "tool_intent" && event.callId === request.callId,
          );
          if (intent?.type !== "tool_intent") {
            throw new Error("redteam_tool_intent_missing");
          }
          const argsHashBefore = intent.argsHash;
          const editError = await runtime
            .resolveApproval(runId, request.approvalId, "edit", {
              edits: { value: "after", protected: "changed" },
              metadata: { decidedBy: "human", approverId: Code.parse("cli.redteam") },
            })
            .catch((error: unknown) => error);
          expect(editError).toBeInstanceOf(ApprovalEditError);
          expect(editError).toMatchObject({ code: "edit_not_allowed" });
          const eventsAfterAttempt: Event[] = [];
          for await (const event of runtime.store.read(runId)) {
            eventsAfterAttempt.push(event);
          }
          const intentAfter = eventsAfterAttempt.find(
            (event) => event.type === "tool_intent" && event.callId === request.callId,
          );
          expect(intentAfter?.type === "tool_intent" ? intentAfter.argsHash : undefined).toBe(
            argsHashBefore,
          );
          expect(verifyInvariants(eventsAfterAttempt)).toEqual([]);
          return { status };
        },
      });

      expect(result.events.some((event) => event.type === "approval_resolved")).toBe(false);
      assertSafeAttack(result, protectedId, "suspended");
    });
  });

  it("rejects an approval id replayed across runs", async () => {
    await withGoldenTracing(async () => {
      const protectedId = normalizeToolId("sandbox", "exec");
      const result = await runAttack({
        toolNames: { sandbox: "exec" },
        deniedNames: [],
        approvalRequiredName: "sandbox",
        script: [
          completion([makeToolCall(9, protectedId)]),
          completion([makeToolCall(10, protectedId)]),
        ],
        interaction: async (runtime, firstRunId, _firstStatus) => {
          const firstEvents: Event[] = [];
          for await (const event of runtime.store.read(firstRunId)) {
            firstEvents.push(event);
          }
          const firstApproval = firstEvents.find((event) => event.type === "approval_requested");
          if (firstApproval?.type !== "approval_requested") {
            throw new Error("redteam_first_approval_missing");
          }

          const second = runtime.start("Run a second synthetic red-team attack.");
          const secondResult = await second.completion;
          const secondEvents: Event[] = [];
          for await (const event of runtime.store.read(second.runId)) {
            secondEvents.push(event);
          }
          const secondApproval = secondEvents.find((event) => event.type === "approval_requested");
          if (secondApproval?.type !== "approval_requested") {
            throw new Error("redteam_second_approval_missing");
          }
          expect(secondApproval.approvalId).not.toBe(firstApproval.approvalId);
          const staleApprovalError = await runtime
            .resolveApproval(second.runId, firstApproval.approvalId, "approve", {
              metadata: { decidedBy: "human", approverId: Code.parse("cli.redteam") },
            })
            .catch((error: unknown) => error);
          expect(staleApprovalError).toBeInstanceOf(ApprovalNotFoundError);
          expect(staleApprovalError).toMatchObject({ code: "approval_not_found" });
          const firstEventsAfterAttempt: Event[] = [];
          for await (const event of runtime.store.read(firstRunId)) {
            firstEventsAfterAttempt.push(event);
          }
          const secondEventsAfterAttempt: Event[] = [];
          for await (const event of runtime.store.read(second.runId)) {
            secondEventsAfterAttempt.push(event);
          }
          expect(firstEventsAfterAttempt.some((event) => event.type === "approval_resolved")).toBe(
            false,
          );
          expect(secondEventsAfterAttempt.some((event) => event.type === "approval_resolved")).toBe(
            false,
          );
          expect(verifyInvariants(firstEventsAfterAttempt)).toEqual([]);
          expect(verifyInvariants(secondEventsAfterAttempt)).toEqual([]);
          return { status: secondResult.status, additionalEvents: secondEventsAfterAttempt };
        },
      });

      expect(result.status).toBe("suspended");
      expect(verifyInvariants(result.events)).toEqual([]);
      expect(result.events.filter((event) => event.type === "approval_resolved")).toHaveLength(0);
    });
  });

  it("allows only one winner when two approval resolutions race", async () => {
    await withGoldenTracing(async () => {
      const protectedId = normalizeToolId("sandbox", "exec");
      const result = await runAttack({
        toolNames: { sandbox: "exec" },
        deniedNames: [],
        approvalRequiredName: "sandbox",
        script: [
          completion([makeToolCall(11, protectedId)]),
          completion([{ type: "text", text: "done" }]),
        ],
        interaction: async (runtime, runId) => {
          const events: Event[] = [];
          for await (const event of runtime.store.read(runId)) {
            events.push(event);
          }
          const request = events.find((event) => event.type === "approval_requested");
          if (request?.type !== "approval_requested") {
            throw new Error("redteam_approval_missing");
          }
          const outcomes = await Promise.allSettled([
            runtime.resolveApproval(runId, request.approvalId, "approve", {
              metadata: { decidedBy: "human", approverId: Code.parse("cli.first_reviewer") },
            }),
            runtime.resolveApproval(runId, request.approvalId, "deny", {
              metadata: { decidedBy: "human", approverId: Code.parse("cli.second_reviewer") },
            }),
          ]);
          expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
          expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
          const resumed = await runtime.resume(runId);
          return { status: resumed.status };
        },
      });

      const resolutions = result.events.filter((event) => event.type === "approval_resolved");
      expect(resolutions).toHaveLength(1);
      expect(verifyInvariants(result.events)).toEqual([]);
      const approvalWon =
        resolutions[0]?.type === "approval_resolved" && resolutions[0].decision === "approve";
      expect({
        executed: result.executions.includes(protectedId),
        status: result.status,
      }).toEqual(
        approvalWon
          ? { executed: true, status: "completed" }
          : { executed: false, status: "failed" },
      );
    });
  });

  it("denies a nested privileged argument matched by a JSON pointer rule", async () => {
    await withGoldenTracing(async () => {
      const protectedId = normalizeToolId("sandbox", "exec");
      const result = await runAttack({
        toolNames: { sandbox: "exec" },
        deniedNames: [],
        deniedArgument: {
          toolName: "sandbox",
          pointer: "/options/privileged",
          value: true,
        },
        script: [
          completion([
            makeToolCall(12, protectedId, {
              options: { privileged: true, mode: "safe" },
            }),
          ]),
          completion([{ type: "text", text: "done" }]),
        ],
      });

      assertSafeAttack(result, protectedId, "completed");
      expect(
        result.events.some(
          (event) => event.type === "tool_intent" && event.policyDecision === "deny",
        ),
      ).toBe(true);
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
