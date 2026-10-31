// SPDX-License-Identifier: Apache-2.0
import type { Event } from "@rovinos/schemas";
import type {
  EvalGradeRecord,
  EvalSuite,
  GraderSpec,
  GradeResult,
  TrialResult,
  GradeContext,
  TrialExecutor,
  TrialSpec,
} from "@rovinos/eval";
import type { EvalPackage } from "./eval-types.js";
import type { EvalExecutorOptions } from "./eval-executor.js";
import { judgeGrader } from "./eval-judge.js";
import type { FileCassetteStore } from "@rovinos/models";

function graderFailure(api: EvalPackage, graderId: GraderSpec["type"], code: string): GradeResult {
  return api.GradeResultSchema.parse({ graderId, pass: false, score: 0, codes: [code] });
}

interface GraderContext {
  readonly spec: GraderSpec;
  readonly task: EvalSuite["tasks"][number];
  readonly result: TrialResult;
  readonly events: readonly Event[];
}

interface TrialGrading {
  readonly api: EvalPackage;
  readonly trial: TrialSpec;
  readonly capabilities: GradeContext;
  readonly options: EvalExecutorOptions;
  readonly stores: Map<string, FileCassetteStore>;
}

async function gradeDeterministic(api: EvalPackage, context: GraderContext): Promise<GradeResult> {
  const { spec, task, result, events } = context;
  if (spec.type === "file_diff") {
    return api.createFileDiffGrader(spec).grade({ result });
  }
  if (spec.type === "no_canary_leak") {
    if ((task.canaries?.length ?? 0) === 0) {
      return graderFailure(api, spec.type, "canaries_missing");
    }
    return api
      .createNoCanaryLeakGrader({
        canaries: task.canaries ?? [],
        ...(task.workspace === undefined ? {} : { fixtureDir: task.workspace.fixtureDir }),
      })
      .grade({ result });
  }
  if (spec.type === "schema_valid") {
    return api.createSchemaValidGrader(spec).grade({ result, events });
  }
  if (spec.type === "trajectory") {
    const trajectory = api.evaluateTrajectory(events, spec.assertions, { canaries: task.canaries });
    return api.GradeResultSchema.parse({
      graderId: spec.type,
      pass: trajectory.pass,
      score: trajectory.pass ? 1 : 0,
      codes: trajectory.results.filter((item) => !item.pass).map(({ code }) => code),
    });
  }
  return graderFailure(api, spec.type, "grader_context_unavailable");
}

async function gradeSpec(spec: GraderSpec, context: TrialGrading): Promise<GradeResult> {
  const { api, trial, capabilities, options } = context;
  try {
    if (spec.type === "test_command") {
      return capabilities.backend === undefined
        ? graderFailure(api, spec.type, "eval_test_command_context_unavailable")
        : await api.createTestCommandGrader(spec).grade(capabilities);
    }
    if (spec.type === "llm_judge") {
      return await (
        await judgeGrader(api, spec, trial, { options, stores: context.stores })
      ).grade(capabilities);
    }
    return await gradeDeterministic(api, {
      spec,
      task: trial.task,
      result: capabilities.result,
      events: capabilities.events ?? [],
    });
  } catch {
    return graderFailure(
      api,
      spec.type,
      spec.type === "llm_judge" ? "judge_error" : "grader_execution_failed",
    );
  }
}

async function finishTrial(context: TrialGrading, grades: EvalGradeRecord[]): Promise<TrialResult> {
  const { api, trial, capabilities } = context;
  const graders = await Promise.all(trial.task.graders.map((spec) => gradeSpec(spec, context)));
  const usage = graders.reduce(
    (total, grade) => ({
      inputTokens: total.inputTokens + (grade.usage?.inputTokens ?? 0),
      outputTokens: total.outputTokens + (grade.usage?.outputTokens ?? 0),
      costMicros: total.costMicros + (grade.usage?.costMicros ?? 0),
    }),
    capabilities.result.usage,
  );
  // Report metrics already include trial usage; avoid adding judge usage twice.
  grades.push({
    taskId: trial.task.id,
    variantId: trial.variantId,
    trialIndex: trial.trialIndex,
    graders: graders.map((grade) =>
      api.GradeResultSchema.parse({
        graderId: grade.graderId,
        pass: grade.pass,
        score: grade.score,
        codes: grade.codes,
        ...(grade.counts === undefined ? {} : { counts: grade.counts }),
      }),
    ),
  });
  return api.TrialResultSchema.parse({ ...capabilities.result, usage });
}

/** Grades before returning each trial so judge usage participates in the scheduling cap. */
export function gradingExecutor(
  api: EvalPackage,
  executor: TrialExecutor,
  options: EvalExecutorOptions,
): { executor: TrialExecutor; grades: EvalGradeRecord[] } {
  const grades: EvalGradeRecord[] = [];
  const stores = new Map<string, FileCassetteStore>();
  const graded: TrialExecutor = {
    run: async (trial) => {
      const finish = (capabilities: GradeContext) =>
        finishTrial({ api, trial, capabilities, options, stores }, grades);
      if (executor.runWithContext !== undefined) {
        return executor.runWithContext(trial, finish);
      }
      const result = await executor.run(trial);
      return finish({ result, events: (await executor.eventsFor?.(trial)) ?? [] });
    },
    ...(executor.eventsFor === undefined
      ? {}
      : {
          eventsFor: (trial: TrialSpec) => executor.eventsFor?.(trial) ?? [],
        }),
  };
  return { executor: graded, grades };
}
