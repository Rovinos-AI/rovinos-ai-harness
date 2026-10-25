// SPDX-License-Identifier: Apache-2.0
// Apps use the same tool step, approval request, and resume executor as model calls.
import { Code, Id, JsonValue, type Event } from "@rovinos/schemas";
import type { EventStore } from "@rovinos/store";
import { Checkpointer } from "./checkpoint.js";
import {
  PolicyDecisionSchema,
  type ContextPort,
  type IdGenerator,
  type ModelToolCall,
  type PolicyDecision,
  type PolicyPort,
  type ToolPort,
} from "./ports.js";
import { RunRecorder, type Clock } from "./recorder.js";
import { foldRunState } from "./run-state.js";
import { toolStep } from "./steps/tool-step.js";

/** Runtime ports shared with the ordinary model tool and approval steps. */
export interface AppApprovalDependencies {
  readonly tool: ToolPort;
  readonly policy: PolicyPort;
  readonly context: ContextPort;
  readonly ids: IdGenerator;
}

interface AppApprovalOptions {
  readonly store: EventStore;
  readonly clock: Clock;
  readonly approval?: AppApprovalDependencies;
}

interface AppExecutionContext {
  readonly runId: Id;
  readonly policyContext: { readonly subagent: false; readonly app: Code };
}

function appResult(text: string, isError = true) {
  return { content: [{ type: "text" as const, text }], isError };
}

/** Host-compatible callback without a dependency from core back to the host. */
export type RuntimeAppApprovalHandler = (
  call: ModelToolCall,
  decision: PolicyDecision,
  context: AppExecutionContext,
) => Promise<ReturnType<typeof appResult>>;

async function readEvents(store: EventStore, runId: Id): Promise<Event[]> {
  const events: Event[] = [];
  for await (const event of store.read(runId)) {
    events.push(event);
  }
  return events;
}

async function suspendAppCall(input: {
  readonly options: AppApprovalOptions;
  readonly dependencies: AppApprovalDependencies;
  readonly call: ModelToolCall;
  readonly decision: PolicyDecision;
  readonly runId: Id;
  readonly app: Code;
}) {
  const { options, dependencies, call, decision, runId, app } = input;
  const history = await readEvents(options.store, runId);
  const last = history.at(-1);
  if (last === undefined) {
    return { errorCode: "app_run_unavailable" };
  }
  const state = foldRunState(history);
  if (
    state.status !== "running" ||
    state.pendingApprovals.size > 0 ||
    history.some((event) => event.type === "tool_intent" && event.callId === call.callId)
  ) {
    return { errorCode: "app_run_unavailable" };
  }
  const recorder = new RunRecorder(
    options.store,
    runId,
    last.segmentId,
    state.nextSeq,
    options.clock,
  );
  const checkpointer = new Checkpointer({
    recorder,
    runId,
    context: dependencies.context,
    ids: dependencies.ids,
    clock: options.clock,
  });
  const events = await toolStep({
    recorder,
    tool: dependencies.tool,
    policy: {
      version: dependencies.policy.version,
      // Keep the host's ask decision; the actual policy is always consulted on resume.
      decide: () => decision,
    },
    app,
    ids: dependencies.ids,
    checkpointer,
    history,
    calls: [call],
    clock: options.clock,
    runId,
    signal: new AbortController().signal,
  });
  const immediate = events.find(
    (event) => event.type === "tool_result" && event.callId === call.callId,
  );
  return immediate?.type === "tool_result"
    ? { errorCode: immediate.errorCode ?? "app_tool_failed" }
    : { fromSeq: recorder.nextSeq };
}

async function waitForAppResult(store: EventStore, runId: Id, callId: Id, fromSeq: number) {
  const controller = new AbortController();
  try {
    for await (const event of store.watch(runId, { fromSeq, signal: controller.signal })) {
      if (event.type === "tool_result" && event.callId === callId) {
        return event.outcome === "ok"
          ? appResult(JSON.stringify(event.result), false)
          : appResult(event.errorCode ?? "app_tool_failed");
      }
      if (
        event.type === "run_status_changed" &&
        ["cancelled", "failed", "completed"].includes(event.to)
      ) {
        return appResult("app_run_unavailable");
      }
    }
    return appResult("app_run_unavailable");
  } finally {
    controller.abort();
  }
}

/** Creates a host callback that waits for the result produced by ordinary runtime resume. */
export function createAppApprovalHandler(options: AppApprovalOptions): RuntimeAppApprovalHandler {
  return async (proposed, proposedDecision, context) => {
    const dependencies = options.approval;
    if (dependencies?.tool.prepare === undefined) {
      return appResult("app_call_requires_approval");
    }
    const runId = Id.parse(context.runId);
    const app = Code.parse(context.policyContext.app);
    const call: ModelToolCall = {
      callId: Id.parse(proposed.callId),
      toolId: Code.parse(proposed.toolId),
      args: JsonValue.parse(proposed.args),
    };
    const decision = PolicyDecisionSchema.parse(proposedDecision);
    if (decision.decision !== "ask") {
      return appResult("policy_error");
    }
    const result = await suspendAppCall({ options, dependencies, call, decision, runId, app });
    return result.fromSeq === undefined
      ? appResult(result.errorCode)
      : waitForAppResult(options.store, runId, call.callId, result.fromSeq);
  };
}
