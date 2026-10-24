// SPDX-License-Identifier: Apache-2.0
import type { Id, ModelUsage } from "@rovinos/schemas";
import { attachModelFailureMetadata, ProviderError } from "./errors.js";
import { assembleDeltas, ModelProgressSchema, ProviderDeltaSchema } from "./types.js";
import type { ModelProgress, ProviderDelta } from "./types.js";

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error("Provider stream aborted.", { cause: signal.reason });
}

async function waitForNext(
  iterator: AsyncIterator<ProviderDelta>,
  controller: AbortController,
  idleTimeoutMs: number,
  hasReceivedDelta: boolean,
): Promise<IteratorResult<ProviderDelta>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const idleTimeout = hasReceivedDelta
    ? new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          const error = new ProviderError("provider_timeout");
          controller.abort(error);
          reject(error);
        }, idleTimeoutMs);
      })
    : undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => {
      reject(abortError(controller.signal));
    };
    if (controller.signal.aborted) {
      onAbort();
    } else {
      controller.signal.addEventListener("abort", onAbort, { once: true });
    }
  });
  try {
    return await Promise.race([
      iterator.next(),
      ...(idleTimeout === undefined ? [] : [idleTimeout]),
      aborted,
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    if (onAbort !== undefined) {
      controller.signal.removeEventListener("abort", onAbort);
    }
  }
}

function reportUsageProgress(
  delta: ProviderDelta,
  requestId: Id,
  onProgress: ((progress: ModelProgress) => void) | undefined,
  previousOutputTokens: number | undefined,
): number | undefined {
  if (delta.type !== "usage" || previousOutputTokens === delta.usage.outputTokens) {
    return previousOutputTokens;
  }
  try {
    onProgress?.(ModelProgressSchema.parse({ requestId, outputTokens: delta.usage.outputTokens }));
  } catch {
    // Progress subscribers must not affect provider completion or retry behavior.
  }
  return delta.usage.outputTokens;
}

/** Collects one complete provider stream, enforcing idle timeout and preserving only count progress. */
export async function collectProviderStream(options: {
  readonly stream: (signal: AbortSignal) => AsyncIterable<ProviderDelta>;
  readonly signal: AbortSignal;
  readonly idleTimeoutMs: number;
  readonly requestId: Id;
  readonly onProgress?: (progress: ModelProgress) => void;
}): Promise<ReturnType<typeof assembleDeltas>> {
  const { stream, signal, idleTimeoutMs, requestId, onProgress } = options;
  const controller = new AbortController();
  const forwardAbort = (): void => {
    controller.abort(signal.reason);
  };
  if (signal.aborted) {
    forwardAbort();
  } else {
    signal.addEventListener("abort", forwardAbort, { once: true });
  }
  let iterator: AsyncIterator<ProviderDelta> | undefined;
  const deltas: ProviderDelta[] = [];
  let complete = false;
  let hasReceivedDelta = false;
  let lastUsage: ModelUsage | undefined;
  let lastProgressOutputTokens: number | undefined;

  try {
    signal.throwIfAborted();
    iterator = stream(controller.signal)[Symbol.asyncIterator]();
    for (;;) {
      signal.throwIfAborted();
      const next = await waitForNext(iterator, controller, idleTimeoutMs, hasReceivedDelta);
      if (next.done === true) {
        complete = true;
        break;
      }
      hasReceivedDelta = true;
      const delta = ProviderDeltaSchema.parse(next.value);
      deltas.push(delta);
      if (delta.type === "usage") {
        lastUsage = delta.usage;
        lastProgressOutputTokens = reportUsageProgress(
          delta,
          requestId,
          onProgress,
          lastProgressOutputTokens,
        );
      }
    }
  } catch (error) {
    throw attachModelFailureMetadata(error, {
      ...(lastUsage === undefined ? {} : { usage: lastUsage }),
    });
  } finally {
    signal.removeEventListener("abort", forwardAbort);
    if (!complete) {
      controller.abort();
      if (iterator !== undefined) {
        void Promise.resolve(iterator.return?.()).catch(() => undefined);
      }
    }
  }

  return assembleDeltas(deltas);
}
