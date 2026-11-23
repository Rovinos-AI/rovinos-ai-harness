// SPDX-License-Identifier: Apache-2.0
import { McpConnectionError } from "./errors.js";

/** Cancellable FIFO admission for process-wide MCP resource work. */
export class FifoSemaphore {
  readonly #limit: number;
  #active = 0;
  readonly #waiting: {
    readonly signal: AbortSignal;
    readonly resolve: (release: () => void) => void;
    readonly reject: (error: McpConnectionError) => void;
    readonly onAbort: () => void;
  }[] = [];

  constructor(limit: number) {
    this.#limit = limit;
  }

  async run<Result>(signal: AbortSignal, operation: () => Promise<Result>): Promise<Result> {
    const release = await this.#acquire(signal);
    try {
      return await operation();
    } finally {
      release();
    }
  }

  #acquire(signal: AbortSignal): Promise<() => void> {
    return new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(new McpConnectionError("mcp_discovery_cancelled"));
        return;
      }
      if (this.#active < this.#limit && this.#waiting.length === 0) {
        this.#active++;
        resolve(this.#release);
        return;
      }
      const onAbort = () => {
        const index = this.#waiting.findIndex((entry) => entry.onAbort === onAbort);
        if (index >= 0) {
          this.#waiting.splice(index, 1);
        }
        signal.removeEventListener("abort", onAbort);
        reject(new McpConnectionError("mcp_discovery_cancelled"));
      };
      this.#waiting.push({ signal, resolve, reject, onAbort });
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  readonly #release = (): void => {
    while (this.#waiting.length > 0) {
      const next = this.#waiting.shift();
      if (next === undefined) {
        break;
      }
      next.signal.removeEventListener("abort", next.onAbort);
      if (next.signal.aborted) {
        next.reject(new McpConnectionError("mcp_discovery_cancelled"));
        continue;
      }
      next.resolve(this.#release);
      return;
    }
    this.#active--;
  };
}

/** Returns a combined caller/deadline signal and its timer cleanup. */
export function createTimedSignal(
  signal: AbortSignal | undefined,
  timeoutMs: number,
): {
  readonly signal: AbortSignal;
  readonly timeout: AbortController;
  readonly timer: ReturnType<typeof setTimeout>;
} {
  const timeout = new AbortController();
  const timer = setTimeout(() => {
    timeout.abort();
  }, timeoutMs);
  return {
    signal: AbortSignal.any([timeout.signal, ...(signal === undefined ? [] : [signal])]),
    timeout,
    timer,
  };
}

export const resourceDiscoverySlots = new FifoSemaphore(4);
export const resourceReadSlots = new FifoSemaphore(4);
