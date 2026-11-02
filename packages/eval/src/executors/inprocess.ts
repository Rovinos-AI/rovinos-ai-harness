// SPDX-License-Identifier: Apache-2.0
import { Code, FakeClock, SequentialIdGenerator, type Event, type Id } from "@rovinos/schemas";
import { createRuntime } from "@rovinos/core";
import type { Clock, ModelPort, PolicyPort, Runtime, ToolPort } from "@rovinos/core";
import { TrialResultSchema, evalSuiteCode } from "../trial.js";
import type { TrialResult, TrialSpec } from "../trial.js";
import { prepareTrial, systemClock } from "../executor.js";
import type { PreparedTrial, TrialExecutionDependencies, TrialExecutor } from "../executor.js";
import {
  captureProcessOutput,
  configureEvalTelemetry,
  setTrialProcessOutput,
} from "../execution-capture.js";
import { SimulatedHuman } from "../human.js";
import { createProviderCaptureAdapter } from "../trajectory.js";
import { executionMetricsFromEvents } from "../report/metrics.js";
import { cp } from "node:fs/promises";
import { join } from "node:path";
import { ensureRunWorkspace } from "@rovinos/sandbox";
import type { GradeContext } from "../graders/types.js";

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

function failureCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  const parsed = Code.safeParse(error.code);
  return parsed.success ? parsed.data : undefined;
}

type RuntimeRunResult = Awaited<ReturnType<Runtime["run"]>>;

async function prepareRuntimeWorkspace(prepared: PreparedTrial, runId: Id): Promise<string> {
  const workspace = await ensureRunWorkspace(join(prepared.dataDir, "workspaces"), runId);
  await cp(prepared.workspaceDir, workspace, { recursive: true });
  return workspace;
}

async function finishWithBackend(
  runtime: Runtime,
  runId: Id,
  finish: (context: GradeContext) => Promise<TrialResult>,
  context: GradeContext,
): Promise<TrialResult> {
  await runtime.sandboxBackend.acquireLease?.(runId);
  try {
    return await finish(context);
  } finally {
    await runtime.sandboxBackend.releaseLease?.(runId);
  }
}

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

async function executeTrialRun(
  runtime: Runtime,
  trial: TrialSpec,
  runId: Id,
): Promise<ExecutedTrialRun> {
  const goal =
    trial.task.input.metadata === undefined
      ? { goal: trial.task.input.goal }
      : { goal: trial.task.input.goal, metadata: trial.task.input.metadata };
  const hasContextStrategy =
    trial.variant.contextStrategy !== undefined || trial.task.contextStrategy !== undefined;
  let run = await runtime.start(goal, {
    runId,
    ...(hasContextStrategy ? { role: "eval" } : {}),
    evalMetadata: {
      suite: evalSuiteCode(trial.suite),
      task: trial.task.id,
      trial: trial.trialIndex,
    },
  }).completion;
  const human =
    trial.task.human === undefined ? undefined : new SimulatedHuman(trial.task.human, runtime);
  if (human === undefined) {
    return {
      run,
      runId,
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
    return this.runWithContext(trial, (context) => Promise.resolve(context.result));
  }

  /** Grades while the backend is alive, against the workspace used by the run. */
  async runWithContext(
    trial: TrialSpec,
    finish: (context: GradeContext) => Promise<TrialResult>,
  ): Promise<TrialResult> {
    configureEvalTelemetry(this.options.exportTelemetry);
    const clock = this.options.clock ?? systemClock;
    const startedAt = clock.now();
    const prepared = await prepareTrial(trial, this.options);
    const ids = new SequentialIdGenerator();
    const runId = ids.next();
    const workspaceDir = await prepareRuntimeWorkspace(prepared, runId);
    let modelFailureCode: string | undefined;
    const model = this.options.model?.(trial);
    const runtime = await createRuntime(prepared.runtimeConfig, {
      dataDir: prepared.dataDir,
      transientVault: false,
      clock: new FakeClock(1_700_000_000_000 + trial.seed),
      ids,
      ...(model === undefined
        ? {}
        : {
            model: createProviderCaptureAdapter(
              {
                complete: async (request, context) => {
                  try {
                    return await model.complete(request, context);
                  } catch (error) {
                    modelFailureCode = failureCode(error);
                    throw error;
                  }
                },
              },
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
          return executeTrialRun(runtime, trial, runId).then(async (executed) => {
            events = await readTokenizedEvents(runtime, executed.runId);
            const outcome = TrialResultSchema.parse({
              ...trialResult(prepared, startedAt, clock, executed),
              workspaceDir,
              ...(modelFailureCode === undefined ? {} : { errorCode: modelFailureCode }),
            });
            return finishWithBackend(runtime, runId, finish, {
              result: outcome,
              events,
              backend: runtime.sandboxBackend,
            });
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
    if (modelFailureCode !== undefined && result.status !== "completed") {
      result = TrialResultSchema.parse({ ...result, errorCode: modelFailureCode });
    }
    this.trialEvents.set(trialKey(trial), events);
    return result;
  }
}
