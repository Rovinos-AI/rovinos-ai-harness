// SPDX-License-Identifier: Apache-2.0
import { FakeClock, SequentialIdGenerator, type Event, type Id } from "@rovinos/schemas";
import { createRuntime } from "@rovinos/core";
import type { Clock, ModelPort, PolicyPort, Runtime, ToolPort } from "@rovinos/core";
import { TrialResultSchema, evalSuiteCode } from "../trial.js";
import type { TrialResult, TrialSpec } from "../trial.js";
import { prepareTrial, systemClock } from "../executor.js";
import type { TrialExecutionDependencies, TrialExecutor } from "../executor.js";
import {
  captureProcessOutput,
  configureEvalTelemetry,
  setTrialProcessOutput,
} from "../execution-capture.js";
import { SimulatedHuman } from "../human.js";
import { createProviderCaptureAdapter } from "../trajectory.js";
import { executionMetricsFromEvents } from "../report/metrics.js";

/** Factories for isolated model, tool, and policy ports. */
export interface InProcessExecutorOptions extends TrialExecutionDependencies {
  readonly model?: (trial: TrialSpec) => ModelPort;
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

function trialKey(trial: TrialSpec): string {
  return `${trial.task.id}\u0000${trial.variantId}\u0000${String(trial.trialIndex)}`;
}

type RuntimeRunResult = Awaited<ReturnType<Runtime["run"]>>;

async function readTokenizedEvents(
  runtime: Runtime,
  runId: Id | undefined,
): Promise<readonly Event[]> {
  if (runId === undefined) {
    return [];
  }
  const events: Event[] = [];
  for await (const event of runtime.store.read(runId)) {
    events.push(event);
  }
  return events;
}

interface ExecutedTrialRun {
  readonly run: RuntimeRunResult;
  readonly runId?: Id;
  readonly human?: SimulatedHuman;
  readonly maxResumesExceeded: boolean;
}

async function executeTrialRun(runtime: Runtime, trial: TrialSpec): Promise<ExecutedTrialRun> {
  const goal =
    trial.task.input.metadata === undefined
      ? { goal: trial.task.input.goal }
      : { goal: trial.task.input.goal, metadata: trial.task.input.metadata };
  const hasContextStrategy =
    trial.variant.contextStrategy !== undefined || trial.task.contextStrategy !== undefined;
  let run = await runtime.run(goal, {
    ...(hasContextStrategy ? { role: "eval" } : {}),
    evalMetadata: {
      suite: evalSuiteCode(trial.suite),
      task: trial.task.id,
      trial: trial.trialIndex,
    },
  });
  const runId = run.events[0]?.runId;
  const human =
    trial.task.human === undefined ? undefined : new SimulatedHuman(trial.task.human, runtime);
  if (human === undefined || runId === undefined) {
    return {
      run,
      ...(runId === undefined ? {} : { runId }),
      ...(human === undefined ? {} : { human }),
      maxResumesExceeded: false,
    };
  }
  const humanResult = await human.runUntilSettled(runId, run.status, async () => {
    run = await runtime.resume(runId);
    return run.status;
  });
  return {
    run,
    runId,
    human,
    maxResumesExceeded: humanResult.maxResumesExceeded,
  };
}

function trialResult(
  prepared: Awaited<ReturnType<typeof prepareTrial>>,
  startedAt: number,
  clock: Clock,
  executed: ExecutedTrialRun,
): TrialResult {
  const { run, human, maxResumesExceeded } = executed;
  let errorCode: string | undefined;
  if (maxResumesExceeded) {
    errorCode = "human_max_resumes_exceeded";
  } else if (run.status === "pending" || run.status === "running") {
    errorCode = "trial_unsettled";
  }
  return TrialResultSchema.parse({
    status: maxResumesExceeded ? "error" : resultStatus(run.status),
    ...(executed.runId === undefined ? {} : { runId: executed.runId }),
    dbPath: prepared.dbPath,
    workspaceDir: prepared.workspaceDir,
    durationMs: Math.max(0, Math.floor(clock.now() - startedAt)),
    usage: run.state.usage,
    metrics: executionMetricsFromEvents(run.events, run.state.steps),
    approvals: human?.counts ?? { approved: 0, denied: 0, edited: 0 },
    unsafeAutoApprove: human?.unsafeAutoApprove ?? false,
    exitCode: run.status === "completed" && !maxResumesExceeded ? 0 : 1,
    ...(errorCode === undefined ? {} : { errorCode }),
  });
}

/**
 * Runs trials in the host process using an injected fake or cassette-aware model.
 *
 * @param options - Fresh factories for test tools, models, and policy per trial.
 */
export class InProcessExecutor implements TrialExecutor {
  private readonly trialEvents = new Map<string, readonly Event[]>();

  constructor(private readonly options: InProcessExecutorOptions) {}

  /** Returns the tokenized event log kept in memory for grading and cassette recording. */
  eventsFor(trial: TrialSpec): readonly Event[] {
    return this.trialEvents.get(trialKey(trial)) ?? [];
  }

  /** {@inheritDoc TrialExecutor.run} */
  async run(trial: TrialSpec): Promise<TrialResult> {
    configureEvalTelemetry(this.options.exportTelemetry);
    const clock = this.options.clock ?? systemClock;
    const startedAt = clock.now();
    const prepared = await prepareTrial(trial, this.options);
    const runtime = await createRuntime(prepared.runtimeConfig, {
      dataDir: prepared.dataDir,
      transientVault: false,
      clock: new FakeClock(1_700_000_000_000 + trial.seed),
      ids: new SequentialIdGenerator(),
      ...(this.options.model === undefined
        ? {}
        : {
            model: createProviderCaptureAdapter(
              this.options.model(trial),
              trial.task.canaries ?? [],
            ),
          }),
      ...(this.options.tool === undefined ? {} : { tool: this.options.tool(trial) }),
      ...(this.options.policy === undefined ? {} : { policy: this.options.policy(trial) }),
      secretResolver: {
        resolve: (reference, signal) =>
          reference === "env:HARNESS_EVAL_KEY"
            ? Promise.resolve({ reveal: () => prepared.key })
            : (this.options.secretResolver?.resolve(reference, signal) ??
              Promise.reject(
                Object.assign(new Error("secret_unavailable"), { code: "secret_unavailable" }),
              )),
      },
    });

    let result: TrialResult;
    let events: readonly Event[] = [];
    try {
      const captured = await captureProcessOutput(
        () => {
          return executeTrialRun(runtime, trial).then(async (executed) => {
            events = await readTokenizedEvents(runtime, executed.runId);
            return trialResult(prepared, startedAt, clock, executed);
          });
        },
        (stdout, stderr) => {
          setTrialProcessOutput(prepared.dbPath, stdout, stderr);
        },
      );
      result = captured.result;
    } finally {
      await runtime.close();
    }
    this.trialEvents.set(trialKey(trial), events);
    return result;
  }
}
