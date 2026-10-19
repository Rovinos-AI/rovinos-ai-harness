// SPDX-License-Identifier: Apache-2.0
import { createStrategyRegistry, HeuristicTokenCounter } from "@harness/context";
import { Code, type Event, type Id, type Message } from "@harness/schemas";
import { validateWithTokens } from "@harness/pii";
import type { AuditingVaultResolver } from "@harness/vault";
import type { ValueTransform } from "@harness/models";
import type { EventStore } from "@harness/store";
import type { WorkspaceSnapshotPort } from "@harness/sandbox";
import { parseRuntimeModelsConfig, type RuntimeConfig } from "../runtime-config.js";
import { RunRecorder, type Clock } from "../recorder.js";
import { configHash } from "../runtime-ids.js";
import { runLoop } from "../loop.js";
import { RunAwaitingApprovalError, RunAlreadyTerminalError, resumeRun } from "../resume.js";
import type { ContextPort, IdGenerator, ModelPort, PolicyPort, ToolPort } from "../ports.js";
import { RoleRegistry, RoleRegistryError } from "../roles.js";
import type { ResolvedRole } from "../roles.js";
import { StrategyContextPort } from "../context/context-port.js";
import { AgentSpawnTool } from "./spawn-tool.js";
import type { RunScopeRegistry } from "./scope.js";
import { SubagentSupervisor, type SubagentRunRequest } from "./supervisor.js";
import { finalizeChild, type SubagentResult } from "./result.js";
import { foldRunState, isTerminalRunState } from "../run-state.js";
import { RUN_SPAN } from "../spans.js";

async function readEvents(store: EventStore, runId: Id): Promise<Event[]> {
  const events: Event[] = [];
  for await (const event of store.read(runId)) {
    events.push(event);
  }
  return events;
}

async function parentRequester(
  store: EventStore,
  runId: Id,
): Promise<Extract<Event, { type: "run_created" }>["requestedBy"]> {
  const event = (await readEvents(store, runId)).find((candidate) => candidate.type === "run_created");
  return event?.type === "run_created" ? event.requestedBy : undefined;
}

function childStartupGuard(
  store: EventStore,
  request: SubagentRunRequest,
): (events: Event[]) => Promise<boolean> {
  return async (events) => {
    const childEvents = await readEvents(store, request.runId);
    events.push(...childEvents.slice(events.length));
    if (isTerminalRunState(foldRunState(childEvents))) {
      return false;
    }
    const parentEvents = await readEvents(store, request.parentRunId);
    const completed = parentEvents.some(
      (event) => event.type === "subagent_completed" && event.childRunId === request.runId,
    );
    return (
      !completed &&
      !isTerminalRunState(foldRunState(parentEvents)) &&
      (!request.signal.aborted || request.signal.reason === "shutdown")
    );
  };
}

function childRunOptions(
  config: RuntimeConfig,
  workspaceSnapshotter: WorkspaceSnapshotPort | undefined,
): {
  readonly configHash: string;
  readonly snapshotKeep?: number;
  readonly workspaceSnapshotter?: WorkspaceSnapshotPort;
} {
  return {
    configHash: configHash(config),
    ...(config.store?.snapshotKeep === undefined
      ? {}
      : { snapshotKeep: config.store.snapshotKeep }),
    ...(workspaceSnapshotter === undefined ? {} : { workspaceSnapshotter }),
  };
}

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

/** Builds the context port configured for one subagent role. */
export function contextForRole(role: ResolvedRole): ContextPort {
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
    build: async (events, previousEventLogs) => {
      const built = await strategyContext.build(events, previousEventLogs);
      const messages = [systemMessage, ...built.messages];
      return {
        messages,
        metadata: {
          ...built.metadata,
          estimatedTokens: strategyContext.estimate(messages),
          messageCount: messages.length,
        },
      };
    },
    estimate: (messages) => strategyContext.estimate(messages),
    observeModelResponse: (model, estimated, actual) => {
      strategyContext.observeModelResponse(model, estimated, actual);
    },
    snapshot: () => strategyContext.snapshot(),
    restore: (snapshot, events) => strategyContext.restore(snapshot, events),
  };
}

function childValueTransform(
  runId: SubagentRunRequest["runId"],
  resolver: AuditingVaultResolver,
): ValueTransform {
  return async (schema, value) => {
    const validated = await validateWithTokens(schema, value, { runId, resolver });
    return validated.ok
      ? { ok: true, tokenized: validated.tokenized }
      : { ok: false, issues: validated.issues };
  };
}

interface SubagentRuntimeOptions {
  readonly config: RuntimeConfig;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly store: EventStore;
  readonly model: ModelPort;
  readonly parentTool: ToolPort;
  readonly policy: PolicyPort;
  readonly policyVersion: PolicyPort["version"];
  readonly workspaceSnapshotter?: WorkspaceSnapshotPort;
  readonly roles: RoleRegistry;
  readonly scopes: RunScopeRegistry;
  readonly resolver?: AuditingVaultResolver;
}

async function startPendingChild(
  options: SubagentRuntimeOptions,
  request: SubagentRunRequest,
): Promise<void> {
  const initialEvents = await readEvents(options.store, request.runId);
  if (
    initialEvents.length !== 1 ||
    foldRunState(initialEvents).status !== "pending" ||
    initialEvents[0]?.type !== "run_created"
  ) {
    return;
  }
  const recorder = new RunRecorder(
    options.store,
    request.runId,
    options.ids.next(),
    1,
    options.clock,
  );
  await recorder.withStepSpan(
    RUN_SPAN,
    {},
    async () => {
      const recorded = await recorder.recordBatch([
        { type: "run_input", v: 1, input: request.input, inputKind: "initial" },
        {
          type: "run_status_changed",
          v: 1,
          from: "pending",
          to: "running",
          reason: "start",
        },
      ]);
      const last = recorded.at(-1);
      if (last === undefined) {
        throw new Error("Expected child startup events.");
      }
      return last;
    },
    { parentContext: request.rootSpanParent, links: request.rootSpanLinks },
  );
}

function resumeChildOptions(
  options: SubagentRuntimeOptions,
  request: SubagentRunRequest,
): Parameters<typeof resumeRun>[0] {
  return {
    store: options.store,
    runId: request.runId,
    clock: options.clock,
    ids: options.ids,
    model: options.model,
    tool: request.tools,
    policy: options.policy,
    context: contextForRole(request.role),
    signal: request.signal,
    scopes: options.scopes,
    goal: request.input,
    budgets: request.budgets,
    deadlineTs: request.budgetDeadlineTs,
    depth: request.depth,
    checkpointEveryEvents: options.config.run.checkpointEveryEvents,
    ...(options.config.store?.snapshotKeep === undefined
      ? {}
      : { snapshotKeep: options.config.store.snapshotKeep }),
    resumePolicy: options.config.run.resume.onNonIdempotent,
    ...(options.workspaceSnapshotter === undefined
      ? {}
      : { workspaceSnapshotter: options.workspaceSnapshotter }),
    role: request.role.route ?? request.role.id,
    ...(request.role.resultSchema === undefined
      ? {}
      : {
          finalOutputSchema: request.role.resultSchema,
          ...(options.resolver === undefined
            ? {}
            : { valueTransform: childValueTransform(request.runId, options.resolver) }),
        }),
  };
}

async function childAfterResume(
  options: SubagentRuntimeOptions,
  request: SubagentRunRequest,
  resumeError: Error | undefined,
): Promise<SubagentResult> {
  const events = await readEvents(options.store, request.runId);
  if (events.length === 0) {
    throw resumeError ?? new Error("Child run disappeared during resume.");
  }
  const status = foldRunState(events).status;
  if (status === "pending" || status === "running") {
    throw resumeError ?? new Error("Child run did not reach a resumable state.");
  }
  return finalizeChild({
    childRunId: request.runId,
    status,
    events,
    hasResultSchema: request.role.resultSchema !== undefined,
  });
}

async function resumeChild(
  options: SubagentRuntimeOptions,
  request: SubagentRunRequest,
): Promise<SubagentResult> {
  let resumeError: Error | undefined;
  try {
    await startPendingChild(options, request);
    await resumeRun(resumeChildOptions(options, request));
  } catch (error) {
    if (
      !(error instanceof RunAwaitingApprovalError) &&
      !(error instanceof RunAlreadyTerminalError)
    ) {
      throw error instanceof Error ? error : new Error("Child resume failed.");
    }
    resumeError = error;
  }
  return childAfterResume(options, request, resumeError);
}

async function runNewChild(
  options: SubagentRuntimeOptions,
  request: SubagentRunRequest,
): Promise<SubagentResult> {
  const requestedBy = await parentRequester(options.store, request.parentRunId);
  const recorder = new RunRecorder(
    options.store,
    request.runId,
    options.ids.next(),
    0,
    options.clock,
  );
  const result = await runLoop({
    recorder,
    clock: options.clock,
    model: options.model,
    tool: request.tools,
    policy: options.policy,
    context: contextForRole(request.role),
    ids: options.ids,
    goal: request.input,
    signal: request.signal,
    shouldContinue: childStartupGuard(options.store, request),
    budgets: request.budgets,
    deadlineTs: request.budgetDeadlineTs,
    checkpointEveryEvents: options.config.run.checkpointEveryEvents,
    ...childRunOptions(options.config, options.workspaceSnapshotter),
    policyVersion: options.policyVersion,
    role: request.role.route ?? request.role.id,
    ...(request.role.resultSchema === undefined
      ? {}
      : {
          finalOutputSchema: request.role.resultSchema,
          ...(options.resolver === undefined
            ? {}
            : { valueTransform: childValueTransform(request.runId, options.resolver) }),
        }),
    parentRunId: request.parentRunId,
    parentCallId: request.parentCallId,
    ...(requestedBy === undefined ? {} : { requestedBy }),
    scopeId: request.scopeId,
    depth: request.depth,
    rootSpanParent: request.rootSpanParent,
    rootSpanLinks: request.rootSpanLinks,
  });
  if (result.status === "pending" || result.status === "running") {
    throw new Error("Child run did not reach a final state.");
  }
  return finalizeChild({
    childRunId: request.runId,
    status: result.status,
    events: result.events,
    hasResultSchema: request.role.resultSchema !== undefined,
  });
}

/** Creates the runtime's spawn decorator and production child-run callback. */
export function createSubagentTool(options: SubagentRuntimeOptions): ToolPort {
  const supervisor = new SubagentSupervisor({
    store: options.store,
    ids: options.ids,
    clock: options.clock,
    runConfig: options.config.run,
    scopes: options.scopes,
    parentTools: options.parentTool,
    resumeChild: (request) => resumeChild(options, request),
    runChild: (request) => runNewChild(options, request),
  });
  return new AgentSpawnTool(options.parentTool, options.roles, supervisor);
}
