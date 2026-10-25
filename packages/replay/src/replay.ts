// SPDX-License-Identifier: Apache-2.0
import { context, ROOT_CONTEXT, TraceFlags, trace } from "@opentelemetry/api";
import { foldRunState, type Runtime, type RuntimeConfig } from "@rovinos/core";
import { attr, defineSpan, safeRecordError } from "@rovinos/telemetry";
import {
  Event,
  Id,
  RunStatus,
  TraceId,
  type Event as EventValue,
  type Id as IdValue,
} from "@rovinos/schemas";
import type { EventStore } from "@rovinos/store";
import { z } from "zod";
import { ReplayApprovalMissingError } from "./ports/replay-human.js";
import {
  ReplayDivergenceError,
  ReplayMissingResultError as ReplayResponseMissingResultError,
} from "./ports/replay-model.js";
import { ReplayIdGenerator } from "./ports/replay-ids.js";
import { ResolvedRunSchema } from "./resolve.js";
import type { ResolvedRun } from "./resolve.js";
import { buildReplayRuntime } from "./replay-runtime.js";
import type { BuildReplayRuntimeOptions } from "./replay-runtime.js";

const REPLAY_SPAN = defineSpan(
  "harness.replay",
  { "harness.replay.original_run_id": attr.id() },
  { taskId: "9.3", packageName: "@rovinos/replay" },
);

const ReplayDivergenceSchema = z
  .object({
    seq: z.number().int().nonnegative(),
    code: z.enum(["replay_divergence", "replay_missing_result"]),
  })
  .strict();

/** Result of re-executing a recorded run, including metadata-only drift and failure details. */
export const ReplayOutcomeSchema = z
  .object({
    replayRunId: Id,
    traceId: TraceId,
    status: z.union([RunStatus, z.literal("error")]),
    events: z.array(Event),
    configDrift: z.boolean(),
    policyDrift: z.boolean(),
    divergence: ReplayDivergenceSchema.optional(),
  })
  .strict();

/** Inferred replay result. Event payloads retain the same tokenization as the recorded log. */
export type ReplayOutcome = z.infer<typeof ReplayOutcomeSchema>;

/** Current runtime configuration and optional read-only tool metadata used by the replay ports. */
export interface ReplayRunOptions extends Pick<
  BuildReplayRuntimeOptions,
  "policy" | "toolRegistry"
> {
  readonly config: RuntimeConfig;
}

type ReplayFailure = z.infer<typeof ReplayDivergenceSchema>;

function newReplayRunId(resolved: ResolvedRun, sourceRunId: IdValue): IdValue {
  const generator = new ReplayIdGenerator([], `harness.replay.${sourceRunId}`);
  const existingRunIds = new Set(resolved.runs.map(({ runId }) => runId));
  let replayRunId = generator.next();
  while (existingRunIds.has(replayRunId)) {
    replayRunId = generator.next();
  }
  return replayRunId;
}

function lastSequence(events: readonly EventValue[]): number {
  return events.at(-1)?.seq ?? 0;
}

function failureFrom(error: unknown, events: readonly EventValue[]): ReplayFailure | undefined {
  if (error instanceof ReplayDivergenceError) {
    return { seq: error.seq, code: "replay_divergence" };
  }
  if (error instanceof ReplayResponseMissingResultError) {
    return { seq: error.seq ?? lastSequence(events), code: "replay_missing_result" };
  }
  if (error instanceof ReplayApprovalMissingError) {
    return { seq: lastSequence(events), code: "replay_missing_result" };
  }
  return undefined;
}

function failureFromEvents(
  events: readonly EventValue[],
  originalEvents: readonly EventValue[],
): ReplayFailure | undefined {
  const failed = events.findLast(
    (event) => event.type === "run_status_changed" && event.to === "failed",
  );
  if (
    failed?.type !== "run_status_changed" ||
    (failed.reason !== "replay_divergence" && failed.reason !== "replay_missing_result")
  ) {
    return undefined;
  }

  const failedTool = events.findLast(
    (event) => event.type === "tool_result" && event.errorCode === failed.reason,
  );
  const sourceToolIntent =
    failedTool?.type === "tool_result"
      ? originalEvents.find(
          (event) => event.type === "tool_intent" && event.callId === failedTool.callId,
        )
      : undefined;
  const sourceRequest = originalEvents.findLast((event) => event.type === "model_request");
  return {
    seq: sourceToolIntent?.seq ?? sourceRequest?.seq ?? failed.seq,
    code: failed.reason,
  };
}

async function readEvents(store: EventStore, runId: IdValue): Promise<EventValue[]> {
  const events: EventValue[] = [];
  for await (const event of store.read(runId)) {
    events.push(event);
  }
  return events;
}

interface RunUntilTerminalOptions {
  readonly runtime: Runtime;
  readonly human: Awaited<ReturnType<typeof buildReplayRuntime>>["human"];
  readonly replayRunId: IdValue;
  readonly originalRunId: IdValue;
  readonly parentRunId?: IdValue;
  readonly input: EventValue & { type: "run_input" };
}

async function runUntilTerminal({
  runtime,
  human,
  replayRunId,
  originalRunId,
  parentRunId,
  input,
}: RunUntilTerminalOptions): Promise<void> {
  const started = runtime.start(input.input, {
    runId: replayRunId,
    replayOf: originalRunId,
    ...(parentRunId === undefined ? {} : { parentRunId }),
    rootSpanParent: context.active(),
  });
  let result = await started.completion;
  while (result.status === "suspended") {
    const approval = result.state.pendingApprovals.values().next().value;
    if (approval === undefined) {
      throw new ReplayResponseMissingResultError(lastSequence(result.events));
    }
    await human.resolveAndResume(runtime, replayRunId, approval.callId);
    const events = await readEvents(runtime.store, replayRunId);
    const state = foldRunState(events);
    result = { ...result, status: state.status, state };
  }
}

interface ReplayExecution {
  readonly events: EventValue[];
  readonly status: ReplayOutcome["status"];
  readonly divergence?: ReplayFailure;
}

interface ExecuteReplayOptions {
  readonly replay: Awaited<ReturnType<typeof buildReplayRuntime>>;
  readonly replaySpan: ReturnType<typeof REPLAY_SPAN.start>;
  readonly replayRunId: IdValue;
  readonly originalRunId: IdValue;
  readonly parentRunId?: IdValue;
  readonly originalEvents: readonly EventValue[];
}

async function executeReplay({
  replay,
  replaySpan,
  replayRunId,
  originalRunId,
  parentRunId,
  originalEvents,
}: ExecuteReplayOptions): Promise<ReplayExecution> {
  let events: EventValue[] = [];
  let status: ReplayOutcome["status"] = "error";
  let divergence: ReplayFailure | undefined;
  try {
    const input = originalEvents.find(
      (event): event is EventValue & { type: "run_input" } =>
        event.type === "run_input" && event.inputKind === "initial",
    );
    if (input === undefined) {
      throw new ReplayResponseMissingResultError();
    }
    await runUntilTerminal({
      runtime: replay.runtime,
      human: replay.human,
      replayRunId,
      originalRunId,
      ...(parentRunId === undefined ? {} : { parentRunId }),
      input,
    });
    events = await readEvents(replay.runtime.store, replayRunId);
    const state = foldRunState(events);
    divergence = failureFromEvents(events, originalEvents);
    status = divergence === undefined ? state.status : "error";
  } catch (error) {
    events = await readEvents(replay.runtime.store, replayRunId);
    divergence = failureFrom(error, events);
    if (divergence === undefined) {
      safeRecordError(replaySpan, error);
      throw error;
    }
    safeRecordError(replaySpan, error);
    status = "error";
  }

  return {
    events: await readEvents(replay.runtime.store, replayRunId),
    status,
    ...(divergence === undefined ? {} : { divergence }),
  };
}

/**
 * Re-executes the resolved root run using isolated replay ports and links its trace to the source.
 *
 * @param input - Validated original run and related run logs.
 * @param options - Current runtime configuration and optional read-only tool metadata.
 * @returns The replay run's validated events, terminal status, drift flags, and captured divergence.
 */
async function replayRunTree(
  input: ResolvedRun,
  options: ReplayRunOptions,
  sourceRunId: IdValue,
  parentRunId?: IdValue,
): Promise<ReplayOutcome> {
  const resolved = ResolvedRunSchema.parse(input);
  const original = resolved.runs.find(({ runId }) => runId === sourceRunId);
  const originalCreated = original?.events[0];
  if (original === undefined || originalCreated?.type !== "run_created") {
    throw new ReplayResponseMissingResultError();
  }

  const replayRunId = newReplayRunId(resolved, sourceRunId);
  const runtimeOptions: BuildReplayRuntimeOptions = {
    ...(options.policy === undefined ? {} : { policy: options.policy }),
    ...(options.toolRegistry === undefined ? {} : { toolRegistry: options.toolRegistry }),
    replayRunId,
    sourceRunId,
  };
  const replay = await buildReplayRuntime(resolved, options.config, runtimeOptions);
  const replaySpan = REPLAY_SPAN.start(
    { "harness.replay.original_run_id": resolved.rootRunId },
    {
      parent: parentRunId === undefined ? ROOT_CONTEXT : context.active(),
      links: [
        {
          context: {
            traceId: originalCreated.traceId,
            spanId: originalCreated.spanId,
            traceFlags: TraceFlags.SAMPLED,
            isRemote: true,
          },
        },
      ],
    },
  );
  const activeContext = trace.setSpan(context.active(), replaySpan);

  try {
    return await context.with(activeContext, async () => {
      const execution = await executeReplay({
        replay,
        replaySpan,
        replayRunId,
        originalRunId: sourceRunId,
        ...(parentRunId === undefined ? {} : { parentRunId }),
        originalEvents: original.events,
      });
      const childRuns = resolved.runs.filter((run) => run.parentRunId === sourceRunId);
      const childOutcomes: ReplayOutcome[] = [];
      for (const child of childRuns) {
        childOutcomes.push(await replayRunTree(resolved, options, child.runId, replayRunId));
      }
      const childDivergence = childOutcomes.find(
        (outcome) => outcome.divergence !== undefined,
      )?.divergence;
      const replayCreated = execution.events.find((event) => event.type === "run_created");
      return ReplayOutcomeSchema.parse({
        replayRunId,
        traceId: replaySpan.spanContext().traceId,
        status:
          execution.divergence !== undefined || childDivergence !== undefined
            ? "error"
            : execution.status,
        events: [...execution.events, ...childOutcomes.flatMap((outcome) => outcome.events)],
        configDrift:
          replayCreated?.type !== "run_created" ||
          replayCreated.configHash !== originalCreated.configHash,
        policyDrift:
          replayCreated?.type !== "run_created" ||
          replayCreated.policyVersion !== originalCreated.policyVersion,
        ...((execution.divergence ?? childDivergence) === undefined
          ? {}
          : { divergence: execution.divergence ?? childDivergence }),
      });
    });
  } finally {
    await replay.runtime.close();
    replaySpan.end();
  }
}

/**
 * Re-executes the resolved runs using isolated replay ports, linking each replay trace to its source
 * and each subagent replay to its replay parent.
 *
 * @param input - Validated original run and related run logs.
 * @param options - Current runtime configuration and optional read-only tool metadata.
 * @returns Replay events, terminal status, drift flags, and captured divergence.
 */
export async function replayRun(
  input: ResolvedRun,
  options: ReplayRunOptions,
): Promise<ReplayOutcome> {
  const resolved = ResolvedRunSchema.parse(input);
  return replayRunTree(resolved, options, resolved.rootRunId);
}
