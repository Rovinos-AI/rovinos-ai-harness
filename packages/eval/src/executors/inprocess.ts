// SPDX-License-Identifier: Apache-2.0
import { FakeClock, SequentialIdGenerator } from "@rovinos/schemas";
import { createRuntime } from "@rovinos/core";
import type { ModelPort, PolicyPort, ToolPort } from "@rovinos/core";
import { TrialResultSchema } from "../trial.js";
import type { TrialResult, TrialSpec } from "../trial.js";
import { prepareTrial, systemClock } from "../executor.js";
import type { TrialExecutionDependencies, TrialExecutor } from "../executor.js";

/** Factories for isolated model, tool, and policy ports. */
export interface InProcessExecutorOptions extends TrialExecutionDependencies {
  readonly model: (trial: TrialSpec) => ModelPort;
  readonly tool?: (trial: TrialSpec) => ToolPort;
  readonly policy?: (trial: TrialSpec) => PolicyPort;
}

function resultStatus(status: string): TrialResult["status"] {
  if (
    status === "completed" ||
    status === "failed" ||
    status === "suspended" ||
    status === "cancelled"
  ) {
    return status;
  }
  return "error";
}

/**
 * Runs trials in the host process using an injected fake or cassette-aware model.
 *
 * @param options - Fresh factories for test tools, models, and policy per trial.
 */
export class InProcessExecutor implements TrialExecutor {
  constructor(private readonly options: InProcessExecutorOptions) {}

  /** {@inheritDoc TrialExecutor.run} */
  async run(trial: TrialSpec): Promise<TrialResult> {
    const clock = this.options.clock ?? systemClock;
    const startedAt = clock.now();
    const prepared = await prepareTrial(trial, this.options);
    const runtime = await createRuntime(prepared.runtimeConfig, {
      dataDir: prepared.dataDir,
      transientVault: false,
      clock: new FakeClock(1_700_000_000_000 + trial.seed),
      ids: new SequentialIdGenerator(),
      model: this.options.model(trial),
      ...(this.options.tool === undefined ? {} : { tool: this.options.tool(trial) }),
      ...(this.options.policy === undefined ? {} : { policy: this.options.policy(trial) }),
      secretResolver: {
        resolve: (reference) =>
          reference === "env:HARNESS_EVAL_KEY"
            ? Promise.resolve({ reveal: () => prepared.key })
            : Promise.reject(
                Object.assign(new Error("secret_unavailable"), { code: "secret_unavailable" }),
              ),
      },
    });

    try {
      const goal =
        trial.task.input.metadata === undefined
          ? { goal: trial.task.input.goal }
          : { goal: trial.task.input.goal, metadata: trial.task.input.metadata };
      const hasContextStrategy =
        trial.variant.contextStrategy !== undefined || trial.task.contextStrategy !== undefined;
      const run = await runtime.run(goal, hasContextStrategy ? { role: "eval" } : {});
      const runId = run.events[0]?.runId;
      const durationMs = Math.max(0, Math.floor(clock.now() - startedAt));
      const result: TrialResult = {
        status: resultStatus(run.status),
        ...(runId === undefined ? {} : { runId }),
        dbPath: prepared.dbPath,
        workspaceDir: prepared.workspaceDir,
        durationMs,
        usage: run.state.usage,
        exitCode: run.status === "completed" ? 0 : 1,
        ...(run.status === "pending" || run.status === "running"
          ? { errorCode: "trial_unsettled" }
          : {}),
      };
      return TrialResultSchema.parse(result);
    } finally {
      await runtime.close();
    }
  }
}
