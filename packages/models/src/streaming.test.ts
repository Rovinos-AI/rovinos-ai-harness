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
      onProgress: (update) => progress.push(update),
      stream: async function* () {
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

  it("aborts a stalled provider stream when the idle timeout expires", async () => {
    let streamSignal: AbortSignal | undefined;
    const stream = async function* (signal: AbortSignal): AsyncIterable<ProviderDelta> {
      streamSignal = signal;
      yield { type: "text", index: 0, text: "partial" };
      await new Promise<never>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    };

    await expect(
      collectProviderStream({
        stream,
        signal: new AbortController().signal,
        idleTimeoutMs: 10,
        requestId,
      }),
    ).rejects.toMatchObject({ code: "provider_timeout" });
    expect(streamSignal?.aborted).toBe(true);
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
      stream: async function* (signal) {
        yield { type: "text", index: 0, text: "partial" };
        await new Promise<never>((_resolve, reject) => {
          enteredStream?.();
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      },
    });

    await entered;
    controller.abort(reason);
    await expect(collecting).rejects.toBe(reason);
  });

  it("does not create a provider stream for an already-aborted request", async () => {
    const controller = new AbortController();
    controller.abort(new Error("already cancelled"));
    const stream = vi.fn(async function* (): AsyncGenerator<ProviderDelta> {
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

  it("retains retryable idle-timeout error classification", () => {
    expect(new ProviderError("provider_timeout").retryable).toBe(true);
  });
});
