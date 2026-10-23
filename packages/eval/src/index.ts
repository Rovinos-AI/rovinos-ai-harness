// SPDX-License-Identifier: Apache-2.0
export { defineSuite, loadSuite, type LoadSuiteOptions } from "./load.js";
export {
  EvalSuiteSchema,
  EvalTaskSchema,
  GraderSpecSchema,
  HumanScriptSchema,
  TrajectoryAssertionSchema,
  type EvalSuite,
  type EvalTask,
  type GraderSpec,
  type HumanScript,
  type TrajectoryAssertion,
} from "./schema.js";
export {
  EvalCassetteModeSchema,
  EvalVariantSchema,
  TrialResultSchema,
  TrialSpecSchema,
  TrialUsageSchema,
  type EvalVariant,
  type TrialResult,
  type TrialSpec,
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
export {
  DockerExecutor,
  DockerExecutorError,
  type DockerExecutorErrorCode,
  type DockerExecutorOptions,
} from "./executors/docker.js";
export { runEval, type EvalRunResult, type RunnerOptions } from "./runner.js";
