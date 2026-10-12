// SPDX-License-Identifier: Apache-2.0
import { createStrategyRegistry, HeuristicTokenCounter } from "@harness/context";
import { Code, type Message } from "@harness/schemas";
import type { EventStore } from "@harness/store";
import { parseRuntimeModelsConfig, type RuntimeConfig } from "../runtime-config.js";
import { RunRecorder, type Clock } from "../recorder.js";
import { configHash } from "../runtime-ids.js";
import { runLoop } from "../loop.js";
import type { ContextPort, IdGenerator, ModelPort, ToolPort } from "../ports.js";
import { RoleRegistry, RoleRegistryError } from "../roles.js";
import type { ResolvedRole } from "../roles.js";
import { StrategyContextPort } from "../context/context-port.js";
import { AgentSpawnTool } from "./spawn-tool.js";
import type { RunScopeRegistry } from "./scope.js";
import { SubagentSupervisor, type SubagentRunRequest } from "./supervisor.js";

const POLICY_VERSION = "default";

/** Resolves configured roles against the registered tools and built-in spawn tool. */
export async function resolveRuntimeRoles(
  config: RuntimeConfig,
  roleConfigDirectory: string,
  tool: ToolPort,
  onWarning: (code: Code) => void,
): Promise<RoleRegistry> {
  const contextStrategies = new Set(
    Array.from(
      createStrategyRegistry({ provider: "default", model: "default" }).keys(),
      (strategyId) => Code.parse(strategyId),
    ),
  );
  return RoleRegistry.create({
    ...(config.roles === undefined ? {} : { roles: config.roles }),
    models: parseRuntimeModelsConfig(config.models),
    registeredTools: [
      ...(tool.getToolSpecs?.().map((spec) => spec.toolId) ?? []),
      Code.parse("agent.spawn"),
    ],
    contextStrategies,
    configDirectory: roleConfigDirectory,
    onWarning: (warning) => {
      onWarning(warning.code);
    },
  });
}

function contextForRole(role: ResolvedRole): ContextPort {
  const strategy = createStrategyRegistry({ provider: "default", model: "default" }).get(
    role.contextStrategy ?? "naive",
  );
  if (strategy === undefined) {
    throw new RoleRegistryError("role_context_strategy_unknown");
  }
  const strategyContext = new StrategyContextPort(strategy, {
    budget: { maxTokens: Number.MAX_SAFE_INTEGER, reserveOutputTokens: 0 },
    model: { provider: "default", model: "default" },
    counter: new HeuristicTokenCounter(),
  });
  if (role.systemPrompt === undefined) {
    return strategyContext;
  }
  const systemMessage: Message = {
    role: "system",
    parts: [{ type: "text", text: role.systemPrompt }],
  };
  return {
    build: async (events) => [systemMessage, ...(await strategyContext.build(events))],
    estimate: (messages) => strategyContext.estimate(messages),
    observeModelResponse: (model, estimated, actual) => {
      strategyContext.observeModelResponse(model, estimated, actual);
    },
    snapshot: () => strategyContext.snapshot(),
    restore: (snapshot, events) => strategyContext.restore(snapshot, events),
  };
}

/** Creates the runtime's spawn decorator and production child-run callback. */
export function createSubagentTool(options: {
  readonly config: RuntimeConfig;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly store: EventStore;
  readonly model: ModelPort;
  readonly parentTool: ToolPort;
  readonly roles: RoleRegistry;
  readonly scopes: RunScopeRegistry;
}): ToolPort {
  const supervisor = new SubagentSupervisor({
    store: options.store,
    ids: options.ids,
    scopes: options.scopes,
    parentTools: options.parentTool,
    runChild: async (request: SubagentRunRequest) => {
      const result = await runLoop({
        recorder: new RunRecorder(
          options.store,
          request.runId,
          options.ids.next(),
          0,
          options.clock,
        ),
        clock: options.clock,
        model: options.model,
        tool: request.tools,
        context: contextForRole(request.role),
        ids: options.ids,
        goal: request.input,
        signal: request.signal,
        budgets: options.config.run.budgets,
        checkpointEveryEvents: options.config.run.checkpointEveryEvents,
        configHash: configHash(options.config),
        policyVersion: POLICY_VERSION,
        role: request.role.route ?? request.role.id,
        parentRunId: request.parentRunId,
        parentCallId: request.parentCallId,
        scopeId: request.scopeId,
        depth: request.depth,
        rootSpanParent: request.rootSpanParent,
        rootSpanLinks: request.rootSpanLinks,
      });
      const response = result.events.findLast((event) => event.type === "model_response");
      const text =
        response?.type === "model_response"
          ? response.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("")
          : "";
      return { status: result.status, text };
    },
  });
  return new AgentSpawnTool(options.parentTool, options.roles, supervisor);
}
