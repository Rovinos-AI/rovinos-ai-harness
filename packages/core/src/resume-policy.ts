// SPDX-License-Identifier: Apache-2.0
import type { Id, RunResumePolicySchema } from "@rovinos/schemas";
import type { InputRequestedEvent, RunState, ToolIntentEvent } from "./run-state.js";
import type { ModelToolCall, ToolExecutionResult, ToolPort } from "./ports.js";
import type { z } from "zod";

/** Policy selected for a dangling non-idempotent tool intent. */
export type ResumePolicy = z.infer<typeof RunResumePolicySchema>;

/** Optional completion metadata recorded before a recovered tool result. */
export interface ToolResumeCompletion {
  readonly childRunId: Id;
  readonly outcome: "completed" | "failed" | "cancelled";
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly steps?: number;
  readonly costMicros?: number;
}

/** Result of reconciling a dangling intent with tool-specific durable state. */
export type ToolResumeDecision =
  | { readonly kind: "rerun" }
  | { readonly kind: "shutdown" }
  | {
      readonly kind: "result";
      readonly execution: ToolExecutionResult;
      readonly completion?: ToolResumeCompletion;
    }
  | { readonly kind: "suspend" };

/** State available to a tool-specific resume strategy. */
export interface ToolResumeContext {
  readonly runId: Id;
  readonly signal: AbortSignal;
  readonly toolRegistry: ToolPort;
}

/** Resolves dangling intents using tool-specific durable recovery semantics. */
export interface ToolResumeStrategy {
  onDanglingIntent(
    call: ModelToolCall,
    state: RunState,
    context: ToolResumeContext,
  ): Promise<ToolResumeDecision>;
}

/** Decision for one tool intent that has no recorded result. */
export type DanglingIntentAction =
  | { readonly kind: "rerun"; readonly callId: ToolIntentEvent["callId"] }
  | { readonly kind: "retry_input"; readonly callId: ToolIntentEvent["callId"] }
  | { readonly kind: "strategy"; readonly callId: ToolIntentEvent["callId"] }
  | { readonly kind: "escalate"; readonly callId: ToolIntentEvent["callId"] }
  | {
      readonly kind: "fail";
      readonly callId: ToolIntentEvent["callId"];
      readonly errorCode: "unknown_tool" | "resume_ambiguous" | "pii_blocked";
    };

function hasUnsentResolvedInputRound(options: {
  readonly state: RunState;
  readonly intent: ToolIntentEvent;
  readonly latestRound: number;
  readonly latestInputs: readonly InputRequestedEvent[];
  readonly initialAttempt: number;
  readonly legacyRetryAllowed: boolean;
}): boolean {
  const { state, intent, latestRound, latestInputs, initialAttempt, legacyRetryAllowed } = options;
  return (
    latestInputs.length > 0 &&
    latestInputs.every(({ requestId }) => state.resolvedInputs.has(requestId)) &&
    (legacyRetryAllowed || latestInputs.every(({ source }) => source !== "mcp_legacy")) &&
    (state.toolExecutionAttempts.get(intent.callId) ?? 0) <= initialAttempt + latestRound - 1
  );
}

/**
 * Plans how to handle tool intents without results, preserving the state map's order.
 *
 * Unknown tools fail closed. Non-idempotent tools escalate by default so no
 * potentially duplicated side effect occurs without a human decision.
 *
 * @param state - Folded run state containing unresolved tool intents.
 * @param toolPort - Port used to inspect tool idempotency declarations.
 * @param policy - Action for a known non-idempotent tool; defaults to escalation.
 * @returns One action per dangling intent, in event order.
 */
export function planDanglingIntents(
  state: RunState,
  toolPort: ToolPort,
  policy: ResumePolicy = "escalate",
): DanglingIntentAction[] {
  return Array.from(state.pendingToolCalls.values(), (intent) => {
    const description = toolPort.describe(intent.toolId, intent.args);
    if (description === undefined) {
      return { kind: "fail", callId: intent.callId, errorCode: "unknown_tool" };
    }
    if (intent.policyDecision === "deny") {
      return { kind: "fail", callId: intent.callId, errorCode: "pii_blocked" };
    }
    const resumeStrategy = toolPort.resumeStrategy?.(intent.toolId);
    const inputRequests = Array.from(state.inputRequests.values()).filter(
      (request) => request.callId === intent.callId,
    );
    const latestRound = Math.max(-1, ...inputRequests.map(({ round }) => round));
    const latestInputs = inputRequests.filter(({ round }) => round === latestRound);
    const initialAttempt =
      resumeStrategy !== undefined || (intent.idempotent && description.idempotent) ? 0 : 1;
    if (
      hasUnsentResolvedInputRound({
        state,
        intent,
        latestRound,
        latestInputs,
        initialAttempt,
        legacyRetryAllowed: intent.idempotent && description.idempotent,
      })
    ) {
      return { kind: "retry_input", callId: intent.callId };
    }
    if (intent.policyDecision === "ask") {
      return { kind: "escalate", callId: intent.callId };
    }
    if (resumeStrategy !== undefined) {
      return { kind: "strategy", callId: intent.callId };
    }
    if (intent.idempotent && description.idempotent) {
      return { kind: "rerun", callId: intent.callId };
    }
    if (policy === "fail") {
      return { kind: "fail", callId: intent.callId, errorCode: "resume_ambiguous" };
    }
    return { kind: "escalate", callId: intent.callId };
  });
}
