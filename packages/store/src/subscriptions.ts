// SPDX-License-Identifier: Apache-2.0
import { RunStatus, type Event, type Id } from "@harness/schemas";
import { InvalidEventError } from "./errors.js";
import type { EventStore, RunSummary, WatchOptions, WatchRunsOptions } from "./types.js";

/** A cancellable notification wait used by EventStore adapters. */
export interface ChangeSubscription {
  /** Resolves when an append may have changed the watched state. */
  changed: Promise<void>;
  /** Releases any listener, timer, or abort handler owned by the wait. */
  cancel(): Promise<void>;
}

/** Adapter-provided factory for waiting on changes to a run or the run list. */
export type ChangeSubscriptionFactory = (
  runId: Id | undefined,
  signal: AbortSignal,
) => ChangeSubscription | Promise<ChangeSubscription>;

/** In-process change notifications shared by local EventStore adapters. */
export class ChangeEmitter {
  private readonly runWatchers = new Map<Id, Set<() => void>>();
  private readonly runListWatchers = new Set<() => void>();

  /** Notify subscribers that a run's stored state may have changed. */
  notify(runId: Id): void {
    for (const notify of this.runWatchers.get(runId) ?? []) {
      notify();
    }
    for (const notify of this.runListWatchers) {
      notify();
    }
  }

  /** Subscribe to one run or to changes across the entire run list. */
  subscribe(runId: Id | undefined, signal: AbortSignal): ChangeSubscription {
    let resolveChanged: () => void = () => undefined;
    let settled = false;
    const changed = new Promise<void>((resolve) => {
      resolveChanged = resolve;
    });
    const watchers =
      runId === undefined
        ? this.runListWatchers
        : (this.runWatchers.get(runId) ?? new Set<() => void>());
    const notify = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      signal.removeEventListener("abort", notify);
      watchers.delete(notify);
      if (runId !== undefined && watchers.size === 0) {
        this.runWatchers.delete(runId);
      }
      resolveChanged();
    };
    watchers.add(notify);
    if (runId !== undefined) {
      this.runWatchers.set(runId, watchers);
    }
    signal.addEventListener("abort", notify, { once: true });
    if (signal.aborted) {
      notify();
    }
    return {
      changed,
      cancel() {
        notify();
        return Promise.resolve();
      },
    };
  }
}

type EventReadStore = Pick<EventStore, "head" | "read">;
type RunReadStore = Pick<EventStore, "listRuns" | "read">;

interface EventWatchSource {
  subscribe: ChangeSubscriptionFactory;
  isTerminal(runId: Id, observedNextSeq: number): Promise<boolean>;
}

const terminalStatuses: readonly RunStatus[] = ["completed", "failed", "cancelled"];

function isAborted(signal: AbortSignal): boolean {
  return signal.aborted;
}

function validateWatchOptions(options: WatchOptions): void {
  if (!Number.isSafeInteger(options.fromSeq) || options.fromSeq < 0) {
    throw new InvalidEventError([["fromSeq"]]);
  }
  if (
    options.maxBuffered !== undefined &&
    (!Number.isSafeInteger(options.maxBuffered) || options.maxBuffered < 1)
  ) {
    throw new InvalidEventError([["maxBuffered"]]);
  }
}

function isTerminalEvent(event: Event): boolean {
  return event.type === "run_status_changed" && terminalStatuses.includes(event.to);
}

async function* readWatchBatch(
  store: EventReadStore,
  runId: Id,
  fromSeq: number,
  toSeq: number,
): AsyncIterable<Event> {
  yield* store.read(runId, { fromSeq, toSeq });
}

/** Follow a run log using bounded reads and adapter-provided wakeups. */
export async function* watchEvents(
  store: EventReadStore,
  runId: Id,
  options: WatchOptions,
  source: EventWatchSource,
): AsyncIterable<Event> {
  validateWatchOptions(options);
  const maxBuffered = options.maxBuffered ?? 1_000;
  let nextSeq = options.fromSeq;
  while (!options.signal.aborted) {
    const pendingSubscription = source.subscribe(runId, options.signal);
    const subscription =
      pendingSubscription instanceof Promise ? await pendingSubscription : pendingSubscription;
    try {
      const head = await store.head(runId);
      const toSeq = Math.min(head - 1, nextSeq + maxBuffered - 1);
      for await (const event of readWatchBatch(store, runId, nextSeq, toSeq)) {
        if (isAborted(options.signal)) {
          return;
        }
        nextSeq = event.seq + 1;
        yield event;
        if (isTerminalEvent(event)) {
          return;
        }
      }
      if (nextSeq < head) {
        continue;
      }
      if (await source.isTerminal(runId, nextSeq)) {
        return;
      }
      await subscription.changed;
    } finally {
      await subscription.cancel();
    }
  }
}

function matchesStatus(options: WatchRunsOptions, status: RunStatus): boolean {
  return options.statuses?.includes(status) ?? true;
}

function validateWatchRunsOptions(options: WatchRunsOptions): void {
  if (options.statuses?.some((status) => !RunStatus.safeParse(status).success) === true) {
    throw new InvalidEventError([["statuses"]]);
  }
}

async function allRunSummaries(store: RunReadStore): Promise<RunSummary[]> {
  const summaries = new Map<Id, RunSummary>();
  let cursor: string | undefined;
  do {
    const page = await store.listRuns({
      limit: 100,
      ...(cursor === undefined ? {} : { cursor }),
    });
    for (const summary of page.runs) {
      summaries.set(summary.runId, summary);
    }
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  return [...summaries.values()];
}

async function* runSummaryTransitions(
  store: RunReadStore,
  summary: RunSummary,
  options: WatchRunsOptions,
  fromSeq: number,
): AsyncIterable<RunSummary> {
  for await (const event of store.read(summary.runId, {
    fromSeq,
    toSeq: summary.lastSeq,
  })) {
    if (options.signal.aborted) {
      return;
    }
    let status: RunStatus | undefined;
    if (event.type === "run_created") {
      status = "pending";
    } else if (event.type === "run_status_changed") {
      status = event.to;
    }
    if (status !== undefined && matchesStatus(options, status)) {
      yield { ...summary, status, lastSeq: event.seq, lastTs: event.ts };
    }
  }
}

function* initialRunSummaries(
  summaries: readonly RunSummary[],
  options: WatchRunsOptions,
  seen: Map<Id, RunSummary>,
): Generator<RunSummary> {
  for (const summary of summaries) {
    if (isAborted(options.signal)) {
      return;
    }
    seen.set(summary.runId, summary);
    if (matchesStatus(options, summary.status)) {
      yield summary;
    }
  }
}

async function* changedRunSummaries(
  store: RunReadStore,
  summaries: readonly RunSummary[],
  options: WatchRunsOptions,
  seen: Map<Id, RunSummary>,
): AsyncIterable<RunSummary> {
  for (const summary of summaries) {
    const previous = seen.get(summary.runId);
    if (previous === undefined || summary.lastSeq > previous.lastSeq) {
      const fromSeq = previous === undefined ? 0 : previous.lastSeq + 1;
      yield* runSummaryTransitions(store, summary, options, fromSeq);
    }
    seen.set(summary.runId, summary);
  }
}

/** Follow current run summaries and every subsequent status transition. */
export async function* watchRunSummaries(
  store: RunReadStore,
  options: WatchRunsOptions,
  subscribe: ChangeSubscriptionFactory,
): AsyncIterable<RunSummary> {
  validateWatchRunsOptions(options);
  const seen = new Map<Id, RunSummary>();
  const initialSummaries = await allRunSummaries(store);
  yield* initialRunSummaries(initialSummaries, options, seen);
  while (!options.signal.aborted) {
    const pendingSubscription = subscribe(undefined, options.signal);
    const subscription =
      pendingSubscription instanceof Promise ? await pendingSubscription : pendingSubscription;
    try {
      const summaries = await allRunSummaries(store);
      yield* changedRunSummaries(store, summaries, options, seen);
      await subscription.changed;
    } finally {
      await subscription.cancel();
    }
  }
}
