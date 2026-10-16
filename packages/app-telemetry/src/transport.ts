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
const retryJitterRatio = 0.2;
const traceparentPattern = /^00-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/u;
const emptyBatchByteLength = new TextEncoder().encode('{"spans":[]}').length;

/** Host-activated batching transport for recorded app spans. */
export interface AppTelemetryTransport {
  /** Whether the host confirmed the telemetry tool is callable. */
  readonly active: boolean;
  /** Informational host trace identifier. */
  readonly traceContext: AppTraceContext;
  /** Updates the informational trace context from host tool-result metadata. */
  setHostMetadata(metadata: unknown): void;
  /** Queue one validated app span. */
  record(span: AppSpan): void;
  /** Send pending spans when allowed by the backoff schedule. */
  flush(): Promise<void>;
  /** Read local-only transport counters. */
  stats(): AppTelemetryStats;
  /** Clear timers and listeners, drain pending spans, and count abandoned spans as dropped. */
  dispose(): Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readTraceId(metadata: unknown): string | undefined {
  try {
    if (!isRecord(metadata)) {
      return undefined;
    }
    const traceparent = metadata.traceparent;
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
    if (isRecord(value.structuredContent) && value.structuredContent.code === "rate_limited") {
      return true;
    }
    if (
      value.code === "rate_limited" ||
      value.error === "rate_limited" ||
      value.message === "rate_limited" ||
      (typeof value.message === "string" && isRateLimitedText(value.message))
    ) {
      return true;
    }
    if (Array.isArray(value.content)) {
      return value.content.some(
        (part: unknown) => isRecord(part) && part.type === "text" && isRateLimitedText(part.text),
      );
    }
    return false;
  } catch {
    return false;
  }
}

function isRateLimitedText(value: unknown): boolean {
  if (typeof value !== "string") {
    return false;
  }
  return /^(?:error:\s*)?(?:rate_limited|\{\s*"(?:code|error)"\s*:\s*"rate_limited"\s*\})$/iu.test(
    value.trim(),
  );
}

function spanByteLength(span: AppSpan): number {
  try {
    return new TextEncoder().encode(JSON.stringify(span)).length;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

class BrowserAppTelemetryTransport implements AppTelemetryTransport {
  readonly #bridge: AppTelemetryBridge | undefined;
  readonly #hostReady: Promise<void> | undefined;
  readonly #random: () => number;
  readonly #pending: AppSpan[] = [];
  readonly #traceContextState: { value: string | undefined } = { value: undefined };
  readonly traceContext: AppTraceContext;
  #active = false;
  #dropped = 0;
  #disposed = false;
  #inFlight: Promise<boolean> | undefined;
  #interval: ReturnType<typeof setInterval> | undefined;
  #retryTimer: ReturnType<typeof setTimeout> | undefined;
  #backoffMs = 0;
  #pageHideListener: (() => void) | undefined;
  #visibilityListener: (() => void) | undefined;

  constructor(
    bridge: AppTelemetryBridge | undefined,
    hostReady: Promise<void> | undefined,
    random: (() => number) | undefined,
  ) {
    this.#bridge = bridge;
    this.#hostReady = hostReady;
    this.#random = random ?? Math.random;
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

  setHostMetadata(metadata: unknown): void {
    try {
      this.#traceContextState.value = readTraceId(metadata) ?? this.#traceContextState.value;
    } catch {
      return;
    }
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
      this.#dropped += this.#pending.length;
      this.#pending.length = 0;
    } catch {
      return;
    } finally {
      this.#active = false;
    }
  }

  #activationShouldStop(): boolean {
    return this.#disposed;
  }

  async #activate(): Promise<void> {
    if (this.#bridge === undefined) {
      return;
    }
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await this.#hostReady;
      if (this.#activationShouldStop()) {
        return;
      }
      const activation = await Promise.race([
        this.#bridge
          .callTool("harness.telemetry.emit", { spans: [] })
          .then((value) => ({ completed: true as const, value })),
        new Promise<{ readonly completed: false }>((resolve) => {
          timeout = setTimeout(() => {
            resolve({ completed: false });
          }, activationTimeoutMs);
        }),
      ]);
      if (
        !activation.completed ||
        !isRecord(activation.value) ||
        isErrorResult(activation.value) ||
        this.#activationShouldStop()
      ) {
        return;
      }
      this.setHostMetadata(activation.value._meta);
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

  #nextBatch(): { readonly batch: AppSpan[]; readonly consumed: number } {
    const batch: AppSpan[] = [];
    let consumed = 0;
    let byteLength = emptyBatchByteLength;
    while (consumed < this.#pending.length && batch.length < maxBatchSpans) {
      const span = this.#pending[consumed];
      if (span === undefined) {
        break;
      }
      const spanLength = spanByteLength(span);
      if (emptyBatchByteLength + spanLength > maxBatchLength) {
        consumed += 1;
        this.#dropped += 1;
        continue;
      }
      const nextByteLength = byteLength + spanLength + (batch.length === 0 ? 0 : 1);
      if (nextByteLength > maxBatchLength) {
        break;
      }
      batch.push(span);
      byteLength = nextByteLength;
      consumed += 1;
    }
    return { batch, consumed };
  }

  #restoreBatch(batch: readonly AppSpan[]): void {
    this.#pending.unshift(...batch);
    while (this.#pending.length > maxPendingSpans) {
      this.#pending.shift();
      this.#dropped += 1;
    }
  }

  #scheduleRetry(rateLimited: boolean): void {
    if (this.#disposed) {
      return;
    }
    if (rateLimited) {
      this.#backoffMs =
        this.#backoffMs === 0 ? initialBackoffMs : Math.min(this.#backoffMs * 2, maxBackoffMs);
    }
    const delay = rateLimited ? this.#backoffMs : initialBackoffMs;
    let randomValue = 0.5;
    try {
      const value = this.#random();
      if (Number.isFinite(value)) {
        randomValue = Math.max(0, Math.min(1, value));
      }
    } catch {
      randomValue = 0.5;
    }
    const jitteredBackoff = Math.min(
      maxBackoffMs,
      delay * (1 - retryJitterRatio + 2 * retryJitterRatio * randomValue),
    );
    this.#clearRetryTimer();
    this.#retryTimer = setTimeout(() => {
      this.#retryTimer = undefined;
      void this.#flush();
    }, jitteredBackoff);
  }

  async #sendBatch(batch: AppSpan[]): Promise<boolean> {
    try {
      const result = await this.#bridge?.callTool("harness.telemetry.emit", { spans: batch });
      if (isErrorResult(result)) {
        this.#restoreBatch(batch);
        this.#scheduleRetry(isRateLimited(result));
        return false;
      }
      this.setHostMetadata(isRecord(result) ? result._meta : undefined);
      this.#backoffMs = 0;
      return true;
    } catch (error) {
      this.#restoreBatch(batch);
      this.#scheduleRetry(isRateLimited(error));
      return false;
    }
  }

  #shouldSkipFlush(force: boolean): boolean {
    return (
      !this.#active || (this.#disposed && !force) || (this.#retryTimer !== undefined && !force)
    );
  }

  async #waitForInFlight(force: boolean): Promise<boolean> {
    while (this.#inFlight !== undefined) {
      if (!(await this.#inFlight) || this.#shouldSkipFlush(force)) {
        return false;
      }
    }
    return !this.#shouldSkipFlush(force);
  }

  async #sendNextBatch(): Promise<boolean> {
    const { batch, consumed } = this.#nextBatch();
    if (consumed > 0) {
      this.#pending.splice(0, consumed);
    }
    if (batch.length === 0) {
      return consumed > 0;
    }
    const sending = this.#sendBatch(batch);
    this.#inFlight = sending;
    try {
      return await sending;
    } finally {
      if (this.#inFlight === sending) {
        this.#inFlight = undefined;
      }
    }
  }

  #shouldDrainAgain(force: boolean): boolean {
    return (
      force ||
      (this.#pending.length >= flushThreshold && this.#retryTimer === undefined && !this.#disposed)
    );
  }

  async #flush(force = false): Promise<void> {
    try {
      while (!this.#shouldSkipFlush(force)) {
        if (!(await this.#waitForInFlight(force)) || this.#pending.length === 0) {
          return;
        }
        if (!(await this.#sendNextBatch()) || !this.#shouldDrainAgain(force)) {
          return;
        }
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
  hostReady?: Promise<void>,
  random?: () => number,
): AppTelemetryTransport {
  return new BrowserAppTelemetryTransport(bridge, hostReady, random);
}
