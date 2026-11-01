// SPDX-License-Identifier: Apache-2.0
export { defineSuite, loadSuite, type LoadSuiteOptions } from "./load.js";
export {
  EvalSuiteSchema,
  EvalTaskSchema,
  GraderSpecSchema,
  JudgeCriterionSchema,
  JudgeRubricSchema,
  LlmJudgeGraderSpecSchema,
  HumanScriptSchema,
  TrajectoryAssertionSchema,
  type EvalSuite,
  type EvalTask,
  type GraderSpec,
  type JudgeCriterion,
  type LlmJudgeGraderSpec,
  type HumanScript,
  type TrajectoryAssertion,
} from "./schema.js";
export {
  createCanaries,
  scanForCanaries,
  CanarySetSchema,
  CanarySinkSchema,
  CanaryValueSchema,
  type CanarySet,
  type CanarySink,
  type CanaryValue,
} from "./canary.js";
export {
  EvalCassetteModeSchema,
  EvalTrialRecordSchema,
  EvalVariantSchema,
  TrialResultSchema,
  TrialSpecSchema,
  TrialUsageSchema,
  ApprovalCountsSchema,
  InputCountsSchema,
  TrialExecutionMetricsSchema,
  EvalVariantsFileSchema,
  parseEvalVariants,
  type EvalVariant,
  type EvalVariantsFile,
  type EvalTrialRecord,
  type ApprovalCounts,
  type InputCounts,
  type TrialExecutionMetrics,
  type TrialResult,
  type TrialSpec,
  evalSuiteCode,
} from "./trial.js";
export {
  TrialConfigSchema,
  TrialEvalOptionsSchema,
  prepareTrial,
  type PreparedTrial,
  type TrialConfig,
  type TrialEvalOptions,
  type TrialExecutor,
  type TrialExecutionDependencies,
} from "./executor.js";
export { InProcessExecutor, type InProcessExecutorOptions } from "./executors/inprocess.js";
export { SimulatedHuman, SimulatedHumanError, type SimulatedHumanRunResult } from "./human.js";
export {
  DockerExecutor,
  DockerExecutorError,
  type DockerExecutorErrorCode,
  type DockerExecutorOptions,
} from "./executors/docker.js";
export {
  createFileDiffGrader,
  createNoCanaryLeakGrader,
  buildJudgeView,
  createLlmJudgeGrader,
  createJudgeVerdictSchema,
  JudgeViewSchema,
  createSchemaValidGrader,
  createTestCommandGrader,
  GradeResultSchema,
  NoCanaryLeakGraderOptionsSchema,
  type GradeContext,
  type GradeResult,
  type Grader,
  type NoCanaryLeakGraderOptions,
  type JudgeView,
  type LlmJudgeGraderOptions,
} from "./graders/index.js";
export {
  evaluateTrajectory,
  TrajectoryAssertionResultSchema,
  TrajectoryContextSchema,
  TrajectoryResultSchema,
  type TrajectoryContext,
  type TrajectoryResult,
} from "./trajectory.js";
export {
  EvalRunnerError,
  runEval,
  type EvalRunnerErrorCode,
  type EvalRunResult,
  type RunnerDependencies,
  type RunnerOptions,
} from "./runner.js";
export {
  EvalGradeRecordSchema,
  EvalReportInputSchema,
  EvalTrialMetricsSchema,
  MetricSummarySchema,
  PassAtKSchema,
  EvalAggregateSchema,
  EvalReportSchema,
  type EvalGradeRecord,
  type EvalTrialMetrics,
  type MetricSummary,
  type PassAtK,
  type EvalAggregate,
  type EvalReport,
} from "./report/schema.js";
export {
  computeTrialMetrics,
  executionMetricsFromEvents,
  parseEvalTrialJsonl,
} from "./report/metrics.js";
export { passAtK, summarize, aggregateEvalMetrics } from "./report/aggregate.js";
export { buildEvalReport, serializeEvalReport } from "./report/json.js";
export { renderMarkdownReport } from "./report/markdown.js";
export { renderJunitReport } from "./report/junit.js";
export {
  bootstrapMeanDifference,
  BootstrapMeanDifferenceSchema,
  fisherExactTest,
  holmBonferroni,
  SeededRandom,
  type BootstrapMeanDifference,
  type ContingencyTable,
} from "./stats.js";
export {
  compareEvalReports,
  EvalComparisonMetricSchema,
  EvalComparisonReportSchema,
  EvalComparisonSchema,
  renderComparisonTable,
  type ComparisonOptions,
  type EvalComparison,
  type EvalComparisonMetric,
  type EvalComparisonReport,
} from "./report/compare.js";
