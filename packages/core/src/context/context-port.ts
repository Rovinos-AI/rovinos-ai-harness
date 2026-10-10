// SPDX-License-Identifier: Apache-2.0
import { HarnessError, type Event, type JsonValue, type Message } from "@harness/schemas";
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
  private readonly buildOptions: Omit<ContextStrategyInput, "events">;

  constructor(
    private readonly strategy: ContextStrategy,
    options: StrategyContextPortOptions,
  ) {
    const { calibration, ...buildOptions } = options;
    this.calibration = calibration ?? null;
    this.buildOptions = buildOptions;
  }

  /** {@inheritDoc ContextPort.build} */
  async build(events: readonly Event[]): Promise<Message[]> {
    const result = await this.strategy.build({ ...this.buildOptions, events });
    return result.messages;
  }

  /** {@inheritDoc ContextPort.snapshot} */
  snapshot(): Promise<JsonValue> {
    return ContextSnapshotSchema.parseAsync({
      strategyId: this.strategy.id,
      strategyVersion: this.strategy.version,
      calibration: this.calibration,
    });
  }

  /** {@inheritDoc ContextPort.restore} */
  restore(snapshot: JsonValue | undefined, _eventsAfterSnapshot: readonly Event[]): Promise<void> {
    if (snapshot === undefined) {
      this.calibration = null;
      return Promise.resolve();
    }
    const result = ContextSnapshotSchema.safeParse(snapshot);
    if (!result.success) {
      return Promise.reject(new ContextSnapshotError());
    }
    this.calibration = result.data.calibration;
    return Promise.resolve();
  }
}
