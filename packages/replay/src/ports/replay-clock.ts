// SPDX-License-Identifier: Apache-2.0
import type { Clock } from "@rovinos/core";
import type { Event } from "@rovinos/schemas";

/** Deterministic clock starting at the first recorded event and advancing by one millisecond. */
export class ReplayClock implements Clock {
  private currentTime: number;

  /** @param events - Ordered events from the resolved root run. */
  constructor(events: readonly Event[]) {
    this.currentTime = events[0]?.ts ?? 0;
  }

  /** Returns the current replay timestamp, then advances it by one millisecond. */
  now(): number {
    const now = this.currentTime;
    this.currentTime += 1;
    return now;
  }
}
