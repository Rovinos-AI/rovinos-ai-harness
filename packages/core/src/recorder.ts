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
  type Context,
  type SpanContext,
} from "@opentelemetry/api";
import {
  EventSchema,
  HarnessError,
  type Event,
  type Id,
  type NewEvent,
  type Snapshot,
  type WorkspaceRef,
} from "@rovinos/schemas";
import { SeqConflictError, type EventStore, type UsageLedgerDelta } from "@rovinos/store";
import {
  sentinelTripQueue,
  setActiveSpanAttribute,
  type SpanDefinition,
  type SpanDefinitionShape,
  type TripQueue,
} from "@rovinos/telemetry";
import { RUN_SPAN } from "./spans.js";
import { DeploymentStartupError } from "./runtime-deployment.js";

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

/** Preserves event-store failures across tool boundaries without recording a tool result. */
export class RunEventRecordingError extends HarnessError {
  readonly code = "run_event_record_failed";

  /** Creates an error carrying the original recorder failure. */
  constructor(readonly failure: unknown) {
    super("Run event recording failed.");
    this.name = "RunEventRecordingError";
  }
}

/** Optional parent context and links for a registered span. */
export interface StepSpanOptions {
  readonly links?: readonly Link[];
  readonly parentContext?: Context;
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
    private readonly tripQueue: TripQueue = sentinelTripQueue,
    private readonly leaseOwner?: Id,
    private readonly signal?: AbortSignal,
  ) {
    this.nextSequence = startSeq;
  }

  /** The next sequence this recorder expects to append. */
  get nextSeq(): number {
    return this.nextSequence;
  }

  /** Read the workspace references attached to the snapshots retained by the event store. */
  async retainedWorkspaceRefs(snapshotKeep: number): Promise<WorkspaceRef[]> {
    if (!Number.isSafeInteger(snapshotKeep) || snapshotKeep < 1) {
      throw new TypeError("Snapshot retention must be a positive integer");
    }
    const snapshots = await this.store.retainedSnapshots(this.runId, snapshotKeep);
    return snapshots.flatMap((snapshot) =>
      snapshot.workspaceRef === undefined ? [] : [snapshot.workspaceRef],
    );
  }

  /**
   * Appends one event with recorder-owned envelope fields.
   *
   * @param partial - Event type, version, and payload.
   * @returns The validated event with its assigned sequence.
   * @throws LeaseLostError when another writer has advanced the log.
   */
  async record(
    partial: EventPartial,
    usageUpdates: readonly UsageLedgerDelta[] = [],
  ): Promise<Event> {
    if (this.storedHead !== undefined) {
      throw new LeaseLostError(this.storedHead);
    }
    const spanContext = this.activeSpanContext();
    const [event] = await this.enqueue(() => this.append([partial], spanContext, usageUpdates));
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
  async recordBatch(
    partials: readonly EventPartial[],
    usageUpdates: readonly UsageLedgerDelta[] = [],
  ): Promise<Event[]> {
    if (partials.length === 0) {
      return [];
    }
    if (this.storedHead !== undefined) {
      throw new LeaseLostError(this.storedHead);
    }
    const spanContext = this.activeSpanContext();
    const events = await this.enqueue(() => this.append(partials, spanContext, usageUpdates));
    return events;
  }

  /**
   * Append this run's queued sentinel trips through the recorder's serialized write path.
   *
   * @returns The metadata-only `pii_action` events appended for this run.
   */
  async drainTrips(): Promise<Event[]> {
    const trips = this.tripQueue.drainForRun(this.runId);
    if (trips.length === 0) {
      return [];
    }
    try {
      return await this.recordBatch(
        trips.map(({ entities }) => ({
          type: "pii_action",
          v: 1,
          boundary: "telemetry_export",
          action: "blocked",
          entities: entities.map(({ type, count }) => ({ type, count })),
        })),
      );
    } catch (error) {
      this.tripQueue.restore(trips);
      throw error;
    }
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
    options: StepSpanOptions = {},
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
        ? {
            parent: options.parentContext ?? ROOT_CONTEXT,
            ...(options.links === undefined ? {} : { links: [...options.links] }),
          }
        : undefined,
    );
    const activeContext = trace.setSpan(context.active(), span);
    return context.with(activeContext, async () => {
      try {
        const event = await fn(span);
        setActiveSpanAttribute("harness.event.seq", event.seq);
        return event;
      } catch (error) {
        span.setStatus({ code: SpanStatusCode.ERROR });
        if (error instanceof HarnessError) {
          setActiveSpanAttribute("harness.error.code", error.code);
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
    usageUpdates: readonly UsageLedgerDelta[],
  ): Promise<Event[]> {
    this.assertWritable();
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
      const result =
        usageUpdates.length === 0
          ? await this.store.append(this.runId, newEvents, expectedSeq, this.leaseOwner)
          : await this.store.appendWithUsage(this.runId, newEvents, expectedSeq, {
              usageUpdates,
              ...(this.leaseOwner === undefined ? {} : { leaseOwner: this.leaseOwner }),
            });
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
    this.assertWritable();
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
      const result = await this.store.appendWithSnapshot(
        this.runId,
        [newEvent],
        expectedSeq,
        {
          ...snapshot,
          atSeq: expectedSeq,
        },
        this.leaseOwner,
      );
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

  private assertWritable(): void {
    if (
      this.signal?.aborted === true &&
      this.signal.reason === "deployment_single_instance_violation"
    ) {
      throw new DeploymentStartupError("deployment_single_instance_violation");
    }
    if (this.signal?.aborted === true && this.signal.reason === "lease_lost") {
      throw new LeaseLostError(this.nextSequence);
    }
  }
}
