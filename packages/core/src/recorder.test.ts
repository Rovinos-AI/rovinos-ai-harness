// SPDX-License-Identifier: Apache-2.0
import { AsyncLocalStorage } from "node:async_hooks";
import {
  context,
  ROOT_CONTEXT,
  SpanStatusCode,
  trace,
  type Context,
  type ContextManager,
  type Span,
  type SpanContext,
  type SpanOptions,
  type Tracer,
  type TracerProvider,
} from "@opentelemetry/api";
import { FakeClock, type Event } from "@harness/schemas";
import { InMemoryEventStore } from "@harness/store";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  LeaseLostError,
  RunRecorder,
  SpanContextMissingError,
  type Clock,
  type EventPartial,
} from "./recorder.js";
import { CHECKPOINT_SPAN, MODEL_CALL_SPAN, RUN_SPAN, TOOL_CALL_SPAN } from "./spans.js";

const runId = "00000000000000000000000000";
const segmentId = "11111111111111111111111111";
const hash = "a".repeat(64);
const finishedSpans: SpySpan[] = [];
const parentContexts: (Context | undefined)[] = [];
let nextSpanId = 0;

class SpySpan implements Span {
  readonly attributes: Record<string, string | number | boolean> = {};
  readonly context: SpanContext = {
    traceId: "a".repeat(32),
    spanId: (++nextSpanId).toString(16).padStart(16, "0"),
    traceFlags: 1,
  };
  status: Parameters<Span["setStatus"]>[0] = { code: SpanStatusCode.UNSET };
  private ended = false;
  private recordedExceptions = 0;

  constructor(attributes: SpanOptions["attributes"] = {}) {
    this.setAttributes(attributes);
  }

  spanContext(): SpanContext {
    return this.context;
  }

  setAttribute(key: string, value: string | number | boolean): this {
    this.attributes[key] = value;
    return this;
  }

  setAttributes(attributes: Parameters<Span["setAttributes"]>[0]): this {
    Object.assign(this.attributes, attributes);
    return this;
  }

  addEvent(
    _name: Parameters<Span["addEvent"]>[0],
    _attributesOrStartTime?: Parameters<Span["addEvent"]>[1],
    _startTime?: Parameters<Span["addEvent"]>[2],
  ): this {
    return this;
  }

  addLink(_link: Parameters<Span["addLink"]>[0]): this {
    return this;
  }

  addLinks(_links: Parameters<Span["addLinks"]>[0]): this {
    return this;
  }

  setStatus(status: Parameters<Span["setStatus"]>[0]): this {
    this.status = status;
    return this;
  }

  updateName(_name: string): this {
    return this;
  }

  end(): void {
    this.ended = true;
    finishedSpans.push(this);
  }

  isRecording(): boolean {
    return !this.ended;
  }

  recordException(
    _exception: Parameters<Span["recordException"]>[0],
    _time?: Parameters<Span["recordException"]>[1],
  ): void {
    this.recordedExceptions += 1;
  }
}

class SpyTracer implements Tracer {
  startSpan(_name: string, options?: SpanOptions, parentContext?: Context): Span {
    parentContexts.push(parentContext);
    return new SpySpan(options?.attributes);
  }

  startActiveSpan<F extends (span: Span) => unknown>(name: string, fn: F): ReturnType<F>;
  startActiveSpan<F extends (span: Span) => unknown>(
    name: string,
    options: SpanOptions,
    fn: F,
  ): ReturnType<F>;
  startActiveSpan<F extends (span: Span) => unknown>(
    name: string,
    options: SpanOptions,
    activeContext: Context,
    fn: F,
  ): ReturnType<F>;
  startActiveSpan<F extends (span: Span) => unknown>(
    _name: string,
    _optionsOrCallback: SpanOptions | F,
    _contextOrCallback?: Context | F,
    _callback?: F,
  ): ReturnType<F> {
    throw new Error("startActiveSpan is not used by the recorder.");
  }
}

class SpyTracerProvider implements TracerProvider {
  private readonly tracer = new SpyTracer();

  getTracer(): Tracer {
    return this.tracer;
  }
}

class TestContextManager implements ContextManager {
  private readonly storage = new AsyncLocalStorage<Context>();

  active(): Context {
    return this.storage.getStore() ?? ROOT_CONTEXT;
  }

  with<A extends unknown[], F extends (...args: A) => ReturnType<F>>(
    activeContext: Context,
    fn: F,
    thisArg?: ThisParameterType<F>,
    ...args: A
  ): ReturnType<F> {
    return this.storage.run(activeContext, () => fn.apply(thisArg, args));
  }

  bind<T>(_activeContext: Context, target: T): T {
    return target;
  }

  enable(): this {
    return this;
  }

  disable(): this {
    this.storage.disable();
    return this;
  }
}

function runCreated(): EventPartial {
  return {
    type: "run_created",
    v: 1,
    configHash: hash,
    policyVersion: "test.policy",
  };
}

function statusChanged(): EventPartial {
  return {
    type: "run_status_changed",
    v: 1,
    from: "pending",
    to: "running",
    reason: "start",
  };
}

function checkpointWritten(atSeq: number): EventPartial {
  return {
    type: "checkpoint_written",
    v: 1,
    checkpointId: segmentId,
    atSeq,
    traceparent: `00-${"a".repeat(32)}-${"b".repeat(16)}-01`,
  };
}

function makeRecorder(store: InMemoryEventStore, clock: Clock = new FakeClock(100)): RunRecorder {
  return new RunRecorder(store, runId, segmentId, 0, clock);
}

async function recordInSpan(recorder: RunRecorder, partial: EventPartial): Promise<Event> {
  return recorder.withStepSpan(MODEL_CALL_SPAN, {}, () => recorder.record(partial));
}

beforeAll(() => {
  context.setGlobalContextManager(new TestContextManager());
  trace.setGlobalTracerProvider(new SpyTracerProvider());
});

afterAll(() => {
  context.disable();
});

beforeEach(() => {
  finishedSpans.length = 0;
  parentContexts.length = 0;
  nextSpanId = 0;
});

describe("RunRecorder", () => {
  it("fills envelope fields deterministically and increments sequence numbers", async () => {
    const store = new InMemoryEventStore();
    const clock = new FakeClock(100);
    const recorder = makeRecorder(store, clock);

    const first = await recordInSpan(recorder, runCreated());
    clock.advance(10);
    const second = await recordInSpan(recorder, statusChanged());

    expect(first).toMatchObject({
      runId,
      segmentId,
      seq: 0,
      ts: 100,
      type: "run_created",
    });
    expect(second).toMatchObject({
      runId,
      segmentId,
      seq: 1,
      ts: 110,
      type: "run_status_changed",
    });
    expect(first.traceId).toMatch(/^[0-9a-f]{32}$/u);
    expect(first.spanId).toMatch(/^[0-9a-f]{16}$/u);
    expect(recorder.nextSeq).toBe(2);
    expect(await store.head(runId)).toBe(2);
  });

  it("atomically appends batches and assigns their consecutive sequences", async () => {
    const store = new InMemoryEventStore();
    const recorder = makeRecorder(store);

    const second = await recorder.withStepSpan(CHECKPOINT_SPAN, {}, async () => {
      const events = await recorder.recordBatch([runCreated(), checkpointWritten(1)]);
      const last = events.at(-1);
      if (last === undefined) {
        throw new Error("Expected the batch to return its events.");
      }
      return last;
    });

    expect(second.seq).toBe(1);
    expect(recorder.nextSeq).toBe(2);
    expect(await store.head(runId)).toBe(2);
  });

  it("leaves the log and sequence unchanged when a batch contains an invalid event", async () => {
    const store = new InMemoryEventStore();
    const recorder = makeRecorder(store);
    const invalidStatusChanged: EventPartial = {
      type: "run_status_changed",
      v: 1,
      from: "pending",
      to: "running",
      reason: "",
    };

    await expect(
      recorder.withStepSpan(RUN_SPAN, {}, () =>
        recorder.recordBatch([runCreated(), invalidStatusChanged]).then(() => runCreatedEvent()),
      ),
    ).rejects.toMatchObject({ code: "event_invalid" });

    expect(await store.head(runId)).toBe(0);
    expect(recorder.nextSeq).toBe(0);
  });

  it("turns a sequence conflict into a latched lease loss", async () => {
    const store = new InMemoryEventStore();
    await store.append(
      runId,
      [
        {
          ...runCreated(),
          runId,
          ts: 100,
          traceId: "a".repeat(32),
          spanId: "b".repeat(16),
          segmentId,
        },
      ],
      0,
    );
    const append = vi.spyOn(store, "append");
    const recorder = makeRecorder(store);

    await expect(recordInSpan(recorder, statusChanged())).rejects.toMatchObject({
      code: "lease_lost",
      storedHead: 1,
    });
    await expect(recorder.record(statusChanged())).rejects.toBeInstanceOf(LeaseLostError);

    expect(append).toHaveBeenCalledTimes(1);
    expect(await store.head(runId)).toBe(1);
  });

  it("serializes simultaneous writes from the same recorder", async () => {
    const store = new InMemoryEventStore();
    const recorder = makeRecorder(store);

    const last = await recorder.withStepSpan(RUN_SPAN, {}, async () => {
      const events = await Promise.all([
        recorder.record(runCreated()),
        recorder.record(runCreated()),
      ]);
      const lastEvent = events.at(1);
      if (lastEvent === undefined) {
        throw new Error("Expected both writes to return events.");
      }
      return lastEvent;
    });

    expect(last.seq).toBe(1);
    expect(recorder.nextSeq).toBe(2);
  });

  it("rejects when recording without a valid active span", async () => {
    const recorder = makeRecorder(new InMemoryEventStore());

    await expect(recorder.record(runCreated())).rejects.toBeInstanceOf(SpanContextMissingError);
    await expect(recorder.recordBatch([runCreated()])).rejects.toBeInstanceOf(
      SpanContextMissingError,
    );
  });

  it("starts run spans as roots when another span is active", async () => {
    const recorder = makeRecorder(new InMemoryEventStore());
    const hostSpan = new SpySpan();

    await context.with(trace.setSpan(ROOT_CONTEXT, hostSpan), () =>
      recorder.withStepSpan(RUN_SPAN, {}, () => recorder.record(runCreated())),
    );

    expect(parentContexts).toEqual([ROOT_CONTEXT]);
  });

  it("rejects span attributes outside the registered allowlist", async () => {
    const recorder = makeRecorder(new InMemoryEventStore());

    await expect(
      recorder.withStepSpan(MODEL_CALL_SPAN, { "harness.private.value": "sensitive" }, () =>
        recorder.record(runCreated()),
      ),
    ).rejects.toThrowError("span_attr_invalid");
  });

  it("exports only registered attributes and the recorded event sequence", async () => {
    const recorder = makeRecorder(new InMemoryEventStore());
    const event = await recorder.withStepSpan(TOOL_CALL_SPAN, {}, () =>
      recorder.record(runCreated()),
    );
    const [span] = finishedSpans;

    expect(span?.attributes).toEqual({
      "harness.run.id": runId,
      "harness.event.seq": event.seq,
    });
    expect(span?.spanContext().traceId).toBe(event.traceId);
    expect(span?.spanContext().spanId).toBe(event.spanId);
  });

  it("returns an empty batch without accessing the store", async () => {
    const store = new InMemoryEventStore();
    const append = vi.spyOn(store, "append");
    const recorder = makeRecorder(store);

    await expect(recorder.recordBatch([])).resolves.toEqual([]);
    expect(append).not.toHaveBeenCalled();
  });

  it("marks failed spans without exposing error messages", async () => {
    const recorder = makeRecorder(new InMemoryEventStore());

    await expect(
      recorder.withStepSpan(MODEL_CALL_SPAN, {}, () => {
        throw new LeaseLostError(3);
      }),
    ).rejects.toBeInstanceOf(LeaseLostError);

    const [span] = finishedSpans;
    expect(span?.status.code).toBe(SpanStatusCode.ERROR);
    expect(span?.status.message).toBeUndefined();
    expect(span?.attributes["harness.error.code"]).toBe("lease_lost");
  });
});

function runCreatedEvent(): Event {
  return {
    runId,
    segmentId,
    seq: 0,
    ts: 100,
    v: 1,
    traceId: "a".repeat(32),
    spanId: "b".repeat(16),
    type: "run_created",
    configHash: hash,
    policyVersion: "test.policy",
    depth: 0,
  };
}
