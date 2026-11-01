// SPDX-License-Identifier: Apache-2.0
// Synthetic in-memory recordings shared by the human-input unit and replay gates.
import {
  createRuntime,
  type ModelCompletion,
  type PolicyPort,
  type Runtime,
  type RuntimeConfig,
  type ToolPort,
} from "@rovinos/core";
import { allowAllPolicy, FakeModelPort } from "@rovinos/core/testing";
import { Code, Id, RunConfigSchema, type Event, type InputResponse } from "@rovinos/schemas";
import { InMemoryEventStore } from "@rovinos/store";
import { ResolvedRunSchema, type ResolvedRun } from "./resolve.js";

export const inputRunConfig: RuntimeConfig = {
  run: RunConfigSchema.parse({}),
};
export const inputReplayOptions = { config: inputRunConfig, policy: allowAllPolicy };
export const inputCallId = Id.parse("00000000000000000000000091");
export const inputToolId = Code.parse("synthetic.confirm");
export const inputState = "opaque.synthetic.state";

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

interface InputFixtureOptions {
  readonly agent?: boolean;
  readonly policy?: PolicyPort;
  readonly rounds?: number;
  readonly batch?: boolean;
  readonly actions?: readonly InputResponse["action"][];
  readonly policyDecline?: boolean;
}

function inputTool(options: InputFixtureOptions, calls: number[]): ToolPort {
  return {
    describe: (toolId) =>
      toolId === inputToolId ? { idempotent: true, timeoutMs: 1000 } : undefined,
    getToolSpecs: () => [
      {
        toolId: inputToolId,
        description: "Synthetic confirmation",
        inputSchema: { type: "object" },
      },
    ],
    execute: async (_call, context) => {
      const round = (context.inputRetry?.round ?? 0) + 1;
      calls.push(round);
      if (round > (options.rounds ?? 2)) {
        return { outcome: "ok", result: { recorded: true } };
      }
      const outcome = await context.elicitation?.handleInputRequired({
        callId: inputCallId,
        serverId: Code.parse("synthetic.server"),
        round,
        inputRequests: [
          {
            inputKey: "email",
            mode: "form",
            message: "Synthetic contact",
            requestedSchema: {
              type: "object",
              properties: { email: { type: "string" } },
              required: ["email"],
            },
          },
          ...(options.batch === true
            ? [
                {
                  inputKey: "connected",
                  mode: "url" as const,
                  message: "Synthetic connect",
                  url: "https://synthetic.example.test/connect",
                },
              ]
            : []),
        ],
        sensitiveInputKeys: [],
        ...(options.policyDecline === true ? { policyDeclinedInputKeys: ["email"] } : {}),
        maxPerRun: 20,
        requestState: inputState,
        signal: context.signal,
      });
      if (outcome?.kind === "retry") {
        return { outcome: "ok", result: { recorded: true } };
      }
      if (outcome?.kind !== "suspend") {
        throw new Error("Synthetic input did not suspend.");
      }
      return { outcome: "ok", result: null, suspend: true, suspendReason: "awaiting_input" };
    },
  };
}

async function resolvePending(
  runtime: Runtime,
  runId: Id,
  result: Awaited<ReturnType<Runtime["resume"]>>,
  options: InputFixtureOptions,
): Promise<void> {
  for (const request of result.state.pendingInputs.values()) {
    const action = options.actions?.[request.round - 1] ?? "accept";
    await runtime.resolveInput(runId, request.requestId, {
      action,
      principal: Code.parse("cli.synthetic"),
      ...(action !== "accept" || request.mode === "url"
        ? {}
        : {
            answer: { email: "synthetic.input@example.test" },
          }),
    });
  }
  const approval = result.state.pendingApprovals.values().next().value;
  if (approval !== undefined) {
    await runtime.resolveApproval(runId, approval.approvalId, "approve", {
      metadata: { decidedBy: "human", approverId: Code.parse("cli.synthetic") },
    });
  }
}

/** Records only synthetic model, tool, and human behavior for replay tests. */
export async function recordInputRun(options: InputFixtureOptions = {}): Promise<{
  resolved: ResolvedRun;
  calls: number[];
  model: FakeModelPort;
  toolRegistry: ToolPort;
}> {
  const calls: number[] = [];
  const model = new FakeModelPort([
    completion([
      {
        type: "tool_call",
        callId: inputCallId,
        toolId: options.agent === true ? "agent.ask_user" : inputToolId,
        args: options.agent === true ? { question: "Synthetic question" } : {},
      },
    ]),
    completion([{ type: "text", text: "Synthetic complete" }]),
  ]);
  const tool = inputTool(options, calls);
  let nextId = 100;
  let time = 1_000;
  const runtime = await createRuntime(inputRunConfig, {
    alreadyTokenized: true,
    store: new InMemoryEventStore(),
    model,
    tool,
    clock: { now: () => time++ },
    ids: { next: () => Id.parse(String(nextId++).padStart(26, "0")) },
    transientVault: true,
    sandboxBackend: { exec: () => Promise.reject(new Error("Unused synthetic sandbox")) },
    policy: options.policy ?? allowAllPolicy,
  });
  try {
    const started = runtime.start("Synthetic input replay");
    let result = await started.completion;
    while (result.status === "suspended") {
      await resolvePending(runtime, started.runId, result, options);
      result = await runtime.resume(started.runId);
    }
    if (result.status !== "completed") {
      throw new Error("Synthetic input run failed.");
    }
    const events: Event[] = [];
    for await (const event of runtime.store.read(started.runId)) {
      events.push(event);
    }
    return {
      resolved: ResolvedRunSchema.parse({
        rootRunId: started.runId,
        runs: [{ runId: started.runId, role: "root", events }],
      }),
      calls,
      model,
      toolRegistry: tool,
    };
  } finally {
    await runtime.close();
  }
}

/** Records sequential round-zero requests through the real legacy live handler. */
export async function recordLegacyInputRun(reuseKey: boolean): Promise<{
  resolved: ResolvedRun;
  toolRegistry: ToolPort;
}> {
  const actions = ["accept", "decline", "cancel"] as const;
  let nextId = 100;
  let time = 1_000;
  let presentation = 0;
  const tool: ToolPort = {
    ...inputTool({}, []),
    describe: (toolId) =>
      toolId === inputToolId ? { idempotent: false, timeoutMs: 1000 } : undefined,
    execute: async (_call, context) => {
      for (const index of [0, 1, 2]) {
        const response = await context.elicitation?.handleLegacyLive?.({
          callId: inputCallId,
          serverId: Code.parse("synthetic.legacy"),
          elicitationId: reuseKey ? "question" : `question.${String(index)}`,
          request: {
            inputKey: reuseKey ? "question" : `question.${String(index)}`,
            mode: "form",
            message: "Synthetic legacy question",
            requestedSchema: {
              type: "object",
              properties: { email: { type: "string" } },
              required: ["email"],
            },
          },
          timeoutMs: 1000,
          signal: context.signal,
        });
        if (response?.action !== actions[index]) {
          throw new Error("Synthetic legacy resolution did not match.");
        }
      }
      return { outcome: "ok", result: { recorded: true } };
    },
  };
  const runtime = await createRuntime(inputRunConfig, {
    alreadyTokenized: true,
    store: new InMemoryEventStore(),
    model: new FakeModelPort([
      completion([{ type: "tool_call", callId: inputCallId, toolId: inputToolId, args: {} }]),
      completion([{ type: "text", text: "Synthetic legacy complete" }]),
    ]),
    tool,
    clock: { now: () => time++ },
    ids: { next: () => Id.parse(String(nextId++).padStart(26, "0")) },
    policy: allowAllPolicy,
    inputChannels: [
      {
        id: Code.parse("test.synthetic"),
        available: (request) => request.source === "mcp_legacy",
        present: () => {
          const action = actions[presentation++] ?? "decline";
          return Promise.resolve({
            action,
            principal: Code.parse("cli.synthetic"),
            ...(action === "accept" ? { answer: { email: "synthetic.input@example.test" } } : {}),
          });
        },
      },
    ],
    transientVault: true,
    sandboxBackend: { exec: () => Promise.reject(new Error("Unused synthetic sandbox")) },
  });
  try {
    const started = runtime.start("Synthetic legacy replay");
    const result = await started.completion;
    if (result.status !== "completed" || presentation !== 3) {
      throw new Error("Synthetic legacy recording failed.");
    }
    const events: Event[] = [];
    for await (const event of runtime.store.read(started.runId)) {
      events.push(event);
    }
    return {
      resolved: ResolvedRunSchema.parse({
        rootRunId: started.runId,
        runs: [{ runId: started.runId, role: "root", events }],
      }),
      toolRegistry: tool,
    };
  } finally {
    await runtime.close();
  }
}
