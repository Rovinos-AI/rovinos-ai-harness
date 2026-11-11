// SPDX-License-Identifier: Apache-2.0
import type { Event } from "@rovinos/schemas";
import type { ModelCompletion } from "../ports.js";
import type { ModelStepResult } from "./model-step.js";

interface ModelCompletionOptions {
  readonly completion: Promise<ModelCompletion>;
  readonly signal: AbortSignal;
  readonly recorded: Event[];
  readonly requestEvent: Event;
  readonly recordFailure: (
    error: unknown,
  ) => Promise<{ readonly result: ModelStepResult; readonly event?: Event }>;
}

function completeUnlessShutdown(
  completion: Promise<ModelCompletion>,
  signal: AbortSignal,
): Promise<ModelCompletion | undefined> {
  let onAbort: (() => void) | undefined;
  const shutdown = new Promise<undefined>((resolve) => {
    onAbort = (): void => {
      if (signal.reason === "shutdown") {
        resolve(undefined);
      }
    };
    if (signal.aborted) {
      onAbort();
    } else {
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
  return Promise.race([completion, shutdown]).finally(() => {
    if (onAbort !== undefined) {
      signal.removeEventListener("abort", onAbort);
    }
  });
}

/** Awaits a model completion while preserving shutdown and failure events. */
export async function requestCompletion(
  options: ModelCompletionOptions,
): Promise<
  | { readonly completion: ModelCompletion }
  | { readonly result: ModelStepResult; readonly event: Event }
> {
  const { completion, signal, requestEvent, recordFailure } = options;
  try {
    const response = await completeUnlessShutdown(completion, signal);
    if (response === undefined) {
      return { result: { outcome: "aborted", events: options.recorded }, event: requestEvent };
    }
    return { completion: response };
  } catch (error) {
    if (signal.aborted && signal.reason === "shutdown") {
      return { result: { outcome: "aborted", events: options.recorded }, event: requestEvent };
    }
    const failure = await recordFailure(error);
    return { result: failure.result, event: failure.event ?? requestEvent };
  }
}
