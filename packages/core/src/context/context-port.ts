// SPDX-License-Identifier: Apache-2.0
import {
  HarnessError,
  type Event,
  type JsonValue,
  type Message,
} from "@harness/schemas";
import {
  ContextSnapshotSchema,
  type ContextStrategy,
  type ContextStrategyInput,
} from "@harness/context";
import type { ContextPort } from "../ports.js";

/** Context build dependencies configured for a strategy-backed run-loop port. */
export interface StrategyContextPortOptions extends Omit<ContextStrategyInput, "events"> {
  /** Initial calibration state to include in the context checkpoint. */
  readonly calibration?: JsonValue;
}

class ContextSnapshotError extends HarnessError {
  override readonly code = "context_snapshot_invalid";

  constructor() {
    super("The context snapshot is invalid.");
  }
}

/**
 * Adapts a strategy package implementation to the core run-loop context port.
 */
export class StrategyContextPort implements ContextPort {
  private calibration: JsonValue;

  constructor(
    private readonly strategy: ContextStrategy,
    private readonly options: StrategyContextPortOptions,
  ) {
    this.calibration = options.calibration ?? null;
  }

  /** {@inheritDoc ContextPort.build} */
  async build(events: readonly Event[]): Promise<Message[]> {
    const result = await this.strategy.build({ ...this.options, events });
    return result.messages;
  }

  /** {@inheritDoc ContextPort.snapshot} */
  async snapshot(): Promise<JsonValue> {
    return ContextSnapshotSchema.parse({
      strategyId: this.strategy.id,
      strategyVersion: this.strategy.version,
      calibration: this.calibration,
    });
  }

  /** {@inheritDoc ContextPort.restore} */
  async restore(snapshot: JsonValue | undefined, _eventsAfterSnapshot: readonly Event[]): Promise<void> {
    if (snapshot === undefined) {
      this.calibration = null;
      return;
    }
    const result = ContextSnapshotSchema.safeParse(snapshot);
    if (!result.success) {
      throw new ContextSnapshotError();
    }
    this.calibration = result.data.calibration;
  }
}
