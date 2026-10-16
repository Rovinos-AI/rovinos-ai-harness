// SPDX-License-Identifier: Apache-2.0
import type { AppSpan } from "@harness/schemas";
import type { AppTelemetryBridge, AppTelemetryStats, AppTraceContext } from "./types.js";

const activationTimeoutMs = 2_000;
const flushIntervalMs = 2_000;
const flushThreshold = 20;
const maxBatchSpans = 50;
const maxBatchLength = 14 * 1024;
const maxPendingSpans = 100;
const initialBackoffMs = 500;
const maxBackoffMs = 8_000;
const traceparentPattern = /^00-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/u;

/** Host-activated batching transport for recorded app spans. */
export interface AppTelemetryTransport {
  /** Whether the host confirmed the telemetry tool is callable. */
  readonly active: boolean;
  /** Informational host trace identifier. */
  readonly traceContext: AppTraceContext;
  /** Queue one validated app span. */
  record(span: AppSpan): void;
  /** Send pending spans when allowed by the backoff schedule. */
  flush(): Promise<void>;
  /** Read local-only transport counters. */
  stats(): AppTelemetryStats;
  /** Clear timers and listeners, then attempt one final flush. */
  dispose(): Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readTraceId(result: unknown): string | undefined {
  try {
    if (!isRecord(result) || !isRecord(result._meta)) {
      return undefined;
    }
    const traceparent = result._meta.traceparent;
    if (typeof traceparent !== "string") {
      return undefined;
    }
    const match = traceparentPattern.exec(traceparent);
    if (match === null || match[1] === "0".repeat(32) || match[2] === "0".repeat(16)) {
      return undefined;
    }
    return match[1];
  } catch {
    return undefined;
  }
}

function isErrorResult(result: unknown): boolean {
  try {
    return isRecord(result) && result.isError === true;
  } catch {
    return true;
  }
}

function isRateLimited(value: unknown): boolean {
  try {
    if (!isRecord(value)) {
      return false;
    }
    if (
      value.code === "rate_limited" ||
      value.error === "rate_limited" ||
      value.message === "rate_limited"
    ) {
      return true;
    }
    if (Array.isArray(value.content)) {
      return value.content.some(
        (part: unknown) => isRecord(part) && part.type === "text" && part.text === "rate_limited",
      );
    }
    return false;
  } catch {
    return false;
  }
}

function batchLength(spans: readonly AppSpan[]): number {
  try {
    return JSON.stringify({ spans }).length;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

class BrowserAppTelemetryTransport implements AppTelemetryTransport {
  readonly #bridge: AppTelemetryBridge | undefined;
  readonly #pending: AppSpan[] = [];
  readonly #traceContextState: { value: string | undefined } = { value: undefined };
  readonly traceContext: AppTraceContext;
  #active = false;
  #dropped = 0;
  #disposed = false;
  #inFlight: Promise<void> | undefined;
  #interval: ReturnType<typeof setInterval> | undefined;
  #retryTimer: ReturnType<typeof setTimeout> | undefined;
  #backoffMs = 0;
  #pageHideListener: (() => void) | undefined;
  #visibilityListener: (() => void) | undefined;

  constructor(bridge: AppTelemetryBridge | undefined) {
    this.#bridge = bridge;
    const traceContextState = this.#traceContextState;
    this.traceContext = Object.freeze({
      get traceId() {
        return traceContextState.value;
      },
    });
    void this.#activate();
  }

  get active(): boolean {
    return this.#active;
  }

  record(span: AppSpan): void {
    try {
      if (!this.#active || this.#disposed) {
        return;
      }
      if (this.#pending.length >= maxPendingSpans) {
        this.#pending.shift();
        this.#dropped += 1;
      }
      this.#pending.push(span);
      if (this.#pending.length >= flushThreshold) {
        void this.#flush();
      }
    } catch {
      return;
    }
  }

  flush(): Promise<void> {
    return this.#flush();
  }

  stats(): AppTelemetryStats {
    return { dropped: this.#dropped };
  }

  async dispose(): Promise<void> {
    try {
      if (this.#disposed) {
        return;
      }
      this.#disposed = true;
      if (this.#interval !== undefined) {
        clearInterval(this.#interval);
        this.#interval = undefined;
      }
      this.#clearRetryTimer();
      if (typeof window !== "undefined" && this.#pageHideListener !== undefined) {
        window.removeEventListener("pagehide", this.#pageHideListener);
      }
      if (typeof document !== "undefined" && this.#visibilityListener !== undefined) {
        document.removeEventListener("visibilitychange", this.#visibilityListener);
      }
      await this.#flush(true);
    } catch {
      return;
    } finally {
      this.#active = false;
    }
  }

  async #activate(): Promise<void> {
    if (this.#bridge === undefined) {
      return;
    }
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        this.#bridge.callTool("harness.telemetry.emit", { spans: [] }),
        new Promise<undefined>((resolve) => {
          timeout = setTimeout(() => {
            resolve(undefined);
          }, activationTimeoutMs);
        }),
      ]);
      if (result === undefined || isErrorResult(result) || this.#disposed) {
        return;
      }
      this.#traceContextState.value = readTraceId(result);
      this.#active = true;
      this.#addLifecycleListeners();
    } catch {
      return;
    } finally {
      if (timeout !== undefined) {
        clearTimeout(timeout);
      }
    }
  }

  #addLifecycleListeners(): void {
    try {
      this.#interval = setInterval(() => {
        void this.#flush();
      }, flushIntervalMs);
      if (typeof window !== "undefined") {
        this.#pageHideListener = () => {
          void this.#flush();
        };
        window.addEventListener("pagehide", this.#pageHideListener);
      }
      if (typeof document !== "undefined") {
        this.#visibilityListener = () => {
          if (document.visibilityState === "hidden") {
            void this.#flush();
          }
        };
        document.addEventListener("visibilitychange", this.#visibilityListener);
      }
    } catch {
      return;
    }
  }

  #clearRetryTimer(): void {
    if (this.#retryTimer !== undefined) {
      clearTimeout(this.#retryTimer);
      this.#retryTimer = undefined;
    }
  }

  #nextBatch(): AppSpan[] {
    const batch = this.#pending.slice(0, maxBatchSpans);
    while (batch.length > 0 && batchLength(batch) > maxBatchLength) {
      batch.pop();
    }
    return batch;
  }

  #restoreBatch(batch: readonly AppSpan[]): void {
    this.#pending.unshift(...batch);
    while (this.#pending.length > maxPendingSpans) {
      this.#pending.shift();
      this.#dropped += 1;
    }
  }

  #scheduleRetry(): void {
    if (this.#disposed) {
      return;
    }
    this.#backoffMs =
      this.#backoffMs === 0 ? initialBackoffMs : Math.min(this.#backoffMs * 2, maxBackoffMs);
    this.#clearRetryTimer();
    this.#retryTimer = setTimeout(() => {
      this.#retryTimer = undefined;
      void this.#flush();
    }, this.#backoffMs);
  }

  async #sendBatch(batch: AppSpan[]): Promise<void> {
    try {
      const result = await this.#bridge?.callTool("harness.telemetry.emit", { spans: batch });
      if (isErrorResult(result)) {
        this.#restoreBatch(batch);
        if (isRateLimited(result)) {
          this.#scheduleRetry();
        }
        return;
      }
      this.#traceContextState.value = readTraceId(result) ?? this.#traceContextState.value;
      this.#backoffMs = 0;
    } catch (error) {
      this.#restoreBatch(batch);
      if (isRateLimited(error)) {
        this.#scheduleRetry();
      }
    }
  }

  #shouldSkipFlush(force: boolean): boolean {
    return (
      !this.#active || (this.#disposed && !force) || (this.#retryTimer !== undefined && !force)
    );
  }

  async #flush(force = false): Promise<void> {
    try {
      if (this.#shouldSkipFlush(force)) {
        return;
      }
      if (this.#inFlight !== undefined) {
        await this.#inFlight;
        if (this.#pending.length === 0 || this.#retryTimer !== undefined) {
          return;
        }
      }
      const batch = this.#nextBatch();
      if (batch.length === 0) {
        return;
      }
      this.#pending.splice(0, batch.length);
      const sending = this.#sendBatch(batch);
      this.#inFlight = sending;
      try {
        await sending;
      } finally {
        if (this.#inFlight === sending) {
          this.#inFlight = undefined;
        }
      }
      if (
        this.#pending.length >= flushThreshold &&
        this.#retryTimer === undefined &&
        !this.#disposed
      ) {
        void this.#flush();
      }
    } catch {
      return;
    }
  }
}

/**
 * Creates the host-activated batching transport for recorded app spans.
 *
 * @param bridge - Optional host bridge; a missing or unavailable host leaves the transport inert.
 * @returns A no-throw transport with bounded buffering and lifecycle cleanup.
 */
export function createAppTelemetryTransport(
  bridge: AppTelemetryBridge | undefined,
): AppTelemetryTransport {
  return new BrowserAppTelemetryTransport(bridge);
}
