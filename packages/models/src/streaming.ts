// SPDX-License-Identifier: Apache-2.0
import type { Id } from "@harness/schemas";
import { ProviderError } from "./errors.js";
import { assembleDeltas, ProviderDeltaSchema } from "./types.js";
import type { ProviderDelta } from "./types.js";

/** Collects one complete provider stream, enforcing idle timeout and preserving only count progress. */
export async function collectProviderStream(options: {
  readonly stream: (signal: AbortSignal) => AsyncIterable<ProviderDelta>;
  readonly signal: AbortSignal;
  readonly idleTimeoutMs: number;
  readonly requestId: Id;
  readonly onProgress?: (progress: {
    readonly requestId: Id;
    readonly outputTokens: number;
  }) => void;
}): Promise<ReturnType<typeof assembleDeltas>> {
  const { stream, signal, idleTimeoutMs, requestId, onProgress } = options;
  const controller = new AbortController();
  const forwardAbort = (): void => controller.abort(signal.reason);
  if (signal.aborted) {
    forwardAbort();
  } else {
    signal.addEventListener("abort", forwardAbort, { once: true });
  }
  let iterator: AsyncIterator<ProviderDelta> | undefined;
  const deltas: ProviderDelta[] = [];
  let complete = false;

  try {
    signal.throwIfAborted();
    iterator = stream(controller.signal)[Symbol.asyncIterator]();
    for (;;) {
      signal.throwIfAborted();
      let timer: ReturnType<typeof setTimeout> | undefined;
      let onAbort: (() => void) | undefined;
      const idleTimeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          const error = new ProviderError("provider_timeout");
          controller.abort(error);
          reject(error);
        }, idleTimeoutMs);
      });
      const aborted = new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(controller.signal.reason);
        if (controller.signal.aborted) {
          onAbort();
        } else {
          controller.signal.addEventListener("abort", onAbort, { once: true });
        }
      });
      let next: IteratorResult<ProviderDelta>;
      try {
        next = await Promise.race([iterator.next(), idleTimeout, aborted]);
      } finally {
        if (timer !== undefined) {
          clearTimeout(timer);
        }
        if (onAbort !== undefined) {
          controller.signal.removeEventListener("abort", onAbort);
        }
      }
      if (next.done) {
        complete = true;
        break;
      }
      const delta = ProviderDeltaSchema.parse(next.value);
      deltas.push(delta);
      if (delta.type === "usage") {
        onProgress?.({ requestId, outputTokens: delta.usage.outputTokens });
      }
    }
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
