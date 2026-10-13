// SPDX-License-Identifier: Apache-2.0
import type { Clock } from "@harness/core";
import type { HostConfig } from "@harness/schemas";

interface AppSessionLimitState {
  batchTokens: number;
  lastRefillMs: number;
  acceptedSpanTimes: number[];
  lifetimeAcceptedSpans: number;
}

/** Rate and accepted-span limits keyed by host-owned app session id. */
export class AppRateLimiter {
  readonly #limits: HostConfig["limits"];
  readonly #clock: Clock;
  readonly #sessions = new Map<string, AppSessionLimitState>();

  /**
   * Creates a limiter using the validated host limits and injected clock.
   *
   * @param limits - Batch and accepted-span caps from host configuration.
   * @param clock - Deterministic epoch-millisecond clock.
   */
  constructor(limits: HostConfig["limits"], clock: Clock) {
    this.#limits = limits;
    this.#clock = clock;
  }

  /**
   * Acquires one batch token from the session's sustained-rate token bucket.
   *
   * @param sessionId - Host-generated app session identifier.
   * @returns Whether the batch is within the configured rate and burst.
   */
  tryAcquireBatch(sessionId: string): boolean {
    const now = this.#clock.now();
    const state = this.#getState(sessionId, now);
    const elapsed = Math.max(0, now - state.lastRefillMs);
    state.batchTokens = Math.min(
      this.#limits.batchBurst,
      state.batchTokens + (elapsed * this.#limits.batchesPerSecond) / 1_000,
    );
    state.lastRefillMs = Math.max(state.lastRefillMs, now);
    if (state.batchTokens < 1) {
      return false;
    }
    state.batchTokens -= 1;
    return true;
  }

  /**
   * Reserves one span within both the rolling-minute and session-lifetime caps.
   *
   * @param sessionId - Host-generated app session identifier.
   * @returns Whether one additional span can be accepted.
   */
  tryAcceptSpan(sessionId: string): boolean {
    const now = this.#clock.now();
    const state = this.#getState(sessionId, now);
    const cutoff = now - 60_000;
    state.acceptedSpanTimes = state.acceptedSpanTimes.filter((timestamp) => timestamp > cutoff);
    if (
      state.acceptedSpanTimes.length >= this.#limits.spansPerMinute ||
      state.lifetimeAcceptedSpans >= this.#limits.spansPerSessionLifetime
    ) {
      return false;
    }
    state.acceptedSpanTimes.push(now);
    state.lifetimeAcceptedSpans += 1;
    return true;
  }

  /** Releases all rate-limit state when a session ends. */
  endSession(sessionId: string): void {
    this.#sessions.delete(sessionId);
  }

  #getState(sessionId: string, now: number): AppSessionLimitState {
    let state = this.#sessions.get(sessionId);
    if (state === undefined) {
      state = {
        batchTokens: this.#limits.batchBurst,
        lastRefillMs: now,
        acceptedSpanTimes: [],
        lifetimeAcceptedSpans: 0,
      };
      this.#sessions.set(sessionId, state);
    }
    return state;
  }
}
