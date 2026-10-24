// SPDX-License-Identifier: Apache-2.0
import { type Event, type ModelRequest, type Sha256Hex } from "@rovinos/schemas";
import { ProviderResultSchema } from "../types.js";
import {
  CassetteDivergenceError,
  CassetteLogIncompleteError,
  CassetteStoreReadOnlyError,
  type CassetteEntry,
  type CassetteStore,
} from "./cassette-provider.js";
import { requestHash } from "./hash.js";

interface EventLogPair {
  readonly requestHash: Sha256Hex;
  readonly request: ModelRequest;
  readonly response: ReturnType<typeof ProviderResultSchema.parse>;
}

function collectPairs(events: readonly Event[]): EventLogPair[] {
  const pairs: EventLogPair[] = [];
  let pending:
    | { readonly event: Extract<Event, { type: "model_request" }>; readonly index: number }
    | undefined;
  for (const [index, event] of events.entries()) {
    if (event.type === "model_request") {
      if (pending !== undefined) {
        throw new CassetteLogIncompleteError();
      }
      pending = { event, index };
      continue;
    }
    if (event.type !== "model_response") {
      continue;
    }
    if (pending?.event.requestId !== event.requestId) {
      throw new CassetteLogIncompleteError();
    }
    const recordedHash = pending.event.requestHash;
    if (recordedHash === undefined) {
      throw new CassetteLogIncompleteError();
    }
    const request: ModelRequest = {
      requestId: pending.event.requestId,
      model: { provider: pending.event.provider, model: pending.event.model },
      ...(pending.event.role === undefined ? {} : { role: pending.event.role }),
      messages: pending.event.messages,
    };
    pairs.push({
      requestHash: recordedHash,
      request,
      response: ProviderResultSchema.parse({
        parts: event.content,
        usage: {
          inputTokens: event.inputTokens,
          outputTokens: event.outputTokens,
          ...(event.cacheReadTokens === undefined
            ? {}
            : { cacheReadTokens: event.cacheReadTokens }),
          ...(event.cacheWriteTokens === undefined
            ? {}
            : { cacheWriteTokens: event.cacheWriteTokens }),
          ...(event.costMicros === undefined ? {} : { costMicros: event.costMicros }),
        },
        finishReason: event.finishReason,
        latencyMs: event.latencyMs,
      }),
    });
    pending = undefined;
  }
  if (pending !== undefined && pending.index !== events.length - 1) {
    throw new CassetteLogIncompleteError();
  }
  return pairs;
}

/** Read-only, ordered cassette store built from model request/response event pairs. */
export class EventLogCassetteStore implements CassetteStore {
  private readonly pairs: readonly EventLogPair[];
  private nextPair = 0;

  /**
   * @param events - Chronologically ordered events from one recorded run.
   */
  constructor(events: readonly Event[]) {
    this.pairs = collectPairs(events);
  }

  /** @inheritdoc CassetteStore */
  get(_hash: string, request: ModelRequest): Promise<CassetteEntry["response"] | undefined> {
    const pair = this.pairs[this.nextPair];
    if (pair === undefined) {
      return Promise.resolve(undefined);
    }
    const routedRequest: ModelRequest = {
      ...request,
      model: { ...request.model, provider: pair.request.model.provider },
    };
    const incomingHash = requestHash(routedRequest);
    if (pair.requestHash !== incomingHash) {
      return Promise.reject(new CassetteDivergenceError(pair.requestHash, incomingHash));
    }
    this.nextPair += 1;
    return Promise.resolve(pair.response);
  }

  /** @inheritdoc CassetteStore */
  set(_entry: CassetteEntry): Promise<void> {
    return Promise.reject(new CassetteStoreReadOnlyError());
  }
}
