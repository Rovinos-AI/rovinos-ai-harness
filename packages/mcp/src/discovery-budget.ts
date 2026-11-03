// SPDX-License-Identifier: Apache-2.0
// Walk decoded JSON incrementally: never stringify an entire untrusted page or schema.
import { McpConnectionError, type McpConnectionErrorCode } from "./errors.js";

function* children(value: unknown): Generator<readonly [unknown, number]> {
  let first = true;
  if (Array.isArray(value)) {
    for (const item of value) {
      yield [item, first ? 0 : 1];
      first = false;
    }
  } else if (typeof value === "object" && value !== null) {
    for (const key of Object.keys(value)) {
      yield [key, first ? 1 : 2];
      yield [Reflect.get(value, key), 0];
      first = false;
    }
  }
}

/** Counts compact JSON UTF-8 bytes with bounded traversal and primitive serialization. */
export function decodedBytes(
  value: unknown,
  limit: number,
  code: McpConnectionErrorCode,
  signal: AbortSignal,
): number {
  const root: (readonly [unknown, number])[] = [[value, 0]];
  const pending: Iterator<readonly [unknown, number], void>[] = [root[Symbol.iterator]()];
  let bytes = 0;
  while (pending.length > 0) {
    if (signal.aborted) {
      throw new McpConnectionError("mcp_discovery_cancelled");
    }
    const entry = pending.at(-1)?.next();
    if (entry === undefined || entry.done === true) {
      pending.pop();
      continue;
    }
    const [item, overhead] = entry.value;
    bytes += overhead;
    if (typeof item === "object" && item !== null) {
      bytes += 2;
      pending.push(children(item));
    } else {
      if (typeof item === "string" && item.length > limit - bytes) {
        throw new McpConnectionError(code);
      }
      if (
        item !== null &&
        typeof item !== "string" &&
        typeof item !== "number" &&
        typeof item !== "boolean"
      ) {
        throw new McpConnectionError(code);
      }
      const serialized = JSON.stringify(item);
      bytes += Buffer.byteLength(serialized, "utf8");
    }
    if (bytes > limit) {
      throw new McpConnectionError(code);
    }
  }
  return bytes;
}

/** Races a request against cancellation even when a transport has not settled its promise. */
export async function abortable<Result>(
  operation: () => Promise<Result>,
  signal: AbortSignal,
): Promise<Result> {
  const failure = () => new McpConnectionError("mcp_discovery_cancelled");
  if (signal.aborted) {
    throw failure();
  }
  let onAbort: () => void = () => undefined;
  const cancelled = new Promise<never>((_resolve, reject) => {
    onAbort = () => {
      reject(failure());
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([operation(), cancelled]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

/** Shares one refresh; closing or cancelling any participant aborts its outstanding request. */
export class DiscoveryTask<Result> {
  #pending: Promise<Result> | undefined;
  #controller: AbortController | undefined;

  /** Cancels the current refresh, if any. */
  cancel(): void {
    this.#controller?.abort();
  }

  /** Runs or joins a refresh, without queuing additional discovery work. */
  async run(
    operation: (signal: AbortSignal) => Promise<Result>,
    signal?: AbortSignal,
  ): Promise<Result> {
    if (signal?.aborted === true) {
      throw new McpConnectionError("mcp_discovery_cancelled");
    }
    if (this.#pending === undefined) {
      const controller = new AbortController();
      this.#controller = controller;
      this.#pending = operation(controller.signal).finally(() => {
        this.#pending = undefined;
        this.#controller = undefined;
      });
    }
    const controller = this.#controller;
    const onAbort = () => controller?.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      return await this.#pending;
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
  }
}
