// SPDX-License-Identifier: Apache-2.0
import { Code } from "@rovinos/schemas";
import {
  getApprovalWaitHistogram,
  getModelLatencyHistogram,
  getRunCompletedCounter,
  getToolCallsCounter,
} from "./metrics.js";
import { safelyRecordMetric } from "./metric-safety.js";
import type {
  ApprovalDecision,
  RunCompletionOutcome,
  ToolCallOutcome,
} from "./metric-attributes.js";

/** Counts one run entering a terminal state. */
export function countCompletedRun(outcome: RunCompletionOutcome): void {
  safelyRecordMetric(() => {
    getRunCompletedCounter().add(1, { "harness.execution.outcome": outcome });
  });
}

/** Records one model response latency using its configured provider and model codes. */
export function recordModelLatency(latencyMs: number, provider: string, model: string): void {
  if (!Number.isFinite(latencyMs) || latencyMs < 0) {
    return;
  }
  safelyRecordMetric(() => {
    getModelLatencyHistogram().record(latencyMs, {
      "harness.model.provider": Code.parse(provider),
      "harness.model.name": Code.parse(model),
    });
  });
}

/** Records one resolved approval wait using its bounded decision. */
export function recordApprovalWait(waitMs: number, decision: ApprovalDecision): void {
  if (!Number.isFinite(waitMs) || waitMs < 0) {
    return;
  }
  safelyRecordMetric(() => {
    getApprovalWaitHistogram().record(waitMs, { "harness.approval.wait_ms.decision": decision });
  });
}

/** Counts one recorded tool result using its bounded outcome. */
export function countToolCall(outcome: ToolCallOutcome): void {
  safelyRecordMetric(() => {
    getToolCallsCounter().add(1, { "harness.tool.calls.outcome": outcome });
  });
}
