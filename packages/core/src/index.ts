// SPDX-License-Identifier: Apache-2.0
export {
  canTransition,
  RUN_TRIGGERS,
  transition,
  type RunTrigger,
  type TransitionResult,
} from "./state-machine.js";
export {
  CorruptLogError,
  foldRunState,
  type ApprovalRequestedEvent,
  type RunState,
  type ToolIntentEvent,
} from "./run-state.js";
export {
  BudgetTracker,
  type BudgetCheck,
  type BudgetKind,
  type BudgetViolation,
} from "./budgets.js";
export {
  LeaseLostError,
  RunRecorder,
  SpanContextMissingError,
  type Clock,
  type EventPartial,
} from "./recorder.js";
export {
  APPROVAL_WAIT_SPAN,
  CHECKPOINT_SPAN,
  COMPACTION_SPAN,
  MODEL_CALL_SPAN,
  RUN_SPAN,
  TOOL_CALL_SPAN,
} from "./spans.js";
export { runLoop, type RunLoopOptions, type RunLoopResult } from "./loop.js";
export { modelStep, type ModelStepOptions, type ModelStepResult } from "./steps/model-step.js";
export {
  applyDanglingIntents,
  resolveDanglingIntentApproval,
  ResumeActionMismatchError,
  toolStep,
  type ResumeToolStepOptions,
  type ToolStepOptions,
} from "./steps/tool-step.js";
export {
  planDanglingIntents,
  type DanglingIntentAction,
  type ResumePolicy,
} from "./resume-policy.js";
export type {
  ContextPort,
  IdGenerator,
  ModelCompletion,
  ModelPort,
  ModelRequest,
  ModelToolCall,
  ModelUsage,
  NewRunMetadata,
  RunContext,
  ToolDescription,
  ToolExecutionResult,
  ToolPort,
} from "./ports.js";
export { NaiveContext } from "./context/naive-context.js";
