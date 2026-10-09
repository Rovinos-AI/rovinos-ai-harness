// SPDX-License-Identifier: Apache-2.0
import { isSpanContextValid } from "@opentelemetry/api";
import {
  HarnessError,
  Traceparent,
  type Code,
  type Event,
  type Id,
  type Snapshot,
} from "@harness/schemas";
import type { Clock, RunRecorder } from "./recorder.js";
import type { ContextPort, IdGenerator } from "./ports.js";
import type { RunState } from "./run-state.js";
import { CHECKPOINT_SPAN } from "./spans.js";

/** Dependencies for writing durable checkpoints. */
export interface CheckpointerOptions {
  readonly recorder: RunRecorder;
  readonly runId: Id;
  readonly context: ContextPort;
  readonly ids: IdGenerator;
  readonly clock: Clock;
  readonly checkpointEveryEvents?: number;
}

/** Error raised when a checkpoint is attempted without a valid active span. */
export class NoActiveSpanError extends HarnessError {
  /** Stable error code. */
  readonly code = "no_active_span";

  /** Creates a missing-span-context error. */
  constructor() {
    super("A valid active span is required to write a checkpoint.");
    this.name = "NoActiveSpanError";
  }
}

/** Writes event-and-snapshot checkpoints on demand and at the configured cadence. */
export class Checkpointer {
  private readonly checkpointEveryEvents: number;

  /**
   * Creates a checkpoint writer.
   *
   * @param options - Recorder, context port, deterministic ID source, and cadence.
   */
  constructor(private readonly options: CheckpointerOptions) {
    this.checkpointEveryEvents = options.checkpointEveryEvents ?? 20;
  }

  /**
   * Atomically writes a checkpoint and its snapshot.
   *
   * @param state - Folded run state at the checkpoint boundary.
   * @param reason - Bounded reason code attached to the checkpoint span.
   * @returns The persisted checkpoint event.
   * @throws NoActiveSpanError when the checkpoint span has no valid context.
   */
  async write(state: RunState, reason: Code): Promise<Event> {
    const snapshotId = this.options.ids.next();
    return this.options.recorder.withStepSpan(
      CHECKPOINT_SPAN,
      { "harness.checkpoint.reason": reason },
      async (span) => {
        const spanContext = span.spanContext();
        if (!isSpanContextValid(spanContext)) {
          throw new NoActiveSpanError();
        }

        const traceparent = Traceparent.parse(`00-${spanContext.traceId}-${spanContext.spanId}-01`);
        const contextSnapshot = await this.options.context.snapshot();
        const snapshot: Omit<Snapshot, "atSeq"> = {
          snapshotId,
          runId: this.options.runId,
          createdAt: this.options.clock.now(),
          traceparent,
          context: contextSnapshot,
          plan: state.plan ?? null,
        };
        return this.options.recorder.recordWithSnapshot(
          {
            type: "checkpoint_written",
            v: 1,
            checkpointId: snapshotId,
            atSeq: this.options.recorder.nextSeq,
            traceparent,
          },
          snapshot,
        );
      },
    );
  }

  /**
   * Writes a checkpoint when the event cadence is reached or the run is suspended.
   *
   * @param state - Folded run state after a run-loop step.
   * @returns The checkpoint event, or undefined when no checkpoint is due.
   */
  maybeCheckpoint(state: RunState): Promise<Event | undefined> {
    const afterCheckpoint = state.lastCheckpoint === undefined ? 0 : state.lastCheckpoint.atSeq + 1;
    const eventsSinceCheckpoint = state.nextSeq - afterCheckpoint;
    if (state.status !== "suspended" && eventsSinceCheckpoint < this.checkpointEveryEvents) {
      return Promise.resolve(undefined);
    }
    return this.write(state, state.status === "suspended" ? "suspended" : "cadence");
  }
}
