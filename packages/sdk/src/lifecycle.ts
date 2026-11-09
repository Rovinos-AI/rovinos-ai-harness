// SPDX-License-Identifier: Apache-2.0
import type { Runtime } from "@rovinos/core";
import type { Event, Id } from "@rovinos/schemas";
import type { SafeEvent } from "@rovinos/telemetry";
import { SdkError, type WatchOptionsSchema } from "./types.js";

interface ManagedExecution {
  readonly controller: AbortController;
  readonly settled: Promise<void>;
  readonly resolveSettled: () => void;
}

/** Represents a client-owned event watcher that must stop before runtime disposal. */
export interface ClientWatcher {
  readonly controller: AbortController;
  readonly finished: Promise<void>;
  readonly resolveFinished: () => void;
}

/** Tracks SDK-owned executions and operations until runtime resources can be closed. */
export class LifecycleTracker {
  private readonly executions = new Set<ManagedExecution>();
  private readonly trackedExecutions = new WeakSet<ManagedExecution>();
  private readonly operations = new Set<Promise<void>>();
  private readonly watchers = new Set<ClientWatcher>();

  constructor(private readonly shutdownGraceMs: number) {}

  admitExecution(): ManagedExecution {
    let resolveSettled: () => void = () => undefined;
    const settled = new Promise<void>((resolve) => {
      resolveSettled = resolve;
    });
    const execution: ManagedExecution = {
      controller: new AbortController(),
      settled,
      resolveSettled,
    };
    this.executions.add(execution);
    return execution;
  }

  trackExecution(execution: ManagedExecution, completion: Promise<unknown>): void {
    this.trackedExecutions.add(execution);
    void completion.then(
      () => {
        this.finishExecution(execution);
      },
      () => {
        this.finishExecution(execution);
      },
    );
  }

  finishIfUntracked(execution: ManagedExecution): void {
    if (!this.trackedExecutions.has(execution)) {
      this.finishExecution(execution);
    }
  }

  trackOperation<Result>(operation: Promise<Result>): Promise<Result> {
    const settled = operation.then(
      () => undefined,
      () => undefined,
    );
    this.operations.add(settled);
    void settled.then(() => {
      this.operations.delete(settled);
    });
    return operation;
  }

  addWatcher(controller: AbortController): ClientWatcher {
    let resolveFinished: () => void = () => undefined;
    const finished = new Promise<void>((resolve) => {
      resolveFinished = resolve;
    });
    const watcher: ClientWatcher = { controller, finished, resolveFinished };
    this.watchers.add(watcher);
    return watcher;
  }

  finishWatcher(watcher: ClientWatcher): void {
    this.watchers.delete(watcher);
    watcher.resolveFinished();
  }

  async drainExecutions(): Promise<void> {
    const active = Array.from(this.executions);
    if (active.length === 0) {
      return;
    }
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const expired = await Promise.race([
      Promise.all(active.map(({ settled }) => settled)).then(() => false),
      new Promise<boolean>((resolve) => {
        timeout = setTimeout(() => {
          resolve(true);
        }, this.shutdownGraceMs);
      }),
    ]);
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
    if (expired) {
      this.executions.forEach(({ controller }) => {
        controller.abort("shutdown");
      });
    }
    await Promise.all(Array.from(this.executions, ({ settled }) => settled));
  }

  async stopWatchers(): Promise<void> {
    const watchers = Array.from(this.watchers);
    watchers.forEach(({ controller }) => {
      controller.abort();
    });
    await Promise.all(watchers.map(({ finished }) => finished));
  }

  async waitForOperations(): Promise<void> {
    await Promise.all(Array.from(this.operations));
  }

  private finishExecution(execution: ManagedExecution): void {
    if (!this.executions.delete(execution)) {
      return;
    }
    execution.resolveSettled();
  }
}

/** Streams stored events for a run and tracks the watcher until iteration ends. */
export async function* watchRunStoredEvents({
  runtime,
  tracker,
  runId,
  options,
}: {
  readonly runtime: Runtime;
  readonly tracker: LifecycleTracker;
  readonly runId: Id;
  readonly options: ReturnType<typeof WatchOptionsSchema.parse>;
}): AsyncGenerator<Event> {
  const controller = new AbortController();
  const watcher = tracker.addWatcher(controller);
  const onAbort = (): void => {
    controller.abort();
  };
  if (options.signal?.aborted === true) {
    controller.abort();
  } else {
    options.signal?.addEventListener("abort", onAbort, { once: true });
  }
  try {
    let created: Event | undefined;
    for await (const event of runtime.store.read(runId)) {
      created = event;
      break;
    }
    if (created?.type !== "run_created") {
      throw new SdkError("sdk_run_not_found");
    }
    if (controller.signal.aborted) {
      return;
    }
    for await (const event of runtime.store.watch(runId, {
      fromSeq: options.fromSeq,
      signal: controller.signal,
      ...(options.maxBuffered === undefined ? {} : { maxBuffered: options.maxBuffered }),
    })) {
      yield event;
    }
  } finally {
    options.signal?.removeEventListener("abort", onAbort);
    tracker.finishWatcher(watcher);
  }
}

/** Streams safe events for a run and tracks the watcher until iteration ends. */
export async function* watchRunEvents({
  runtime,
  tracker,
  runId,
  options,
  projectSafeEvents,
}: {
  readonly runtime: Runtime;
  readonly tracker: LifecycleTracker;
  readonly runId: Id;
  readonly options: ReturnType<typeof WatchOptionsSchema.parse>;
  readonly projectSafeEvents: (events: readonly Event[]) => Promise<readonly SafeEvent[]>;
}): AsyncGenerator<SafeEvent> {
  for await (const event of watchRunStoredEvents({ runtime, tracker, runId, options })) {
    yield* await projectSafeEvents([event]);
  }
}
