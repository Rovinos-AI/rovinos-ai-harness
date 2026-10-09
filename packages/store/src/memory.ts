// SPDX-License-Identifier: Apache-2.0
import { Event, type Event as StoredEvent, type Id, type NewEvent } from "@harness/schemas";
import { InvalidEventError, SeqConflictError, StoreUnavailableError } from "./errors.js";
import type { EventStore, ListRunsOptions, RunSummary } from "./types.js";

function startAfterCursor(summaries: readonly RunSummary[], cursor?: string): number | undefined {
  if (cursor === undefined) {
    return 0;
  }

  const cursorIndex = summaries.findIndex((summary) => summary.runId === cursor);
  if (cursorIndex === -1) {
    return undefined;
  }
  return cursorIndex + 1;
}

/** In-memory reference implementation of the append-only event store contract. */
export class InMemoryEventStore implements EventStore {
  private readonly runs = new Map<Id, StoredEvent[]>();

  /** {@inheritDoc EventStore.append} */
  append(
    runId: Id,
    events: readonly NewEvent[],
    expectedSeq: number,
  ): Promise<{ nextSeq: number }> {
    try {
      if (events.length === 0) {
        throw new InvalidEventError([[]]);
      }

      const stored = this.runs.get(runId) ?? [];
      if (expectedSeq !== stored.length) {
        throw new SeqConflictError(expectedSeq, stored.length);
      }

      const validated: StoredEvent[] = [];
      for (const [index, event] of events.entries()) {
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
        validated.push(result.data);
      }

      if (stored.length === 0 && validated[0]?.type !== "run_created") {
        throw new InvalidEventError([[0, "type"]]);
      }

      this.runs.set(runId, [...stored, ...validated]);
      return Promise.resolve({ nextSeq: expectedSeq + validated.length });
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new StoreUnavailableError());
    }
  }

  /** {@inheritDoc EventStore.read} */
  read(runId: Id, range?: { fromSeq?: number; toSeq?: number }): AsyncIterable<StoredEvent> {
    const stored = this.runs.get(runId) ?? [];
    const fromSeq = range?.fromSeq ?? 0;
    const toSeq = range?.toSeq ?? Number.POSITIVE_INFINITY;
    const selected = stored.filter((event) => event.seq >= fromSeq && event.seq <= toSeq);
    return {
      [Symbol.asyncIterator]() {
        let index = 0;
        return {
          next(): Promise<IteratorResult<StoredEvent>> {
            const event = selected[index];
            if (event === undefined) {
              return Promise.resolve({ done: true, value: undefined });
            }
            index += 1;
            return Promise.resolve({ done: false, value: structuredClone(event) });
          },
        };
      },
    };
  }

  /** {@inheritDoc EventStore.head} */
  head(runId: Id): Promise<number> {
    return Promise.resolve(this.runs.get(runId)?.length ?? 0);
  }

  /** {@inheritDoc EventStore.listRuns} */
  listRuns(opts: ListRunsOptions): Promise<{ runs: RunSummary[]; nextCursor?: string }> {
    if (!Number.isInteger(opts.limit) || opts.limit < 1) {
      return Promise.reject(new InvalidEventError([["limit"]]));
    }

    const summaries: RunSummary[] = [];
    for (const [runId, events] of this.runs) {
      const created = events.find((event) => event.type === "run_created");
      const last = events.at(-1);
      if (created === undefined || last === undefined) {
        continue;
      }

      let status: RunSummary["status"] = "pending";
      for (const event of events) {
        if (event.type === "run_status_changed") {
          status = event.to;
        }
      }
      if (opts.status !== undefined && opts.status !== status) {
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
      if (createdAtOrder !== 0) {
        return createdAtOrder;
      }
      return left.runId.localeCompare(right.runId);
    });

    const start = startAfterCursor(summaries, opts.cursor);
    if (start === undefined) {
      return Promise.reject(new InvalidEventError([["cursor"]]));
    }

    const end = start + opts.limit;
    const runs = summaries.slice(start, end);
    const nextCursor = end < summaries.length ? runs.at(-1)?.runId : undefined;
    return Promise.resolve(nextCursor === undefined ? { runs } : { runs, nextCursor });
  }

  /** {@inheritDoc EventStore.close} */
  close(): Promise<void> {
    return Promise.resolve();
  }
}
