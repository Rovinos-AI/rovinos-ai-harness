// SPDX-License-Identifier: Apache-2.0
import {
  specTypeSchemas,
  type Client,
  type ElicitRequest,
  type ElicitResult,
} from "@modelcontextprotocol/client";
import { LegacyElicitationCompletionTracker } from "./elicitation/legacy.js";

/** Call-bound callbacks used to present legacy elicitation and track completion. */
export interface LegacyElicitationCallbacks {
  readonly signal: AbortSignal;
  readonly handle: (
    request: ElicitRequest["params"],
    elicitationId: string,
    signal: AbortSignal,
  ) => Promise<ElicitResult>;
  readonly onComplete: (elicitationId: string) => void;
}

/** Owns the call-bound routing and serialization required by legacy MCP elicitation. */
export class LegacyConnectionElicitation {
  readonly #completionTracker = new LegacyElicitationCompletionTracker();
  readonly #completionCallbacks = new Map<string, LegacyElicitationCallbacks>();
  #callTail: Promise<void> = Promise.resolve();
  #activeCallbacks: LegacyElicitationCallbacks | undefined;

  register(client: Client, enabled: boolean): void {
    if (!enabled) {
      return;
    }
    client.setRequestHandler("elicitation/create", (request, context) => {
      const elicitationId =
        "elicitationId" in request.params
          ? request.params.elicitationId
          : String(context.mcpReq.id);
      const callbacks = this.#activeCallbacks;
      if (callbacks === undefined || callbacks.signal.aborted) {
        return { action: "cancel", content: {} };
      }
      this.#trackCompletion(elicitationId, callbacks);
      return callbacks.handle(request.params, elicitationId, callbacks.signal);
    });
    client.setNotificationHandler(
      "notifications/elicitation/complete",
      { params: specTypeSchemas.ElicitationCompleteNotificationParams },
      ({ elicitationId }) => {
        if (!this.#completionTracker.complete(elicitationId)) {
          return;
        }
        const callbacks =
          this.#completionCallbacks.get(elicitationId) ?? this.#activeCallbacks;
        this.#completionCallbacks.delete(elicitationId);
        callbacks?.onComplete(elicitationId);
      },
    );
  }

  bind(callbacks: LegacyElicitationCallbacks | undefined): void {
    this.#activeCallbacks = callbacks;
  }

  trackError(
    error: {
      readonly protocolCode: number;
      readonly urlElicitations?: readonly { readonly elicitationId: string }[] | undefined;
    },
    callbacks: LegacyElicitationCallbacks | undefined,
  ): void {
    if (error.protocolCode !== -32042 || error.urlElicitations === undefined) {
      return;
    }
    for (const { elicitationId } of error.urlElicitations) {
      this.#trackCompletion(elicitationId, callbacks);
    }
  }

  clear(): void {
    this.#completionTracker.clear();
    this.#completionCallbacks.clear();
    this.#activeCallbacks = undefined;
  }

  serialize<Result>(operation: () => Promise<Result>): Promise<Result> {
    const predecessor = this.#callTail;
    let release = (): void => undefined;
    const turn = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.#callTail = predecessor.then(() => turn);
    return predecessor.then(operation).finally(release);
  }

  #trackCompletion(
    elicitationId: string,
    callbacks: LegacyElicitationCallbacks | undefined,
  ): void {
    this.#completionTracker.track(elicitationId);
    if (callbacks === undefined) {
      return;
    }
    if (!this.#completionCallbacks.has(elicitationId) && this.#completionCallbacks.size >= 512) {
      const oldest = this.#completionCallbacks.keys().next().value;
      if (oldest !== undefined) {
        this.#completionCallbacks.delete(oldest);
      }
    }
    this.#completionCallbacks.set(elicitationId, callbacks);
  }
}
