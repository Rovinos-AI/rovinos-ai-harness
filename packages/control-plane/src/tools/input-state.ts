// SPDX-License-Identifier: Apache-2.0
import { foldRunState } from "@rovinos/core";
import { InputRequestSchema, type Event, type Id } from "@rovinos/schemas";
import type { EventStore } from "@rovinos/store";
import type { GetInputOutput, PendingInputSummary } from "../schemas.js";
import { readRunState } from "./run-state.js";

type InputRequestedEvent = Extract<Event, { type: "input_requested" }>;

interface LocatedInput {
  readonly runId: Id;
  readonly event: InputRequestedEvent;
  readonly request: ReturnType<typeof InputRequestSchema.parse>;
}

function projectRequest(event: InputRequestedEvent): ReturnType<typeof InputRequestSchema.parse> {
  return InputRequestSchema.parse({
    requestId: event.requestId,
    source: event.source,
    ...(event.serverId === undefined ? {} : { serverId: event.serverId }),
    ...(event.callId === undefined ? {} : { callId: event.callId }),
    ...(event.inputKey === undefined ? {} : { inputKey: event.inputKey }),
    round: event.round,
    mode: event.mode,
    message: event.message,
    ...(event.schema === undefined ? {} : { schema: event.schema }),
    ...(event.url === undefined ? {} : { url: event.url }),
    ...(event.expiresAt === undefined ? {} : { expiresAt: event.expiresAt }),
  });
}

async function* runIds(
  store: EventStore,
  allowedRunIds: readonly Id[] | undefined,
): AsyncGenerator<Id> {
  if (allowedRunIds !== undefined) {
    yield* new Set(allowedRunIds);
    return;
  }
  let cursor: string | undefined;
  for (;;) {
    const page = await store.listRuns({ limit: 100, ...(cursor === undefined ? {} : { cursor }) });
    for (const run of page.runs) {
      yield run.runId;
    }
    if (page.nextCursor === undefined || page.nextCursor === cursor) {
      return;
    }
    cursor = page.nextCursor;
  }
}

/** Lists pending input requests while applying the caller's run-id authorization filter. */
export async function listInputRequests(
  store: EventStore,
  now: number,
  allowedRunIds?: readonly Id[],
): Promise<PendingInputSummary[]> {
  const inputs: PendingInputSummary[] = [];
  for await (const runId of runIds(store, allowedRunIds)) {
    const run = await readRunState(store, runId);
    if (run === undefined) {
      continue;
    }
    for (const event of run.state.pendingInputs.values()) {
      inputs.push({
        requestId: event.requestId,
        runId,
        source: event.source,
        mode: event.mode,
        ...(event.serverId === undefined ? {} : { serverId: event.serverId }),
        round: event.round,
        ageMs: Math.max(0, Math.floor(now - event.ts)),
        expiresAt: event.expiresAt ?? null,
      });
    }
  }
  return inputs;
}

/** Finds one input request and distinguishes resolved requests without exposing other runs. */
export async function findInputRequest(
  store: EventStore,
  requestId: Id,
  allowedRunIds?: readonly Id[],
): Promise<
  { readonly runId: Id; readonly request: ReturnType<typeof InputRequestSchema.parse> } | undefined
> {
  for await (const runId of runIds(store, allowedRunIds)) {
    const run = await readRunState(store, runId);
    const event = run?.state.inputRequests.get(requestId);
    if (event !== undefined) {
      return { runId, request: projectRequest(event) };
    }
  }
  return undefined;
}

/** Finds one pending request and its original event timestamp for safe result projections. */
export async function findPendingInput(
  store: EventStore,
  requestId: Id,
  allowedRunIds?: readonly Id[],
): Promise<LocatedInput | undefined> {
  for await (const runId of runIds(store, allowedRunIds)) {
    const run = await readRunState(store, runId);
    const event = run?.state.pendingInputs.get(requestId);
    if (event !== undefined) {
      return { runId, event, request: projectRequest(event) };
    }
  }
  return undefined;
}

/** Builds the content-bearing result for an authorized input review command. */
export function getInputResult(input: LocatedInput, now: number): GetInputOutput {
  return {
    ...input.request,
    runId: input.runId,
    ageMs: Math.max(0, Math.floor(now - input.event.ts)),
  };
}

/** Reads the current pending-input state for a run. */
export async function hasPendingInput(
  store: EventStore,
  runId: Id,
  requestId: Id,
): Promise<boolean> {
  const run = await readRunState(store, runId);
  return run !== undefined && foldRunState(run.events).pendingInputs.has(requestId);
}
