// SPDX-License-Identifier: Apache-2.0
import type { Event, Id as IdType, NewEvent } from "@harness/schemas";
import { Worker } from "node:worker_threads";
import { describe, expect, it } from "vitest";
import { concurrencyWorkerSource } from "./testing/concurrency-worker.js";
import {
  eventStoreWorkerMessageSchema,
  workerResponseSchema,
  type WorkerRequest,
  type WorkerResult,
} from "./testing/concurrency-protocol.js";
import type { EventStore } from "./types.js";
import { createEventBuilders } from "./testing/testing.js";

/** Factory that opens independent connections to the same event store. */
export interface MultiEventStoreFactory {
  /** Open a new connection to the shared database. */
  open(): Promise<EventStore>;
  /** Close all opened connections and remove adapter-specific test resources. */
  cleanup(): Promise<void>;
}

/** Factory for an isolated group of independent connections to one database. */
export type MultiEventStoreFactoryCreator = () =>
  MultiEventStoreFactory | Promise<MultiEventStoreFactory>;

interface WorkerSession {
  ready: Promise<number>;
  result: Promise<WorkerResult>;
  release(): void;
  terminate(): Promise<number>;
}

type StoreSlots = Map<0 | 1, EventStore>;
interface WorkerSessionOptions {
  factory: MultiEventStoreFactory;
  workerIndex: 0 | 1;
  runId: IdType;
  event: NewEvent;
  stores: StoreSlots;
}

interface WorkerChannels {
  ready: {
    promise: Promise<number>;
    resolve(expectedSeq: number): void;
    reject(error: Error): void;
  };
  result: {
    promise: Promise<WorkerResult>;
    resolve(result: WorkerResult): void;
  };
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

function createWorkerChannels(): WorkerChannels {
  let resolveReady: (expectedSeq: number) => void = () => undefined;
  let rejectReady: (error: Error) => void = () => undefined;
  let resolveResult: (result: WorkerResult) => void = () => undefined;
  const ready = new Promise<number>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const result = new Promise<WorkerResult>((resolve) => {
    resolveResult = resolve;
  });
  void ready.catch(() => undefined);

  return {
    ready: { promise: ready, resolve: resolveReady, reject: rejectReady },
    result: { promise: result, resolve: resolveResult },
  };
}

async function replyToWorkerRequest(
  worker: Worker,
  request: WorkerRequest,
  options: WorkerSessionOptions,
): Promise<void> {
  try {
    let response: unknown;
    if (request.kind === "open") {
      options.stores.set(options.workerIndex, await options.factory.open());
      response = true;
    } else {
      const store = options.stores.get(options.workerIndex);
      if (store === undefined) {
        throw new Error("Concurrency worker has no open store");
      }
      response =
        request.kind === "head"
          ? await store.head(request.runId)
          : await store.append(request.runId, [options.event], request.expectedSeq);
    }
    worker.postMessage(
      workerResponseSchema.parse({
        kind: "response",
        requestId: request.requestId,
        ok: true,
        value: response,
      }),
    );
  } catch (error) {
    worker.postMessage(
      workerResponseSchema.parse({
        kind: "response",
        requestId: request.requestId,
        ok: false,
        code: errorCode(error),
      }),
    );
  }
}

function handleWorkerMessage(
  worker: Worker,
  message: unknown,
  options: WorkerSessionOptions,
  channels: WorkerChannels,
): void {
  const parsed = eventStoreWorkerMessageSchema.safeParse(message);
  if (!parsed.success) {
    channels.ready.reject(new Error("Invalid concurrency worker message"));
    channels.result.resolve({
      kind: "result",
      workerIndex: options.workerIndex,
      outcome: "rejected",
      code: "worker_message_invalid",
    });
    void worker.terminate();
    return;
  }
  const value = parsed.data;
  if (value.kind === "ready") {
    channels.ready.resolve(value.expectedSeq);
  } else if (value.kind === "result") {
    if (value.outcome === "rejected") {
      channels.ready.reject(new Error("Concurrency worker failed before reading the head"));
    }
    channels.result.resolve(value);
  } else {
    void replyToWorkerRequest(worker, value, options);
  }
}

/** Keep adapter handles on their owning thread while workers exercise independent connections. */
function createWorkerSession(options: WorkerSessionOptions): WorkerSession {
  const worker = new Worker(concurrencyWorkerSource, {
    eval: true,
    workerData: { workerIndex: options.workerIndex, runId: options.runId },
  });
  const channels = createWorkerChannels();
  worker.on("message", (message: unknown) => {
    handleWorkerMessage(worker, message, options, channels);
  });
  worker.on("error", (error) => {
    channels.ready.reject(error);
    channels.result.resolve({
      kind: "result",
      workerIndex: options.workerIndex,
      outcome: "rejected",
      code: "worker_error",
    });
  });
  worker.on("exit", (code) => {
    if (code !== 0) {
      channels.ready.reject(new Error("Concurrency worker exited unexpectedly"));
      channels.result.resolve({
        kind: "result",
        workerIndex: options.workerIndex,
        outcome: "rejected",
        code: "worker_exit",
      });
    }
  });

  return {
    ready: channels.ready.promise,
    result: channels.result.promise,
    release() {
      worker.postMessage({ kind: "start" });
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
    const rejected = outcomes.find(({ status }) => status === "rejected");
    expect(rejected).toMatchObject({ status: "rejected", reason: { code: "seq_conflict" } });
    const finalEvents = await assertContiguous(firstStore, runId);
    expect(finalEvents).toHaveLength(expectedSeq + 1);
  }
}

async function runResumeRace(
  factory: MultiEventStoreFactory,
  builders: ReturnType<typeof createEventBuilders>,
): Promise<void> {
  const store = await factory.open();
  const runId = builders.nextRunId();
  await store.append(runId, [builders.runCreated(runId)], 0);
  const stores: StoreSlots = new Map();
  const workers = [
    createWorkerSession({
      factory,
      workerIndex: 0,
      runId,
      event: builders.runStatusChanged(runId, "pending", "running"),
      stores,
    }),
    createWorkerSession({
      factory,
      workerIndex: 1,
      runId,
      event: builders.runStatusChanged(runId, "pending", "running"),
      stores,
    }),
  ];

  try {
    const observedHeads = await Promise.all(workers.map(({ ready }) => ready));
    expect(observedHeads).toEqual([1, 1]);
    for (const worker of workers) {
      worker.release();
    }
    const results = await Promise.all(workers.map(({ result }) => result));
    expect(results.filter(({ outcome }) => outcome === "fulfilled")).toHaveLength(1);
    expect(results.filter(({ outcome }) => outcome === "rejected")).toEqual([
      expect.objectContaining({ outcome: "rejected", code: "seq_conflict" }),
    ]);
    expect((await assertContiguous(store, runId)).map(({ seq }) => seq)).toEqual([0, 1]);
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

  let shouldContinue = true;
  while (shouldContinue) {
    await assertContiguous(readerStore, runId);
    reads += 1;
    shouldContinue = !(await Promise.race([
      writerFinished.then(() => true),
      immediate().then(() => false),
    ]));
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

    it("allows exactly one worker to resume a run", async () => {
      await withFactory(multiFactory, (factory) => runResumeRace(factory, builders));
    });

    it("keeps reader observations contiguous while a writer appends 1,000 events", async () => {
      await withFactory(multiFactory, (factory) => runWriterReader(factory, builders));
    }, 30_000);
  });
}
