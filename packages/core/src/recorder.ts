// SPDX-License-Identifier: Apache-2.0
// All run-loop events must be created through this recorder.
import {
  context,
  isSpanContextValid,
  ROOT_CONTEXT,
  SpanStatusCode,
  trace,
  type AttributeValue,
  type Link,
  type Span,
  type SpanContext,
} from "@opentelemetry/api";
import {
  EventSchema,
  HarnessError,
  type Event,
  type Id,
  type NewEvent,
  type Snapshot,
} from "@harness/schemas";
import { SeqConflictError, type EventStore } from "@harness/store";
import type { SpanDefinition, SpanDefinitionShape } from "@harness/telemetry";
import { RUN_SPAN } from "./spans.js";

/** Clock used to timestamp recorded events. */
export interface Clock {
  /** Returns the current time as epoch milliseconds. */
  now(): number;
}

/** Event payload without fields supplied by the recorder or the store. */
export type EventPartial = NewEvent extends infer Candidate
  ? Candidate extends NewEvent
    ? Omit<Candidate, "runId" | "ts" | "traceId" | "spanId" | "segmentId">
    : never
  : never;

/** Error raised when another writer has advanced the event log. */
export class LeaseLostError extends HarnessError {
  /** Stable error code. */
  readonly code = "lease_lost";

  /**
   * Creates an error carrying the store's next free sequence number.
   *
   * @param storedHead - Next free sequence number reported by the store.
   */
  constructor(readonly storedHead: number) {
    super("The run event log lease was lost.");
  }
}

/** Error raised when an event is recorded without a valid active span. */
export class SpanContextMissingError extends HarnessError {
  /** Stable error code. */
  readonly code = "span_context_missing";

  /** Creates a missing-span-context error. */
  constructor() {
    super("A valid active span is required to record an event.");
  }
}

/**
 * Builds and appends events for one run segment, assigning sequence numbers
 * and associating them with the active span.
 */
export class RunRecorder {
  private nextSequence: number;
  private storedHead: number | undefined;
  private pendingAppend: Promise<void> = Promise.resolve();

  /**
   * Creates a recorder starting at the store's expected next sequence.
   *
   * @param store - Append-only event store for this run.
   * @param runId - Run identifier.
   * @param segmentId - Identifier for this execution segment.
   * @param startSeq - Next event sequence expected by the store.
   * @param clock - Clock used for event timestamps.
   */
  // eslint-disable-next-line max-params -- task 2.2 specifies this constructor signature
  constructor(
    private readonly store: EventStore,
    private readonly runId: Id,
    private readonly segmentId: Id,
    startSeq: number,
    private readonly clock: Clock,
  ) {
    this.nextSequence = startSeq;
  }

  /** The next sequence this recorder expects to append. */
  get nextSeq(): number {
    return this.nextSequence;
  }

  /**
   * Appends one event with recorder-owned envelope fields.
   *
   * @param partial - Event type, version, and payload.
   * @returns The validated event with its assigned sequence.
   * @throws LeaseLostError when another writer has advanced the log.
   */
  async record(partial: EventPartial): Promise<Event> {
    if (this.storedHead !== undefined) {
      throw new LeaseLostError(this.storedHead);
    }
    const spanContext = this.activeSpanContext();
    const [event] = await this.enqueue(() => this.append([partial], spanContext));
    if (event === undefined) {
      throw new SpanContextMissingError();
    }
    return event;
  }

  /**
   * Atomically appends a batch of events with consecutive sequence numbers.
   *
   * @param partials - Event payloads to append as one store operation.
   * @returns The validated events with their assigned sequences.
   * @throws LeaseLostError when another writer has advanced the log.
   */
  async recordBatch(partials: readonly EventPartial[]): Promise<Event[]> {
    if (partials.length === 0) {
      return [];
    }
    if (this.storedHead !== undefined) {
      throw new LeaseLostError(this.storedHead);
    }
    const spanContext = this.activeSpanContext();
    const events = await this.enqueue(() => this.append(partials, spanContext));
    return events;
  }

  /**
   * Atomically appends one checkpoint event with its snapshot.
   *
   * @param partial - Checkpoint event payload.
   * @param snapshot - Snapshot without its recorder-assigned sequence.
   * @returns The validated checkpoint event with its assigned sequence.
   * @throws LeaseLostError when another writer has advanced the log.
   */
  async recordWithSnapshot(
    partial: Extract<EventPartial, { type: "checkpoint_written" }>,
    snapshot: Omit<Snapshot, "atSeq">,
  ): Promise<Event> {
    if (this.storedHead !== undefined) {
      throw new LeaseLostError(this.storedHead);
    }
    const spanContext = this.activeSpanContext();
    return this.enqueue(() => this.appendWithSnapshot(partial, snapshot, spanContext));
  }

  /**
   * Runs a callback in a registered span and sets its event sequence after recording.
   *
   * @param definition - Registered span definition.
   * @param attrs - Additional allowlisted attributes for the span.
   * @param fn - Callback that returns the event recorded in this span.
   * @returns The event returned by the callback.
   */
  async withStepSpan(
    definition: SpanDefinition<SpanDefinitionShape>,
    attrs: Readonly<Record<string, AttributeValue>>,
    fn: (span: Span) => Event | Promise<Event>,
    links?: readonly Link[],
  ): Promise<Event> {
    const spanAttrs: Record<string, unknown> = {
      ...attrs,
      "harness.run.id": this.runId,
      "harness.event.seq": undefined,
    };
    if (definition.name === "harness.run") {
      spanAttrs["harness.segment.id"] = this.segmentId;
    }

    const span = definition.start(
      spanAttrs,
      definition.name === RUN_SPAN.name
        ? { parent: ROOT_CONTEXT, ...(links === undefined ? {} : { links: [...links] }) }
        : undefined,
    );
    const activeContext = trace.setSpan(context.active(), span);
    return context.with(activeContext, async () => {
      try {
        const event = await fn(span);
        span.setAttribute("harness.event.seq", event.seq);
        return event;
      } catch (error) {
        span.setStatus({ code: SpanStatusCode.ERROR });
        if (error instanceof HarnessError) {
          span.setAttribute("harness.error.code", error.code);
        }
        throw error;
      } finally {
        span.end();
      }
    });
  }

  private activeSpanContext(): SpanContext {
    const spanContext = trace.getSpan(context.active())?.spanContext();
    if (spanContext === undefined || !isSpanContextValid(spanContext)) {
      throw new SpanContextMissingError();
    }
    return spanContext;
  }

  private enqueue<Result>(operation: () => Promise<Result>): Promise<Result> {
    const result = this.pendingAppend.then(operation);
    this.pendingAppend = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async append(
    partials: readonly EventPartial[],
    spanContext: SpanContext,
  ): Promise<Event[]> {
    if (this.storedHead !== undefined) {
      throw new LeaseLostError(this.storedHead);
    }

    const expectedSeq = this.nextSequence;
    const newEvents: NewEvent[] = partials.map((partial) => ({
      ...partial,
      runId: this.runId,
      ts: this.clock.now(),
      traceId: spanContext.traceId,
      spanId: spanContext.spanId,
      segmentId: this.segmentId,
    }));

    try {
      const result = await this.store.append(this.runId, newEvents, expectedSeq);
      this.nextSequence = result.nextSeq;
    } catch (error) {
      if (error instanceof SeqConflictError) {
        this.storedHead = error.actual;
        throw new LeaseLostError(error.actual);
      }
      throw error;
    }

    return newEvents.map((event, index) =>
      EventSchema.parse({ ...event, seq: expectedSeq + index }),
    );
  }

  private async appendWithSnapshot(
    partial: Extract<EventPartial, { type: "checkpoint_written" }>,
    snapshot: Omit<Snapshot, "atSeq">,
    spanContext: SpanContext,
  ): Promise<Event> {
    if (this.storedHead !== undefined) {
      throw new LeaseLostError(this.storedHead);
    }

    const expectedSeq = this.nextSequence;
    const newEvent: NewEvent = {
      ...partial,
      atSeq: expectedSeq,
      runId: this.runId,
      ts: this.clock.now(),
      traceId: spanContext.traceId,
      spanId: spanContext.spanId,
      segmentId: this.segmentId,
    };

    try {
      const result = await this.store.appendWithSnapshot(this.runId, [newEvent], expectedSeq, {
        ...snapshot,
        atSeq: expectedSeq,
      });
      this.nextSequence = result.nextSeq;
    } catch (error) {
      if (error instanceof SeqConflictError) {
        this.storedHead = error.actual;
        throw new LeaseLostError(error.actual);
      }
      throw error;
    }

    return EventSchema.parse({ ...newEvent, seq: expectedSeq });
  }
}
