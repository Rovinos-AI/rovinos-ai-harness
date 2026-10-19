// SPDX-License-Identifier: Apache-2.0
import {
  Event,
  type Event as StoredEvent,
  type Id,
  type NewEvent,
} from "@harness/schemas";
import type { EncodedSnapshot } from "./codec.js";
import { InvalidEventError } from "./errors.js";
import type { ListRunsOptions, RunSummary } from "./types.js";

/** Builds a validated, keyset-paginated summary of in-memory runs. */
export function listMemoryRuns(
  storedRuns: ReadonlyMap<Id, readonly StoredEvent[]>,
  options: ListRunsOptions,
): { runs: RunSummary[]; nextCursor?: string } {
  if (!Number.isInteger(options.limit) || options.limit < 1) {
    throw new InvalidEventError([["limit"]]);
  }
  const summaries: RunSummary[] = [];
  for (const [runId, events] of storedRuns) {
    const created = events.find((event) => event.type === "run_created");
    const last = events.at(-1);
    if (created?.type !== "run_created" || last === undefined) {
      continue;
    }
    if (!matchesContinuation(created, options.continuationOf)) {
      continue;
    }
    const status = currentStatus(events);
    if (options.status !== undefined && options.status !== status) {
      continue;
    }
    summaries.push({
      runId,
      createdAt: created.ts,
      status,
      lastSeq: last.seq,
      lastTs: last.ts,
    });
  }
  summaries.sort((left, right) => {
    const createdAtOrder = right.createdAt - left.createdAt;
    return createdAtOrder === 0 ? left.runId.localeCompare(right.runId) : createdAtOrder;
  });
  const start = startAfterCursor(summaries, options.cursor);
  if (start === undefined) {
    throw new InvalidEventError([["cursor"]]);
  }
  const end = start + options.limit;
  const runs = summaries.slice(start, end);
  const nextCursor = end < summaries.length ? runs.at(-1)?.runId : undefined;
  return nextCursor === undefined ? { runs } : { runs, nextCursor };
}

function currentStatus(events: readonly StoredEvent[]): RunSummary["status"] {
  let status: RunSummary["status"] = "pending";
  for (const event of events) {
    if (event.type === "run_status_changed") {
      status = event.to;
    }
  }
  return status;
}

/** Index just past `cursor` in the listing, 0 without a cursor, or undefined if it is unknown. */
export function startAfterCursor(
  summaries: readonly RunSummary[],
  cursor?: string,
): number | undefined {
  if (cursor === undefined) {
    return 0;
  }

  const cursorIndex = summaries.findIndex((summary) => summary.runId === cursor);
  if (cursorIndex === -1) {
    return undefined;
  }
  return cursorIndex + 1;
}

/** Whether a run's creation event matches the requested continuation filter. */
export function matchesContinuation(
  created: Extract<StoredEvent, { type: "run_created" }>,
  continuationOf: Id | undefined,
): boolean {
  return continuationOf === undefined || created.continuationOf === continuationOf;
}

/** Validates a batch for append and assigns sequence numbers starting at `expectedSeq`. */
export function validateEventBatch(
  runId: Id,
  events: readonly NewEvent[],
  expectedSeq: number,
  storedLength: number,
): StoredEvent[] {
  if (events.length === 0) {
    throw new InvalidEventError([[]]);
  }
  const validated = events.map((event, index) => {
    if (event.runId !== runId) {
      throw new InvalidEventError([["runId"]]);
    }
    const result = Event.safeParse({ ...event, seq: expectedSeq + index });
    if (!result.success) {
      const paths = result.error.issues.map(({ path }) =>
        path.flatMap((part) =>
          typeof part === "string" || typeof part === "number" ? [part] : [],
        ),
      );
      throw new InvalidEventError(paths);
    }
    return result.data;
  });
  if (storedLength === 0 && validated[0]?.type !== "run_created") {
    throw new InvalidEventError([[0, "type"]]);
  }
  return validated;
}

/** Whether any run already holds a snapshot with this id. */
export function hasDuplicateSnapshot(
  snapshotsByRun: ReadonlyMap<Id, readonly EncodedSnapshot[]>,
  snapshotId: Id,
): boolean {
  return [...snapshotsByRun.values()].some((snapshots) =>
    snapshots.some((snapshot) => snapshot.snapshot_id === snapshotId),
  );
}
