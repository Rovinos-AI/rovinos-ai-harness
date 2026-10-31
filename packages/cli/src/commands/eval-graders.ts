// SPDX-License-Identifier: Apache-2.0
import type { Event } from "@rovinos/schemas";
import type {
  EvalGradeRecord,
  EvalSuite,
  GraderSpec,
  GradeResult,
  TrialResult,
} from "@rovinos/eval";
import type { EvalPackage } from "./eval-types.js";

type TrialRecords = ReturnType<EvalPackage["parseEvalTrialJsonl"]>;

/** Returns the first grader requiring a capability not exposed by the CLI executor contract. */
export function unavailableGrader(suite: EvalSuite): "test_command" | "llm_judge" | undefined {
  for (const task of suite.tasks) {
    for (const grader of task.graders) {
      if (grader.type === "test_command" || grader.type === "llm_judge") {
        return grader.type;
      }
    }
  }
  return undefined;
}

function graderFailure(api: EvalPackage, graderId: GraderSpec["type"], code: string): GradeResult {
  return api.GradeResultSchema.parse({
    graderId,
    pass: false,
    score: 0,
    codes: [code],
  });
}

interface GraderContext {
  readonly spec: GraderSpec;
  readonly task: EvalSuite["tasks"][number];
  readonly result: TrialResult;
  readonly events: readonly Event[];
}

async function gradeSpec(api: EvalPackage, context: GraderContext): Promise<GradeResult> {
  const { spec, task, result, events } = context;
  if (spec.type === "file_diff") {
    try {
      return await api.createFileDiffGrader(spec).grade({ result });
    } catch {
      return graderFailure(api, spec.type, "grader_execution_failed");
    }
  }
  if (spec.type === "no_canary_leak") {
    if ((task.canaries?.length ?? 0) === 0) {
      return graderFailure(api, spec.type, "canaries_missing");
    }
    try {
      return await api
        .createNoCanaryLeakGrader({
          canaries: task.canaries ?? [],
          ...(task.workspace === undefined ? {} : { fixtureDir: task.workspace.fixtureDir }),
        })
        .grade({ result });
    } catch {
      return graderFailure(api, spec.type, "grader_execution_failed");
    }
  }
  if (spec.type === "schema_valid") {
    return api.createSchemaValidGrader(spec).grade({ result, events });
  }
  if (spec.type === "trajectory") {
    const trajectory = api.evaluateTrajectory(events, spec.assertions, {
      canaries: task.canaries,
    });
    const codes = trajectory.results.filter((item) => !item.pass).map(({ code }) => code);
    return api.GradeResultSchema.parse({
      graderId: spec.type,
      pass: trajectory.pass,
      score: trajectory.pass ? 1 : 0,
      codes,
    });
  }
  return graderFailure(api, spec.type, "grader_context_unavailable");
}

async function gradeRecord(
  api: EvalPackage,
  suite: EvalSuite,
  record: TrialRecords[number],
  eventsByTrial: ReadonlyMap<string, readonly Event[]>,
): Promise<EvalGradeRecord | undefined> {
  const task = suite.tasks.find((candidate) => candidate.id === record.taskId);
  if (task === undefined) {
    return undefined;
  }
  const gradeBase = {
    taskId: record.taskId,
    variantId: record.variantId,
    trialIndex: record.trialIndex,
  };
  if (record.result.status === "skipped_budget") {
    return { ...gradeBase, graders: [] };
  }
  const key = `${record.taskId}\u0000${record.variantId}\u0000${String(record.trialIndex)}`;
  const events = eventsByTrial.get(key) ?? [];
  const graders = await Promise.all(
    task.graders.map((spec) => gradeSpec(api, { spec, task, result: record.result, events })),
  );
  return { ...gradeBase, graders };
}

/** Grades completed records using metadata, trial events, and deterministic graders. */
export async function gradeRecords(
  api: EvalPackage,
  suite: EvalSuite,
  records: TrialRecords,
  eventsByTrial: ReadonlyMap<string, readonly Event[]>,
): Promise<EvalGradeRecord[]> {
  const grades = await Promise.all(
    records.map((record) => gradeRecord(api, suite, record, eventsByTrial)),
  );
  return grades.filter((grade): grade is EvalGradeRecord => grade !== undefined);
}
