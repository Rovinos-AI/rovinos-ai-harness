// SPDX-License-Identifier: Apache-2.0
export {
  CorruptLogError,
  ReplayInputError,
  ReplayTooLargeError,
  RunNotFoundError,
  TraceAmbiguousError,
  ResolvedRunSchema,
  resolveRun,
  type ResolveRunInput,
  type ResolvedRun,
} from "./resolve.js";
export { ReplayClock } from "./ports/replay-clock.js";
export { ReplayHuman, ReplayApprovalMissingError } from "./ports/replay-human.js";
export { ReplayIdGenerator } from "./ports/replay-ids.js";
export {
  ReplayDivergenceError,
  ReplayMissingResultError,
  ReplayModelPort,
} from "./ports/replay-model.js";
export { ReplayExternalAccessError, ReplayToolPort } from "./ports/replay-tools.js";
export {
  buildReplayRuntime,
  ReplayRuntimeReportSchema,
  type BuildReplayRuntimeOptions,
  type ReplayRuntime,
  type ReplayRuntimeReport,
} from "./replay-runtime.js";
export {
  replayRun,
  ReplayOutcomeSchema,
  type ReplayOutcome,
  type ReplayRunOptions,
} from "./replay.js";
