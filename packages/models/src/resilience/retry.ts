// SPDX-License-Identifier: Apache-2.0
import { HarnessError, ModelRetryConfigSchema } from "@harness/schemas";
import type { ModelRetryConfig } from "@harness/schemas";
import { ProviderError } from "../errors.js";

/** Normalized random source whose result is in the interval [0, 1). */
export type Random = () => number;

/** Abort-aware delay used by retries and provider limiters. */
export type Sleep = (milliseconds: number, signal: AbortSignal) => Promise<void>;

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error("Operation aborted.", { cause: signal.reason });
}

interface AttemptSignals {
  readonly combined: AbortSignal;
  readonly run: AbortSignal;
  readonly timeout: AbortSignal;
  readonly deadline: AbortSignal | undefined;
}

/** Error raised when the run deadline prevents another model attempt. */
export class DeadlineExceededError extends HarnessError {
  /** Stable deadline failure code. */
  readonly code = "deadline_exceeded";

  /**
   * @param lastError - Provider error that could not be retried before the deadline.
   */
  constructor(readonly lastError?: unknown) {
    super("The run deadline was exceeded.");
  }
}

/** System delay that rejects immediately when its signal is aborted. */
export const abortableSleep: Sleep = (milliseconds, signal) =>
  new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(abortError(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });

/** Dependencies for deterministic retry behavior. */
export interface RetryDependencies {
  readonly clock: { now(): number };
  readonly random: Random;
  readonly sleep: Sleep;
}

/** Inputs for one retry-managed provider operation. */
export interface RetryOptions<T> extends RetryDependencies {
  readonly policy: ModelRetryConfig;
  readonly signal: AbortSignal;
  readonly deadlineTs?: number;
  readonly onAttempt?: (attempt: number) => void;
  readonly operation: (signal: AbortSignal, lastError: unknown) => Promise<T>;
}

function checkDeadline(
  deadlineTs: number | undefined,
  clock: { now(): number },
  lastError: unknown,
): void {
  if (deadlineTs !== undefined && clock.now() >= deadlineTs) {
    throw new DeadlineExceededError(lastError);
  }
}

function delayForAttempt(
  policy: ModelRetryConfig,
  failedAttempt: number,
  random: Random,
  retryAfterMs: number | undefined,
): number {
  const ceiling = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** (failedAttempt - 1));
  const sample = random();
  if (!Number.isFinite(sample) || sample < 0 || sample >= 1) {
    throw new RangeError("Random must return a value in [0, 1).");
  }
  return Math.max(sample * ceiling, retryAfterMs ?? 0);
}

function abortAttempt(signals: AttemptSignals, lastError: unknown): never {
  if (signals.run.aborted) {
    throw signals.run.reason;
  }
  if (signals.deadline?.aborted === true) {
    throw new DeadlineExceededError(lastError);
  }
  if (signals.timeout.aborted) {
    throw new ProviderError("provider_timeout");
  }
  signals.combined.throwIfAborted();
  throw lastError;
}

async function runAttempt<T>(
  options: RetryOptions<T>,
  attempt: number,
  lastError: unknown,
): Promise<T> {
  checkDeadline(options.deadlineTs, options.clock, lastError);
  options.signal.throwIfAborted();
  const timeoutSignal = AbortSignal.timeout(options.policy.timeoutMs);
  const deadlineSignal =
    options.deadlineTs === undefined
      ? undefined
      : AbortSignal.timeout(Math.max(0, options.deadlineTs - options.clock.now()));
  const signals =
    deadlineSignal === undefined
      ? [options.signal, timeoutSignal]
      : [options.signal, timeoutSignal, deadlineSignal];
  const signal = AbortSignal.any(signals);
  const attemptSignals: AttemptSignals = {
    combined: signal,
    run: options.signal,
    timeout: timeoutSignal,
    deadline: deadlineSignal,
  };

  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => {
      try {
        abortAttempt(attemptSignals, lastError);
      } catch (error) {
        reject(error instanceof Error ? error : new Error("Operation aborted.", { cause: error }));
      }
    };
    if (signal.aborted) {
      onAbort();
    } else {
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
  try {
    options.onAttempt?.(attempt);
    const operation = Promise.resolve()
      .then(() => options.operation(signal, lastError))
      .catch((error: unknown) => {
        if (signal.aborted) {
          abortAttempt(attemptSignals, error);
        }
        throw error;
      });
    return await Promise.race([operation, aborted]);
  } finally {
    if (onAbort !== undefined) {
      signal.removeEventListener("abort", onAbort);
    }
  }
}

/**
 * Executes a provider operation with bounded retries, full-jitter backoff, and deadline checks.
 *
 * @param options - Retry policy, cancellation, clock/random/sleep dependencies, and operation.
 * @returns The successful provider result.
 * @throws The last error or `DeadlineExceededError` when retries cannot continue.
 */
export async function withRetries<T>(options: RetryOptions<T>): Promise<T> {
  const parsedPolicy = ModelRetryConfigSchema.safeParse(options.policy);
  if (!parsedPolicy.success) {
    throw new TypeError("Invalid model retry policy.");
  }

  let lastError: unknown;
  for (let attempt = 1; attempt <= parsedPolicy.data.maxAttempts; attempt += 1) {
    try {
      const result = await runAttempt(options, attempt, lastError);
      checkDeadline(options.deadlineTs, options.clock, lastError);
      return result;
    } catch (error) {
      if (options.signal.aborted) {
        throw options.signal.reason;
      }
      if (options.deadlineTs !== undefined && options.clock.now() >= options.deadlineTs) {
        throw new DeadlineExceededError(error);
      }
      if (error instanceof DeadlineExceededError) {
        throw error;
      }
      if (!(error instanceof ProviderError) || !error.retryable) {
        throw error;
      }
      lastError = error;
      if (attempt === parsedPolicy.data.maxAttempts) {
        throw error;
      }

      const delay = delayForAttempt(parsedPolicy.data, attempt, options.random, error.retryAfterMs);
      if (options.deadlineTs !== undefined && options.clock.now() + delay >= options.deadlineTs) {
        throw new DeadlineExceededError(error);
      }
      try {
        await options.sleep(delay, options.signal);
      } catch (sleepError) {
        options.signal.throwIfAborted();
        throw sleepError;
      }
    }
  }
  throw lastError;
}
