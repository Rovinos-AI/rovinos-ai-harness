// SPDX-License-Identifier: Apache-2.0
import { DeadlineExceededError } from "../resilience/retry.js";

/** Cancellation and deadline data required while asynchronous validation is pending. */
export interface ValidationRunContext {
  readonly signal: AbortSignal;
  readonly deadlineTs?: number;
}

function cancellationError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error("Run validation was cancelled.", { cause: signal.reason });
}

function terminationError(
  context: ValidationRunContext,
  clock: { now(): number },
): Error | undefined {
  if (context.signal.aborted) {
    return cancellationError(context.signal);
  }
  if (context.deadlineTs !== undefined && clock.now() >= context.deadlineTs) {
    return new DeadlineExceededError();
  }
  return undefined;
}

/**
 * Waits for output validation only while its run remains active and before its deadline.
 *
 * @param operation - Asynchronous validation to race against run termination.
 * @param context - Run cancellation signal and optional epoch-millisecond deadline.
 * @param clock - Clock used to compute the remaining deadline duration.
 * @returns The validation result, or rejects with cancellation/deadline failure.
 */
export function awaitRunValidation<T>(
  operation: () => Promise<T>,
  context: ValidationRunContext,
  clock: { now(): number },
): Promise<T> {
  return new Promise((resolve, reject) => {
    const { signal, deadlineTs } = context;
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | null = null;

    const finish = (complete: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      signal.removeEventListener("abort", onAbort);
      if (timeout !== null) {
        clearTimeout(timeout);
      }
      complete();
    };
    const onAbort = (): void => {
      finish(() => {
        reject(cancellationError(signal));
      });
    };

    if (signal.aborted) {
      reject(cancellationError(signal));
      return;
    }
    if (deadlineTs !== undefined) {
      const remainingMs = deadlineTs - clock.now();
      if (remainingMs <= 0) {
        reject(new DeadlineExceededError());
        return;
      }
      timeout = setTimeout(() => {
        finish(() => {
          reject(new DeadlineExceededError());
        });
      }, remainingMs);
    }
    signal.addEventListener("abort", onAbort, { once: true });

    void Promise.resolve()
      .then(operation)
      .then(
        (value) => {
          const terminated = terminationError(context, clock);
          if (terminated !== undefined) {
            finish(() => {
              reject(terminated);
            });
          } else {
            finish(() => {
              resolve(value);
            });
          }
        },
        (error: unknown) => {
          const terminated = terminationError(context, clock);
          const failure =
            terminated ??
            (error instanceof Error
              ? error
              : new Error("Output validation failed.", { cause: error }));
          finish(() => {
            reject(failure);
          });
        },
      );
  });
}
