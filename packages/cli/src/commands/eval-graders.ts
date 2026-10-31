// SPDX-License-Identifier: Apache-2.0
import type { Event } from "@rovinos/schemas";
import type { EvalSuite } from "@rovinos/eval";
import type { EvalPackage } from "./eval-types.js";

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

/** Grades completed records using metadata, trial events, and deterministic graders. */
export async function gradeRecords(
  api: EvalPackage,
  suite: EvalSuite,
  records: ReturnType<EvalPackage["parseEvalTrialJsonl"]>,
  eventsByTrial: ReadonlyMap<string, readonly Event[]>,
) {
  return Promise.all(
    records.map(async (record) => {
      const task = suite.tasks.find((candidate) => candidate.id === record.taskId);
      if (task === undefined) {
        return undefined;
      }
      if (record.result.status === "skipped_budget") {
        return {
          taskId: record.taskId,
          variantId: record.variantId,
          trialIndex: record.trialIndex,
          graders: [],
        };
      }
      const events =
        eventsByTrial.get(
          `${record.taskId}\u0000${record.variantId}\u0000${String(record.trialIndex)}`,
        ) ?? [];
      const graders = await Promise.all(
        task.graders.map(async (spec) => {
          if (spec.type === "file_diff") {
            try {
              return await api.createFileDiffGrader(spec).grade({ result: record.result });
            } catch {
              return api.GradeResultSchema.parse({
                graderId: "file_diff",
                pass: false,
                score: 0,
                codes: ["grader_execution_failed"],
              });
            }
          }
          if (spec.type === "no_canary_leak" && (task.canaries?.length ?? 0) > 0) {
            try {
              return await api
                .createNoCanaryLeakGrader({
                  canaries: task.canaries ?? [],
                  ...(task.workspace === undefined ? {} : { fixtureDir: task.workspace.fixtureDir }),
                })
                .grade({ result: record.result });
            } catch {
              return api.GradeResultSchema.parse({
                graderId: "no_canary_leak",
                pass: false,
                score: 0,
                codes: ["grader_execution_failed"],
              });
            }
          }
          if (spec.type === "schema_valid") {
            return api.createSchemaValidGrader(spec).grade({ result: record.result, events });
          }
          if (spec.type === "trajectory") {
            const trajectory = api.evaluateTrajectory(events, spec.assertions, {
              canaries: task.canaries,
            });
            const codes = trajectory.results.filter((item) => !item.pass).map(({ code }) => code);
            return api.GradeResultSchema.parse({
              graderId: "trajectory",
              pass: trajectory.pass,
              score: trajectory.pass ? 1 : 0,
              codes,
            });
          }
          return api.GradeResultSchema.parse({
            graderId: spec.type,
            pass: false,
            score: 0,
            codes: ["canaries_missing"],
          });
        }),
      );
      return {
        taskId: record.taskId,
        variantId: record.variantId,
        trialIndex: record.trialIndex,
        graders,
      };
    }),
  ).then((grades) => grades.filter((grade) => grade !== undefined));
}
