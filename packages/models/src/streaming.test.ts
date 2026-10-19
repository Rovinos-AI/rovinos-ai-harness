// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from "vitest";
import { ProviderError } from "./errors.js";
import { collectProviderStream } from "./streaming.js";
import type { ProviderDelta } from "./types.js";

const requestId = "00000000000000000000000000";

describe("collectProviderStream", () => {
  it("assembles complete results and reports usage counts without streamed content", async () => {
    const progress: unknown[] = [];
    const result = await collectProviderStream({
      signal: new AbortController().signal,
      idleTimeoutMs: 100,
      requestId,
      onProgress: (update) => {
        progress.push(update);
      },
      async *stream() {
        await Promise.resolve();
        yield { type: "text", index: 0, text: "canary-stream-text" };
        yield { type: "usage", usage: { inputTokens: 2, outputTokens: 3 } };
        yield { type: "finish", finishReason: "stop", latencyMs: 9 };
      },
    });

    expect(result).toEqual({
      parts: [{ type: "text", text: "canary-stream-text" }],
      usage: { inputTokens: 2, outputTokens: 3 },
      finishReason: "stop",
      latencyMs: 9,
    });
    expect(progress).toEqual([{ requestId, outputTokens: 3 }]);
    expect(JSON.stringify(progress)).not.toContain("canary-stream-text");
  });

  it("isolates a throwing progress callback from the provider result", async () => {
    const result = await collectProviderStream({
      signal: new AbortController().signal,
      idleTimeoutMs: 100,
      requestId,
      onProgress: () => {
        throw new Error("subscriber failed");
      },
      async *stream() {
        await Promise.resolve();
        yield { type: "usage", usage: { inputTokens: 1, outputTokens: 2 } };
        yield { type: "finish", finishReason: "stop", latencyMs: 1 };
      },
    });

    expect(result.usage).toEqual({ inputTokens: 1, outputTokens: 2 });
  });

  it("does not apply the inter-delta timeout before the first activity", async () => {
    vi.useFakeTimers();
    const pending = collectProviderStream({
      signal: new AbortController().signal,
      idleTimeoutMs: 10,
      requestId,
      async *stream() {
        await new Promise((resolve) => setTimeout(resolve, 20));
        yield { type: "activity" };
        yield { type: "finish", finishReason: "stop", latencyMs: 20 };
      },
    });

    await vi.advanceTimersByTimeAsync(20);
    await expect(pending).resolves.toMatchObject({ finishReason: "stop" });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("aborts a stalled provider stream when the idle timeout expires", async () => {
    vi.useFakeTimers();
    let streamSignal: AbortSignal | undefined;
    const stream = async function* (signal: AbortSignal): AsyncIterable<ProviderDelta> {
      streamSignal = signal;
      yield { type: "text", index: 0, text: "partial" };
      await new Promise<never>((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => {
            reject(signal.reason instanceof Error ? signal.reason : new Error("aborted"));
          },
          { once: true },
        );
      });
    };

    const collecting = collectProviderStream({
      stream,
      signal: new AbortController().signal,
      idleTimeoutMs: 10,
      requestId,
    });
    const settled = collecting.then(
      () => ({ status: "resolved" as const }),
      (error: unknown) => ({ status: "rejected" as const, error }),
    );
    await vi.advanceTimersByTimeAsync(10);
    const outcome = await settled;
    expect(outcome).toMatchObject({
      status: "rejected",
      error: { code: "provider_timeout" },
    });
    expect(streamSignal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("forwards caller cancellation into the active stream", async () => {
    const controller = new AbortController();
    let enteredStream: (() => void) | undefined;
    const entered = new Promise<void>((resolve) => {
      enteredStream = resolve;
    });
    const reason = new Error("caller cancelled");
    const collecting = collectProviderStream({
      signal: controller.signal,
      idleTimeoutMs: 1_000,
      requestId,
      async *stream(signal) {
        yield { type: "text", index: 0, text: "partial" };
        await new Promise<never>((_resolve, reject) => {
          enteredStream?.();
          signal.addEventListener(
            "abort",
            () => {
              reject(signal.reason instanceof Error ? signal.reason : new Error("aborted"));
            },
            { once: true },
          );
        });
      },
    });

    await entered;
    controller.abort(reason);
    await expect(collecting).rejects.toBe(reason);
  });

  it("calls iterator.return and aborts its signal when the caller cancels", async () => {
    const controller = new AbortController();
    let streamSignal: AbortSignal | undefined;
    const returnIterator = vi.fn(() => Promise.resolve({ done: true as const, value: undefined }));
    let enteredStream: (() => void) | undefined;
    const entered = new Promise<void>((resolve) => {
      enteredStream = resolve;
    });
    const stream: AsyncIterable<ProviderDelta> = {
      [Symbol.asyncIterator]: () => ({
        next: () =>
          new Promise<IteratorResult<ProviderDelta>>(() => {
            enteredStream?.();
          }),
        return: returnIterator,
      }),
    };
    const collecting = collectProviderStream({
      stream: (signal) => {
        streamSignal = signal;
        return stream;
      },
      signal: controller.signal,
      idleTimeoutMs: 1_000,
      requestId,
    });

    await entered;
    controller.abort(new Error("caller cancelled"));
    await expect(collecting).rejects.toThrow("caller cancelled");
    expect(streamSignal?.aborted).toBe(true);
    expect(returnIterator).toHaveBeenCalledOnce();
  });

  it("does not create a provider stream for an already-aborted request", async () => {
    const controller = new AbortController();
    controller.abort(new Error("already cancelled"));
    const stream = vi.fn(async function* (): AsyncGenerator<ProviderDelta> {
      await Promise.resolve();
      yield { type: "finish", finishReason: "stop", latencyMs: 0 };
    });

    await expect(
      collectProviderStream({
        stream,
        signal: controller.signal,
        idleTimeoutMs: 10,
        requestId,
      }),
    ).rejects.toThrow("already cancelled");
    expect(stream).not.toHaveBeenCalled();
  });

  it("propagates non-provider stream failures and closes the iterator", async () => {
    const failure = new Error("stream failed");
    const returnIterator = vi.fn();
    const stream: AsyncIterable<ProviderDelta> = {
      [Symbol.asyncIterator]: () => ({
        next: () => Promise.reject(failure),
        return: returnIterator,
      }),
    };

    await expect(
      collectProviderStream({
        stream: () => stream,
        signal: new AbortController().signal,
        idleTimeoutMs: 100,
        requestId,
      }),
    ).rejects.toBe(failure);
    expect(returnIterator).toHaveBeenCalledOnce();
  });

  it.each(["success", "error", "idle"] as const)(
    "cleans up the idle timer and caller abort listener on %s",
    async (outcome) => {
      vi.useFakeTimers();
      const controller = new AbortController();
      const addListener = vi.spyOn(controller.signal, "addEventListener");
      const removeListener = vi.spyOn(controller.signal, "removeEventListener");
      const collecting = collectProviderStream({
        signal: controller.signal,
        idleTimeoutMs: 10,
        requestId,
        async *stream() {
          yield { type: "activity" };
          if (outcome === "error") {
            throw new Error("stream failed");
          }
          if (outcome === "idle") {
            await new Promise<never>(() => undefined);
          }
          yield { type: "finish", finishReason: "stop", latencyMs: 0 };
        },
      });
      const settled = collecting.then(
        (value) => ({ status: "resolved" as const, value }),
        (error: unknown) => ({ status: "rejected" as const, error }),
      );
      if (outcome === "idle") {
        await vi.advanceTimersByTimeAsync(10);
      }
      const result = await settled;
      expect(result).toMatchObject(
        outcome === "success"
          ? { status: "resolved", value: { finishReason: "stop" } }
          : { status: "rejected" },
      );

      const registeredListener = addListener.mock.calls.find(([type]) => type === "abort")?.[1];
      expect(registeredListener).toBeDefined();
      expect(removeListener).toHaveBeenCalledWith("abort", registeredListener);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("attaches the latest usage to a failed stream without assembling its content", async () => {
    const failure = new ProviderError("provider_unavailable");
    await expect(
      collectProviderStream({
        signal: new AbortController().signal,
        idleTimeoutMs: 100,
        requestId,
        async *stream() {
          await Promise.resolve();
          yield { type: "usage", usage: { inputTokens: 2, outputTokens: 3 } };
          throw failure;
        },
      }),
    ).rejects.toMatchObject({
      code: "provider_unavailable",
      usage: { inputTokens: 2, outputTokens: 3 },
    });
  });

  it("retains retryable idle-timeout error classification", () => {
    expect(new ProviderError("provider_timeout").retryable).toBe(true);
  });
});
