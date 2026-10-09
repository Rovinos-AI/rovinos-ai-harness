// SPDX-License-Identifier: Apache-2.0
import type { Event, Id as IdType, JsonValue, NewEvent } from "@harness/schemas";
import { threadId, Worker } from "node:worker_threads";
import { describe, expect, it } from "vitest";
import { concurrencyWorkerSource } from "./concurrency-worker.js";
import {
  eventStoreWorkerMessageSchema,
  type WorkerReady,
  type WorkerResult,
} from "./concurrency-protocol.js";
import type { EventStore } from "../types.js";
import { createEventBuilders } from "./testing.js";

/** Module a worker imports to open its own connection to the shared event store. */
export interface WorkerOpenDescriptor {
  /** File URL to an ESM module exporting an event-store opener. */
  module: string;
  /** Name of the opener export in {@link module}. */
  exportName: string;
  /** JSON arguments passed to the opener. */
  args: JsonValue;
  /** Optional ESM loader URL used for source TypeScript modules. */
  loader?: string;
}

/** Factory that opens independent connections to the same event store. */
export interface MultiEventStoreFactory {
  /** Open a new connection to the shared database. */
  open(): Promise<EventStore>;
  /** Worker entry point for opening and using its own connection. */
  worker: WorkerOpenDescriptor;
  /** Close all opened connections and remove adapter-specific test resources. */
  cleanup(): Promise<void>;
}

/** Factory for an isolated group of independent connections to one database. */
export type MultiEventStoreFactoryCreator = () =>
  MultiEventStoreFactory | Promise<MultiEventStoreFactory>;

interface WorkerSession {
  opened: Promise<number>;
  prepare(iteration: number, runId: IdType, event: NewEvent): Promise<WorkerReady>;
  release(iteration: number): void;
  result(iteration: number): Promise<WorkerResult>;
  terminate(): Promise<number>;
}

interface Channel<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: Error): void;
}

interface WorkerChannels {
  opened: Channel<number>;
  ready: Map<number, Channel<WorkerReady>>;
  result: Map<number, Channel<WorkerResult>>;
}

interface WorkerSessionOptions {
  workerIndex: 0 | 1;
  worker: WorkerOpenDescriptor;
}

function createChannel<T>(): Channel<T> {
  let resolveChannel: (value: T) => void = () => undefined;
  let rejectChannel: (error: Error) => void = () => undefined;
  const promise = new Promise<T>((resolve, reject) => {
    resolveChannel = resolve;
    rejectChannel = reject;
  });
  void promise.catch(() => undefined);
  return { promise, resolve: resolveChannel, reject: rejectChannel };
}

function errorCode(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = error.code;
    if (typeof code === "string" && /^[a-z0-9_.-]{1,64}$/.test(code)) {
      return code;
    }
  }
  return "store_error";
}

function rejectWorkerChannels(channels: WorkerChannels, error: Error): void {
  channels.opened.reject(error);
  for (const channel of channels.ready.values()) {
    channel.reject(error);
  }
  for (const channel of channels.result.values()) {
    channel.reject(error);
  }
}

function receiveWorkerMessage(message: unknown, channels: WorkerChannels): void {
  const parsed = eventStoreWorkerMessageSchema.safeParse(message);
  if (!parsed.success) {
    channels.opened.reject(new Error("Invalid concurrency worker message"));
    return;
  }
  const value = parsed.data;
  if (value.kind === "opened") {
    channels.opened.resolve(value.threadId);
  } else if (value.kind === "open_error") {
    channels.opened.reject(new Error(value.code));
  } else if (value.kind === "ready") {
    channels.ready.get(value.iteration)?.resolve(value);
  } else {
    channels.result.get(value.iteration)?.resolve(value);
    if (value.outcome === "rejected") {
      channels.ready.get(value.iteration)?.reject(new Error(value.code));
    }
  }
}

function createWorkerSession(options: WorkerSessionOptions): WorkerSession {
  const execArgv =
    options.worker.loader === undefined
      ? undefined
      : [
          "--experimental-transform-types",
          "--disable-warning=ExperimentalWarning",
          "--experimental-loader",
          options.worker.loader,
        ];
  const worker = new Worker(concurrencyWorkerSource, {
    eval: true,
    ...(execArgv === undefined ? {} : { execArgv }),
    workerData: {
      workerIndex: options.workerIndex,
      worker: options.worker,
    },
  });
  const channels: WorkerChannels = {
    opened: createChannel<number>(),
    ready: new Map(),
    result: new Map(),
  };
  worker.on("message", (message: unknown) => {
    receiveWorkerMessage(message, channels);
  });
  worker.on("error", (error) => {
    rejectWorkerChannels(channels, error);
  });
  worker.on("exit", (code) => {
    if (code !== 0) {
      rejectWorkerChannels(channels, new Error("Concurrency worker exited unexpectedly"));
    }
  });

  return {
    opened: channels.opened.promise,
    prepare(iteration, runId, event) {
      const ready = createChannel<WorkerReady>();
      const result = createChannel<WorkerResult>();
      channels.ready.set(iteration, ready);
      channels.result.set(iteration, result);
      worker.postMessage({ kind: "run", iteration, runId, event });
      return ready.promise;
    },
    release(iteration) {
      worker.postMessage({ kind: "start", iteration });
    },
    result(iteration) {
      const channel = channels.result.get(iteration);
      if (channel === undefined) {
        return Promise.reject(new Error("Concurrency worker has no pending result"));
      }
      return channel.promise;
    },
    terminate() {
      return worker.terminate();
    },
  };
}

async function collectEvents(
  store: EventStore,
  runId: Parameters<EventStore["head"]>[0],
): Promise<Event[]> {
  const events: Event[] = [];
  for await (const event of store.read(runId)) {
    events.push(event);
  }
  return events;
}

async function withFactory<T>(
  multiFactory: MultiEventStoreFactoryCreator,
  run: (factory: MultiEventStoreFactory) => Promise<T>,
): Promise<T> {
  const factory = await multiFactory();
  try {
    return await run(factory);
  } finally {
    await factory.cleanup();
  }
}

function randomDelayGenerator(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 48_271) % 2_147_483_647;
    return state % 4;
  };
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function immediate(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

async function assertContiguous(
  store: EventStore,
  runId: Parameters<EventStore["head"]>[0],
): Promise<Event[]> {
  const events = await collectEvents(store, runId);
  expect(events.map(({ seq }) => seq)).toEqual(
    Array.from({ length: events.length }, (_, index) => index),
  );
  return events;
}

async function runAppendRace(
  factory: MultiEventStoreFactory,
  builders: ReturnType<typeof createEventBuilders>,
): Promise<void> {
  const [firstStore, secondStore] = await Promise.all([factory.open(), factory.open()]);
  const nextDelay = randomDelayGenerator(7_505);

  for (let iteration = 0; iteration < 200; iteration += 1) {
    const runId = builders.nextRunId();
    await firstStore.append(runId, [builders.runCreated(runId), builders.modelRequest(runId)], 0);
    const expectedSeq = await firstStore.head(runId);
    const outcomes = await Promise.allSettled([
      delay(nextDelay()).then(() =>
        firstStore.append(runId, [builders.modelRequest(runId)], expectedSeq),
      ),
      delay(nextDelay()).then(() =>
        secondStore.append(runId, [builders.modelRequest(runId)], expectedSeq),
      ),
    ]);

    expect(outcomes.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    const rejected = outcomes.filter(({ status }) => status === "rejected");
    expect(rejected).toHaveLength(1);
    expect(errorCode(rejected[0]?.status === "rejected" ? rejected[0].reason : undefined)).toBe(
      "seq_conflict",
    );
    const finalEvents = await assertContiguous(firstStore, runId);
    expect(finalEvents).toHaveLength(expectedSeq + 1);
  }
}

async function runResumeRace(
  factory: MultiEventStoreFactory,
  builders: ReturnType<typeof createEventBuilders>,
): Promise<void> {
  const store = await factory.open();
  const workers = [
    createWorkerSession({ workerIndex: 0, worker: factory.worker }),
    createWorkerSession({ workerIndex: 1, worker: factory.worker }),
  ];

  try {
    const workerThreadIds = await Promise.all(workers.map(({ opened }) => opened));
    expect(workerThreadIds.every((workerId) => workerId !== threadId)).toBe(true);
    expect(new Set(workerThreadIds).size).toBe(2);

    for (let iteration = 0; iteration < 200; iteration += 1) {
      const runId = builders.nextRunId();
      await store.append(runId, [builders.runCreated(runId)], 0);
      const observedHeads = await Promise.all(
        workers.map((worker) =>
          worker.prepare(iteration, runId, builders.runStatusChanged(runId, "pending", "running")),
        ),
      );

      expect(observedHeads.map(({ expectedSeq }) => expectedSeq)).toEqual([1, 1]);
      expect(observedHeads.map(({ threadId: observedThreadId }) => observedThreadId)).toEqual(
        workerThreadIds,
      );
      for (const worker of workers) {
        worker.release(iteration);
      }
      const results = await Promise.all(workers.map((worker) => worker.result(iteration)));
      expect(results.map(({ workerIndex }) => workerIndex)).toEqual([0, 1]);
      expect(results.filter(({ outcome }) => outcome === "fulfilled")).toHaveLength(1);
      const rejected = results.filter(
        (result): result is Extract<WorkerResult, { outcome: "rejected" }> =>
          result.outcome === "rejected",
      );
      expect(rejected).toHaveLength(1);
      expect(["seq_conflict", "store_unavailable"]).toContain(rejected[0]?.code);
      expect((await assertContiguous(store, runId)).map(({ seq }) => seq)).toEqual([0, 1]);
    }
  } finally {
    await Promise.all(workers.map((worker) => worker.terminate()));
  }
}

async function runWriterReader(
  factory: MultiEventStoreFactory,
  builders: ReturnType<typeof createEventBuilders>,
): Promise<void> {
  const [writerStore, readerStore] = await Promise.all([factory.open(), factory.open()]);
  const runId = builders.nextRunId();
  let finishWriter: () => void = () => undefined;
  const writerFinished = new Promise<void>((resolve) => {
    finishWriter = resolve;
  });
  let reads = 0;
  const writer = (async () => {
    try {
      for (let seq = 0; seq < 1_000; seq += 1) {
        const event = seq === 0 ? builders.runCreated(runId) : builders.modelRequest(runId);
        await writerStore.append(runId, [event], seq);
        if (seq % 20 === 19) {
          await immediate();
        }
      }
    } finally {
      finishWriter();
    }
  })();

  try {
    let shouldContinue = true;
    while (shouldContinue) {
      await assertContiguous(readerStore, runId);
      reads += 1;
      shouldContinue = !(await Promise.race([
        writerFinished.then(() => true),
        immediate().then(() => false),
      ]));
    }
  } finally {
    await writer.catch(() => undefined);
  }
  await writer;
  expect(reads).toBeGreaterThan(1);
  expect((await assertContiguous(readerStore, runId)).map(({ seq }) => seq)).toEqual(
    Array.from({ length: 1_000 }, (_, index) => index),
  );
}

/** Registers concurrent-writer behavioral tests reusable by every EventStore adapter. */
export function runConcurrencyConformance(
  name: string,
  multiFactory: MultiEventStoreFactoryCreator,
): void {
  const builders = createEventBuilders();
  describe(`${name} concurrent-writer conformance`, () => {
    it("allows exactly one append winner in 200 races and keeps each log contiguous", async () => {
      await withFactory(multiFactory, (factory) => runAppendRace(factory, builders));
    });

    it("allows exactly one worker to resume a run in 200 real races", async () => {
      await withFactory(multiFactory, (factory) => runResumeRace(factory, builders));
    }, 60_000);

    it("keeps reader observations contiguous while a writer appends 1,000 events", async () => {
      await withFactory(multiFactory, (factory) => runWriterReader(factory, builders));
    }, 30_000);
  });
}
