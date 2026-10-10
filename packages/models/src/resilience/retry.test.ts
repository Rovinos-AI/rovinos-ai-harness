// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProviderError } from "../errors.js";
import { DeadlineExceededError, abortableSleep, withRetries } from "./retry.js";
import type { RetryOptions } from "./retry.js";

const policy = {
  maxAttempts: 3,
  baseDelayMs: 10,
  maxDelayMs: 30,
  timeoutMs: 1_000,
};

function retryOptions<T>(overrides: Partial<RetryOptions<T>>): RetryOptions<T> {
  return {
    policy,
    clock: { now: () => 0 },
    random: () => 0.5,
    sleep: () => Promise.resolve(),
    signal: new AbortController().signal,
    operation: () => Promise.reject(new Error("operation not set")),
    ...overrides,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("withRetries", () => {
  it("returns a successful response that resolves just after the deadline", async () => {
    let now = 0;
    const operation = vi.fn(() => {
      now = 11;
      return Promise.resolve("paid response");
    });

    await expect(
      withRetries(retryOptions({ clock: { now: () => now }, deadlineTs: 10, operation })),
    ).resolves.toBe("paid response");
    expect(operation).toHaveBeenCalledOnce();
  });

  it("uses full-jitter exponential backoff and respects the attempt limit", async () => {
    const delays: number[] = [];
    let calls = 0;
    const result = await withRetries(
      retryOptions({
        operation: () => {
          calls += 1;
          return calls < 3
            ? Promise.reject(new ProviderError("provider_unavailable"))
            : Promise.resolve("ok");
        },
        sleep: (delay) => {
          delays.push(delay);
          return Promise.resolve();
        },
      }),
    );

    expect(result).toBe("ok");
    expect(calls).toBe(3);
    expect(delays).toEqual([5, 10]);
  });

  it("uses a provider retry-after delay when it exceeds jitter", async () => {
    const delays: number[] = [];
    let calls = 0;
    await withRetries(
      retryOptions({
        operation: () => {
          calls += 1;
          return calls === 1
            ? Promise.reject(new ProviderError("provider_rate_limited", { retryAfterMs: 80 }))
            : Promise.resolve("ok");
        },
        sleep: (delay) => {
          delays.push(delay);
          return Promise.resolve();
        },
      }),
    );

    expect(delays).toEqual([80]);
  });

  it("does not retry non-retryable provider failures", async () => {
    const operation = vi.fn(() => Promise.reject(new ProviderError("provider_auth")));

    await expect(withRetries(retryOptions({ operation }))).rejects.toMatchObject({
      code: "provider_auth",
    });
    expect(operation).toHaveBeenCalledOnce();
  });

  it("stops before a retry delay reaches the deadline and retains the last error", async () => {
    const error = new ProviderError("provider_unavailable");
    const operation = vi.fn(() => Promise.reject(error));

    await expect(
      withRetries(
        retryOptions({
          deadlineTs: 5,
          operation,
          sleep: vi.fn(),
        }),
      ),
    ).rejects.toMatchObject({ code: "deadline_exceeded", lastError: error });
    expect(operation).toHaveBeenCalledOnce();
  });

  it("propagates cancellation during the retry sleep", async () => {
    const controller = new AbortController();
    const cancel = new Error("cancelled");
    let enteredSleep: (() => void) | undefined;
    const sleepStarted = new Promise<void>((resolve) => {
      enteredSleep = resolve;
    });
    const promise = withRetries(
      retryOptions({
        signal: controller.signal,
        operation: () => Promise.reject(new ProviderError("provider_unavailable")),
        sleep: (_delay, signal) =>
          new Promise<void>((_resolve, reject) => {
            enteredSleep?.();
            signal.addEventListener(
              "abort",
              () => {
                reject(new Error("sleep aborted"));
              },
              { once: true },
            );
          }),
      }),
    );
    await sleepStarted;
    controller.abort(cancel);

    await expect(promise).rejects.toBe(cancel);
  });

  it("aborts a provider attempt at its per-attempt timeout", async () => {
    vi.useFakeTimers();
    const promise = withRetries(
      retryOptions({
        policy: { ...policy, maxAttempts: 1, timeoutMs: 5 },
        operation: (signal) =>
          new Promise<string>((_resolve, reject) => {
            signal.addEventListener(
              "abort",
              () => {
                reject(new Error("timeout"));
              },
              { once: true },
            );
          }),
      }),
    );
    await vi.advanceTimersByTimeAsync(5);

    await expect(promise).rejects.toMatchObject({ code: "provider_timeout" });
  });

  it("interrupts an abortable sleep immediately", async () => {
    const controller = new AbortController();
    const promise = abortableSleep(60_000, controller.signal);
    controller.abort(new Error("stopped"));

    await expect(promise).rejects.toMatchObject({ message: "stopped" });
  });

  it("does not retry invalid retry configuration", async () => {
    await expect(
      withRetries(
        retryOptions({
          policy: { ...policy, maxAttempts: 0 },
        }),
      ),
    ).rejects.toThrow("Invalid model retry policy.");
  });

  it("throws a deadline error if an attempt starts after the deadline", async () => {
    await expect(
      withRetries(
        retryOptions({
          deadlineTs: 0,
        }),
      ),
    ).rejects.toBeInstanceOf(DeadlineExceededError);
  });
});
