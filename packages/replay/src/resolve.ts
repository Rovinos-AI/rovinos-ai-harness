// SPDX-License-Identifier: Apache-2.0
import {
  Event,
  HarnessError,
  Id,
  TraceId,
  Traceparent,
  type Event as EventValue,
  type Id as RunId,
  type TraceId as TraceIdValue,
} from "@harness/schemas";
import type { EventStore } from "@harness/store";
import { z } from "zod";

const MAX_EVENTS = 1_000_000;
const ZERO_TRACE_ID = "0".repeat(32);
const ZERO_SPAN_ID = "0".repeat(16);

const ResolvedRunEntrySchema = z
  .object({
    runId: Id,
    role: z.enum(["root", "subagent"]),
    parentRunId: Id.optional(),
    events: Event.array(),
  })
  .strict();

/** Metadata and complete validated event logs for a resolved root and its related runs. */
export const ResolvedRunSchema = z
  .object({
    rootRunId: Id,
    runs: ResolvedRunEntrySchema.array(),
  })
  .strict();

/** Inferred result of resolving a run from a run id or trace id. */
export type ResolvedRun = z.infer<typeof ResolvedRunSchema>;

/** Inputs for resolving one run or the runs related to a trace. */
export interface ResolveRunInput {
  /** Event store to query and read. */
  readonly store: Pick<EventStore, "findRunsByTrace" | "read">;
  /** Run identifier to load. */
  readonly runId?: RunId;
  /** Trace identifier or W3C traceparent to resolve. */
  readonly traceId?: string;
}

/** Error raised when neither or both supported run selectors are supplied or valid. */
export class ReplayInputError extends HarnessError {
  override readonly code = "replay_input_invalid";

  constructor() {
    super("Provide exactly one valid run id or trace id.");
  }
}

/** Error raised when the requested run does not exist. */
export class RunNotFoundError extends HarnessError {
  override readonly code = "run_not_found";

  constructor() {
    super("Run was not found.");
  }
}

/** Error raised when one trace resolves to multiple possible roots. */
export class TraceAmbiguousError extends HarnessError {
  override readonly code = "trace_ambiguous";
  readonly runIds: readonly RunId[];

  constructor(runIds: readonly RunId[]) {
    super("Trace resolves to multiple possible root runs.");
    this.runIds = [...runIds];
  }
}

/** Error raised when the resolved event logs exceed the configured safety limit. */
export class ReplayTooLargeError extends HarnessError {
  override readonly code = "replay_too_large";

  constructor() {
    super("Resolved event logs exceed the replay event limit.");
  }
}

/** Error raised when a stored event log is empty, malformed, or out of sequence. */
export class CorruptLogError extends HarnessError {
  override readonly code = "corrupt_log";

  constructor() {
    super("Run event log is corrupt.");
  }
}

function parseTraceId(input: string): TraceIdValue {
  const traceIdResult = TraceId.safeParse(input);
  if (traceIdResult.success) {
    if (traceIdResult.data === ZERO_TRACE_ID) {
      throw new ReplayInputError();
    }
    return traceIdResult.data;
  }

  const traceparentResult = Traceparent.safeParse(input);
  if (!traceparentResult.success) {
    throw new ReplayInputError();
  }
  const [, traceId, spanId] = traceparentResult.data.split("-");
  if (traceId === ZERO_TRACE_ID || spanId === ZERO_SPAN_ID) {
    throw new ReplayInputError();
  }
  return TraceId.parse(traceId);
}

interface LoadedRun {
  readonly runId: RunId;
  readonly parentRunId?: RunId;
  readonly events: EventValue[];
}

async function readRun(
  store: ResolveRunInput["store"],
  runId: RunId,
  totalEvents: { count: number },
): Promise<LoadedRun> {
  const events: EventValue[] = [];
  for await (const event of store.read(runId)) {
    if (totalEvents.count >= MAX_EVENTS) {
      throw new ReplayTooLargeError();
    }
    const parsedEvent = Event.safeParse(event);
    if (!parsedEvent.success) {
      throw new CorruptLogError();
    }
    const validEvent = parsedEvent.data;
    if (validEvent.runId !== runId || validEvent.seq !== events.length) {
      throw new CorruptLogError();
    }
    if (events.length === 0 && validEvent.type !== "run_created") {
      throw new CorruptLogError();
    }
    events.push(validEvent);
    totalEvents.count += 1;
  }
  if (events.length === 0) {
    throw new RunNotFoundError();
  }
  const firstEvent = events[0];
  if (firstEvent === undefined || firstEvent.type !== "run_created") {
    throw new CorruptLogError();
  }
  return {
    runId,
    ...(firstEvent.parentRunId === undefined ? {} : { parentRunId: firstEvent.parentRunId }),
    events,
  };
}

function asResolvedEntry(run: LoadedRun, role: "root" | "subagent"): ResolvedRun["runs"][number] {
  return {
    runId: run.runId,
    role,
    ...(run.parentRunId === undefined ? {} : { parentRunId: run.parentRunId }),
    events: run.events,
  };
}

/**
 * Resolves a run id or trace id and loads every matching run's validated event log.
 *
 * @param input - Store and exactly one run or trace selector.
 * @returns The root run and, for a trace selector, its matching subagent runs.
 * @throws {@link ReplayInputError} when the selector is missing, duplicated, or invalid.
 * @throws {@link RunNotFoundError} when no stored events exist for a requested run.
 * @throws {@link TraceAmbiguousError} when multiple trace matches have no unique root.
 * @throws {@link ReplayTooLargeError} when more than one million events are resolved.
 * @throws {@link CorruptLogError} when any event log is malformed or non-contiguous.
 */
export async function resolveRun(input: ResolveRunInput): Promise<ResolvedRun> {
  const hasRunId = input.runId !== undefined;
  const hasTraceId = input.traceId !== undefined;
  if (hasRunId === hasTraceId) {
    throw new ReplayInputError();
  }

  if (hasRunId) {
    const parsedRunId = Id.safeParse(input.runId);
    if (!parsedRunId.success) {
      throw new ReplayInputError();
    }
    const run = await readRun(input.store, parsedRunId.data, { count: 0 });
    return ResolvedRunSchema.parse({
      rootRunId: run.runId,
      runs: [asResolvedEntry(run, "root")],
    });
  }

  const traceId = parseTraceId(input.traceId ?? "");
  const matchedRunIds = [...new Set(await input.store.findRunsByTrace(traceId))];
  if (matchedRunIds.length === 0) {
    throw new RunNotFoundError();
  }

  const totalEvents = { count: 0 };
  const runs: LoadedRun[] = [];
  for (const runId of matchedRunIds) {
    runs.push(await readRun(input.store, runId, totalEvents));
  }

  const roots = runs.filter((run) => run.parentRunId === undefined);
  if (runs.length > 1 && roots.length !== 1) {
    throw new TraceAmbiguousError(matchedRunIds);
  }
  const root = roots[0] ?? runs[0];
  if (root === undefined) {
    throw new RunNotFoundError();
  }
  return ResolvedRunSchema.parse({
    rootRunId: root.runId,
    runs: [
      asResolvedEntry(root, "root"),
      ...runs.filter((run) => run.runId !== root.runId).map((run) => asResolvedEntry(run, "subagent")),
    ],
  });
}
