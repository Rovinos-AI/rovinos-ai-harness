// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import { Id } from "@harness/schemas";
import type { Event, Id as IdValue } from "@harness/schemas";
import type { IdGenerator } from "@harness/core";

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const CAPACITY = 32n ** 16n;

function base32(value: bigint): string {
  let remaining = value;
  let encoded = "";
  for (let index = 0; index < 16; index += 1) {
    encoded = `${ALPHABET.charAt(Number(remaining % 32n))}${encoded}`;
    remaining /= 32n;
  }
  return encoded;
}

function recordedIds(events: readonly Event[]): IdValue[] {
  const ids: IdValue[] = [];
  const seen = new Set<IdValue>();
  const add = (id: IdValue): void => {
    if (!seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  };
  const segments = new Map<IdValue, IdValue>();
  for (const event of events) {
    if (segments.get(event.runId) !== event.segmentId) {
      segments.set(event.runId, event.segmentId);
      if (event.type !== "run_created") {
        add(event.segmentId);
      }
    }
    if (event.type === "run_created") {
      add(event.runId);
      add(event.segmentId);
    } else if (event.type === "subagent_spawned") {
      add(event.childRunId);
    } else if (event.type === "model_request") {
      add(event.requestId);
    } else if (event.type === "approval_requested") {
      add(event.approvalId);
    } else if (event.type === "checkpoint_written") {
      add(event.checkpointId);
    }
  }
  return ids;
}

/** Generates recorded IDs in event order, then deterministic collision-free ULIDs. */
export class ReplayIdGenerator implements IdGenerator {
  private readonly ids: readonly IdValue[];
  private readonly usedIds: Set<IdValue>;
  private index = 0;
  private fallbackValue: bigint;
  private fallbackStarted = false;

  /**
   * @param events - Ordered events from the resolved root run.
   * @param seed - Stable fallback seed, defaulting to the run ID.
   * @param onExhausted - Called once when generation falls back from recorded IDs.
   */
  constructor(
    events: readonly Event[],
    seed = events[0]?.runId ?? "replay",
    private readonly onExhausted: () => void = () => undefined,
  ) {
    this.ids = recordedIds(events);
    this.usedIds = new Set(this.ids);
    const digest = createHash("sha256").update(seed).digest("hex").slice(0, 20);
    this.fallbackValue = BigInt(`0x${digest}`);
  }

  /** Returns the next recorded ID or a deterministic seeded fallback ID. */
  next(): IdValue {
    const recorded = this.ids[this.index];
    if (recorded !== undefined) {
      this.index += 1;
      return recorded;
    }
    if (!this.fallbackStarted) {
      this.fallbackStarted = true;
      this.onExhausted();
    }
    for (;;) {
      if (this.fallbackValue >= CAPACITY) {
        this.fallbackValue = 0n;
      }
      const candidate = Id.parse(`0000000000${base32(this.fallbackValue)}`);
      this.fallbackValue += 1n;
      if (!this.usedIds.has(candidate)) {
        this.usedIds.add(candidate);
        return candidate;
      }
    }
  }
}
