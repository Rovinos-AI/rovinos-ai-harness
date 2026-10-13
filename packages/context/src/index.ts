// SPDX-License-Identifier: Apache-2.0
export {
  ContextBudgetSchema,
  ComparisonSchema,
  CompactedRangeSchema,
  ContextResultSchema,
  ContextSnapshotSchema,
  ContextStatsSchema,
  TranscriptGroupSchema,
  TranscriptSchema,
  type ContextBudget,
  type Comparison,
  type CompactedRange,
  type ContextResult,
  type ContextSnapshot,
  type ContextStats,
  type ContextStrategy,
  type ContextStrategyInput,
  type TokenCounter,
  type Transcript,
  type TranscriptGroup,
  StrategyComparisonReportSchema,
  StrategyCoverageSchema,
  type StrategyComparisonReport,
  type StrategyCoverage,
} from "./types.js";
export { eventsToTranscript } from "./transcript.js";
export { compareStrategies, coverage } from "./compare.js";
export { createStrategyRegistry, lookupContextStrategy } from "./registry.js";
export {
  PlanSchema,
  UpdatePlanInputSchema,
  createPlanReducerState,
  derivePlan,
  planReducer,
  type Plan,
  type PlanReducerState,
} from "./plan.js";
export {
  PlanToolPort,
  READ_PLAN_TOOL_SPEC,
  UPDATE_PLAN_TOOL_SPEC,
  type PlanToolCall,
  type PlanToolDescription,
  type PlanToolExecutionResult,
  type PlanToolPortLike,
  type PlanToolRunContext,
} from "./builtin-tools.js";
export { NaiveStrategy } from "./strategies/naive.js";
export {
  ContextMarkerExceedsBudgetError,
  ContextPinnedExceedsBudgetError,
  SlidingWindowStrategy,
} from "./strategies/sliding-window.js";
export { SummarizingStrategy, type SummarizingStrategyOptions } from "./strategies/summarizing.js";
export {
  InMemoryWorkspace,
  OffloadedHandleSchema,
  OffloadedStub,
  OffloadingToolOptionsSchema,
  OffloadingToolPort,
  READ_OFFLOADED_TOOL_SPEC,
  ReadOffloadedInputSchema,
  ReadOffloadedResultSchema,
  WorkspaceFileNotFoundError,
  WorkspacePathError,
  type OffloadIdGenerator,
  type OffloadedHandle,
  type OffloadedStub as OffloadedStubValue,
  type OffloadingToolOptions,
  type OffloadRunContext,
  type OffloadToolCall,
  type OffloadToolDescription,
  type OffloadToolExecutionResult,
  type OffloadToolPortLike,
  type ReadOffloadedResult,
  type WorkspacePort,
  type WorkspaceReadRange,
} from "./offload.js";
export {
  CalibrationSnapshotSchema,
  CalibratingTokenCounter,
  HeuristicTokenCounter,
  type CalibrationSnapshot,
} from "./token-counter.js";
