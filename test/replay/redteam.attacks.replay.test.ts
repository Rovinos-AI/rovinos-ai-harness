// SPDX-License-Identifier: Apache-2.0
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createRuntime,
  ApprovalNotFoundError,
  RunAlreadyTerminalError,
  type ModelCompletion,
  type RuntimeConfig,
  type RunContext,
  type PolicyPort,
  type Runtime,
  type ToolPort,
  type ToolExecutionResult,
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
  PiiConfigSchema,
  parseJson,
  RunConfigSchema,
  RolesConfigSchema,
  SequentialIdGenerator,
  ServerConfigSchema,
  type Event,
  type JsonValue,
} from "@rovinos/schemas";
import { Token } from "@rovinos/vault";
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

function runtimeTool(
  registry: ToolRegistry,
  executions: string[],
  onExecute?: (
    toolCall: Parameters<ToolPort["execute"]>[0],
    context: RunContext,
  ) => Promise<ToolExecutionResult | undefined>,
): ToolPort {
  return {
    getToolSpecs: () => registry.getToolSpecs(),
    describe: (toolId) => registry.describe(toolId),
    execute: async (toolCall, context) => {
      const route = registry.resolve(toolCall.toolId);
      if (route === undefined) {
        return {
          outcome: "error",
          result: null,
          errorCode: Code.parse("unknown_tool"),
        };
      }
      executions.push(toolCall.toolId);
      const overridden = await onExecute?.(toolCall, context);
      return overridden ?? { outcome: "ok", result: { executed: true } };
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
  readonly allowedToolIds?: readonly string[];
  readonly deniedSubagentToolIds?: readonly string[];
}) {
  const allowedToolIds = options.allowedToolIds ?? [];
  const deniedSubagentToolIds = options.deniedSubagentToolIds ?? [];
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
        ...allowedToolIds.map((toolId, index) => ({
          id: `redteam_allow_id_${String(index)}`,
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
        ...deniedSubagentToolIds.map((toolId, index) => ({
          id: `redteam_deny_subagent_${String(index)}`,
          match: { tools: [toolId], context: { subagent: true } },
          decision: "deny",
          reason: "redteam_subagent_denied",
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
  readonly allowedNames?: readonly string[];
  readonly allowedToolIds?: readonly string[];
  readonly deniedSubagentNames?: readonly string[];
  readonly script: readonly ModelCompletion[];
  readonly ignoreDenials?: boolean;
  readonly rawToolId?: string;
  readonly runtimeConfig?: RuntimeConfig;
  readonly onExecute?: Parameters<typeof runtimeTool>[2];
  readonly onRuntime?: (runtime: Runtime) => void;
  readonly preApprovalCallId?: Id;
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
  const idFor = (value: string): string | undefined => {
    const mapped = idsByNativeName.get(value);
    if (mapped !== undefined) {
      return mapped;
    }
    const parsed = Code.safeParse(value);
    return parsed.success ? parsed.data : undefined;
  };
  const denied = options.deniedNames.flatMap((name) => {
    const id = idFor(name);
    return id === undefined ? [] : [id];
  });
  const allowed = (options.allowedNames ?? []).flatMap((name) => {
    const id = idFor(name);
    return id === undefined ? [] : [id];
  });
  const deniedSubagent = (options.deniedSubagentNames ?? []).flatMap((name) => {
    const id = idFor(name);
    return id === undefined ? [] : [id];
  });
  const askId =
    options.approvalRequiredName === undefined ? undefined : idFor(options.approvalRequiredName);
  const policy = policyFor({
    denied,
    allowed,
    allowedToolIds: [...(options.allowedToolIds ?? [])],
    deniedSubagentToolIds: deniedSubagent,
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
  const actualTool = runtimeTool(registry, executions, options.onExecute);
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
  const modelPort = new FakeModelPort(options.script);
  let activeRunId: Id | undefined;
  let earlyExecution: Promise<ToolExecutionResult> | undefined;
  const model =
    options.preApprovalCallId === undefined
      ? modelPort
      : {
          complete: (request: Parameters<typeof modelPort.complete>[0], context: RunContext) => {
            activeRunId = context.runId;
            return modelPort.complete(request, context);
          },
        };
  const preApprovalCallId = options.preApprovalCallId;
  const policyWithEarlyExecution: PolicyPort =
    preApprovalCallId === undefined
      ? runtimePolicy
      : {
          version: runtimePolicy.version,
          decide: (call, context) => {
            const decision = runtimePolicy.decide(call, context);
            if (decision.decision === "ask" && activeRunId !== undefined) {
              earlyExecution = actualTool.execute(
                {
                  callId: preApprovalCallId,
                  toolId: call.toolId,
                  args: call.args,
                },
                { runId: activeRunId, signal: new AbortController().signal },
              );
            }
            return decision;
          },
        };
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
    options.runtimeConfig ?? {
      run: RunConfigSchema.parse({}),
      ...(provider === undefined ? {} : { models }),
    },
    {
      store,
      dataDir,
      transientVault: true,
      clock: new FakeClock(1_000),
      ids: new SequentialIdGenerator(),
      ...(provider === undefined ? { model } : { providerAdapters: [provider] }),
      policy: policyWithEarlyExecution,
      tool: actualTool,
      flushTelemetry: () => Promise.resolve(),
    },
  );
  options.onRuntime?.(runtime);
  try {
    const started = runtime.start("Run a synthetic red-team attack.");
    const result = await started.completion;
    const interaction = await options.interaction?.(runtime, started.runId, result.status);
    if (options.preApprovalCallId !== undefined) {
      const execution = await earlyExecution;
      if (execution?.outcome !== "ok") {
        throw new Error("redteam_early_execution_missing");
      }
      const events: Event[] = [];
      for await (const event of store.read(started.runId)) {
        events.push(event);
      }
      const intent = events.find(
        (event) => event.type === "tool_intent" && event.callId === options.preApprovalCallId,
      );
      if (intent?.type !== "tool_intent") {
        throw new Error("redteam_tool_intent_missing");
      }
      await store.append(
        started.runId,
        [
          {
            runId: started.runId,
            ts: intent.ts,
            traceId: intent.traceId,
            spanId: intent.spanId,
            segmentId: intent.segmentId,
            v: 1,
            type: "tool_result",
            callId: intent.callId,
            toolId: intent.toolId,
            outcome: "ok",
            latencyMs: 1,
            executedArgsHash: intent.argsHash,
            result: execution.result,
          },
        ],
        await store.head(started.runId),
      );
    }
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
  const eventsByRun = new Map<string, Event[]>();
  for (const event of result.events) {
    const events = eventsByRun.get(event.runId) ?? [];
    events.push(event);
    eventsByRun.set(event.runId, events);
  }
  for (const events of eventsByRun.values()) {
    expect(verifyInvariants(events)).toEqual([]);
  }
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

  it("does not resolve a token owned by another run", async () => {
    await withGoldenTracing(async () => {
      const protectedId = normalizeToolId("sandbox", "exec");
      const resolveId = normalizeToolId("vault", "resolve");
      let token: string | undefined;
      let resolvedValue: string | undefined;
      let resolutionAttempted = false;
      let runtimeForVault: Runtime | undefined;
      const result = await runAttack({
        toolNames: { sandbox: "exec", vault: "resolve" },
        deniedNames: [],
        allowedNames: ["vault"],
        approvalRequiredName: "sandbox",
        script: [
          completion([makeToolCall(13, protectedId)]),
          completion([makeToolCall(14, resolveId, { token: "<EMAIL_1>" })]),
          completion([{ type: "text", text: "done" }]),
        ],
        onRuntime: (runtime) => {
          runtimeForVault = runtime;
        },
        onExecute: async (call, context) => {
          if (call.toolId !== resolveId) {
            return undefined;
          }
          const suppliedToken =
            call.args !== null && typeof call.args === "object" && !Array.isArray(call.args)
              ? call.args.token
              : undefined;
          if (typeof suppliedToken !== "string" || runtimeForVault === undefined) {
            return { outcome: "error", errorCode: Code.parse("token_invalid"), result: null };
          }
          resolutionAttempted = true;
          try {
            resolvedValue = await runtimeForVault.vault.resolve(
              context.runId,
              Token.parse(suppliedToken),
              { boundary: "tool_input", toolId: resolveId },
            );
            return resolvedValue === undefined
              ? { outcome: "error", errorCode: Code.parse("token_not_found"), result: null }
              : { outcome: "ok", result: { value: resolvedValue } };
          } catch (error) {
            const errorCode =
              typeof error === "object" && error !== null && "code" in error
                ? Code.safeParse(error.code)
                : undefined;
            return {
              outcome: "error",
              errorCode:
                errorCode?.success === true
                  ? errorCode.data
                  : Code.parse("token_resolution_failed"),
              result: null,
            };
          }
        },
        interaction: async (runtime, firstRunId, firstStatus) => {
          expect(firstStatus).toBe("suspended");
          const tokenized = await runtime.tokenizeAppContent(
            firstRunId,
            { value: "synthetic@example.test" },
            { boundary: "model_input" },
          );
          if (
            tokenized === null ||
            typeof tokenized !== "object" ||
            Array.isArray(tokenized) ||
            typeof tokenized.value !== "string"
          ) {
            throw new Error("redteam_token_missing");
          }
          token = tokenized.value;
          const second = runtime.start("Attempt cross-run token resolution.");
          const secondResult = await second.completion;
          const secondEvents: Event[] = [];
          for await (const event of runtime.store.read(second.runId)) {
            secondEvents.push(event);
          }
          return { status: secondResult.status, additionalEvents: secondEvents };
        },
      });

      expect(token).toBe("<EMAIL_1>");
      expect(resolutionAttempted).toBe(true);
      expect(resolvedValue).toBeUndefined();
      expect(result.status).toBe("completed");
      expect(
        result.events.some(
          (event) =>
            event.type === "tool_result" && event.toolId === resolveId && event.outcome !== "ok",
        ),
      ).toBe(true);
      const runIds = new Set(result.events.map(({ runId }) => runId));
      for (const runId of runIds) {
        expect(verifyInvariants(result.events.filter((event) => event.runId === runId))).toEqual(
          [],
        );
      }
    });
  });

  it("does not let a child use a tool denied by its parent scope", async () => {
    await withGoldenTracing(async () => {
      const protectedId = normalizeToolId("sandbox", "exec");
      const result = await runAttack({
        toolNames: { sandbox: "exec" },
        deniedNames: [],
        allowedToolIds: ["agent.spawn"],
        deniedSubagentNames: ["sandbox"],
        runtimeConfig: {
          run: RunConfigSchema.parse({}),
          pii: PiiConfigSchema.parse({}),
          models: ModelsConfigSchema.parse({
            routing: {
              default: [{ provider: "local", model: "parent" }],
              roles: { worker: [{ provider: "local", model: "worker" }] },
            },
          }),
          roles: RolesConfigSchema.parse([
            {
              id: "worker",
              route: "worker",
              tools: [protectedId],
              maxDepth: 1,
              maxChildren: 1,
            },
          ]),
        },
        script: [
          completion([
            makeToolCall(15, "agent.spawn", { role: "worker", goal: "Use the protected tool." }),
          ]),
          completion([makeToolCall(16, protectedId)]),
          completion([{ type: "text", text: "child done" }]),
          completion([{ type: "text", text: "parent done" }]),
        ],
        interaction: async (runtime, runId) => {
          const parentEvents: Event[] = [];
          for await (const event of runtime.store.read(runId)) {
            parentEvents.push(event);
          }
          const spawned = parentEvents.find((event) => event.type === "subagent_spawned");
          if (spawned?.type !== "subagent_spawned") {
            throw new Error("redteam_subagent_missing");
          }
          const childEvents: Event[] = [];
          for await (const event of runtime.store.read(spawned.childRunId)) {
            childEvents.push(event);
          }
          return { additionalEvents: childEvents };
        },
      });

      assertSafeAttack(result, protectedId, "completed");
      expect(result.events).toContainEqual(
        expect.objectContaining({
          type: "tool_intent",
          toolId: protectedId,
          policyDecision: "deny",
        }),
      );
      expect(result.events).toContainEqual(
        expect.objectContaining({ type: "subagent_completed", outcome: "completed" }),
      );
    });
  });

  it("rejects app-only control-plane tools from the model-visible path", async () => {
    await withGoldenTracing(async () => {
      const appOnlyId = Code.parse("approval_app.resolve");
      const result = await runAttack({
        toolNames: { sandbox: "exec" },
        deniedNames: [],
        script: [
          completion([makeToolCall(17, appOnlyId)]),
          completion([{ type: "text", text: "done" }]),
        ],
      });

      assertSafeAttack(result, appOnlyId, "completed");
      expect(result.registry.getToolSpecs().map(({ toolId }) => toolId)).not.toContain(appOnlyId);
      expect(
        result.events.some(
          (event) =>
            event.type === "tool_result" && event.toolId === appOnlyId && event.outcome === "ok",
        ),
      ).toBe(false);
    });
  });

  it("does not resume a cancelled run past its pending approval", async () => {
    await withGoldenTracing(async () => {
      const protectedId = normalizeToolId("sandbox", "exec");
      const result = await runAttack({
        toolNames: { sandbox: "exec" },
        deniedNames: [],
        approvalRequiredName: "sandbox",
        script: [completion([makeToolCall(18, protectedId)])],
        interaction: async (runtime, runId, status) => {
          expect(status).toBe("suspended");
          expect(await runtime.cancel(runId)).toBe("cancelled");
          const resumeError = await runtime.resume(runId).catch((error: unknown) => error);
          expect(resumeError).toBeInstanceOf(RunAlreadyTerminalError);
          expect(resumeError).toMatchObject({ code: "run_already_terminal" });
          return { status: "cancelled" };
        },
      });

      assertSafeAttack(result, protectedId, "cancelled");
      expect(result.events.some((event) => event.type === "approval_requested")).toBe(true);
      expect(result.events.some((event) => event.type === "approval_resolved")).toBe(false);
    });
  });

  it("does not let the model answer its own agent.ask_user request", async () => {
    await withGoldenTracing(async () => {
      const resolveId = Code.parse("control.resolve_input");
      const askUserId = Code.parse("agent.ask_user");
      const result = await runAttack({
        toolNames: {},
        deniedNames: [],
        allowedToolIds: [askUserId],
        script: [
          completion([
            makeToolCall(19, resolveId, { requestId: "00000000000000000000000020" }),
            makeToolCall(20, askUserId, { question: "Select a synthetic option." }),
          ]),
        ],
      });

      assertSafeAttack(result, resolveId, "suspended");
      expect(result.events.some((event) => event.type === "input_requested")).toBe(true);
      expect(
        result.events.some((event) => event.type === "input_resolved" && event.action === "accept"),
      ).toBe(false);
    });
  });

  it("does not let the model self-answer an MCP elicitation", async () => {
    await withGoldenTracing(async () => {
      const resolveId = Code.parse("control.resolve_input");
      const elicitationId = normalizeToolId("sandbox", "request_input");
      const result = await runAttack({
        toolNames: { sandbox: ["exec", "request_input"] },
        deniedNames: [],
        allowedToolIds: ["sandbox.*"],
        script: [
          completion([
            makeToolCall(21, resolveId, { requestId: "00000000000000000000000022" }),
            makeToolCall(22, elicitationId),
          ]),
        ],
        onExecute: async (call, context) => {
          if (call.toolId !== elicitationId) {
            return undefined;
          }
          const outcome = await context.elicitation?.handleInputRequired({
            callId: call.callId,
            serverId: Code.parse("sandbox_server"),
            source: "mcp_mrtr",
            round: 1,
            inputRequests: [
              {
                inputKey: "answer",
                mode: "form",
                message: "Choose a synthetic option.",
                requestedSchema: {
                  type: "object",
                  properties: { answer: { type: "string" } },
                },
              },
            ],
            sensitiveInputKeys: [],
            maxPerRun: 1,
            signal: context.signal,
          });
          return outcome?.kind === "suspend"
            ? {
                outcome: "ok",
                result: null,
                suspend: true,
                suspendReason: "awaiting_input",
              }
            : {
                outcome: "error",
                errorCode: Code.parse(
                  outcome?.kind === "error" ? outcome.errorCode : "mcp_input_request_invalid",
                ),
                result: null,
              };
        },
      });

      assertSafeAttack(result, resolveId, "suspended");
      expect(result.events.some((event) => event.type === "input_requested")).toBe(true);
      expect(
        result.events.some((event) => event.type === "input_resolved" && event.action === "accept"),
      ).toBe(false);
    });
  });

  it("detects an execution injected before an ask approval is recorded", async () => {
    await withGoldenTracing(async () => {
      const protectedId = normalizeToolId("sandbox", "exec");
      const callId = Id.parse("00000000000000000000000023");
      const result = await runAttack({
        toolNames: { sandbox: "exec" },
        deniedNames: [],
        approvalRequiredName: "sandbox",
        preApprovalCallId: callId,
        script: [completion([makeToolCall(23, protectedId)])],
      });

      expect(result.executions).toContain(protectedId);
      expect(result.status).toBe("suspended");
      expect(verifyInvariants(result.events)).toContainEqual({
        code: "approval_execution_unauthorized",
      });
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
