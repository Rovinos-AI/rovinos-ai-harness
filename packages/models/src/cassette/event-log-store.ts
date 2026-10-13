// SPDX-License-Identifier: Apache-2.0
import { type Event, type ModelRequest, type Sha256Hex } from "@harness/schemas";
import { ProviderResultSchema } from "../types.js";
import {
  CassetteDivergenceError,
  CassetteStoreReadOnlyError,
  type CassetteEntry,
  type CassetteStore,
} from "./cassette-provider.js";
import { requestHash } from "./hash.js";

interface EventLogPair {
  readonly requestHash: Sha256Hex;
  readonly schemaHash?: string;
  readonly request: ModelRequest;
  readonly response: ReturnType<typeof ProviderResultSchema.parse>;
}

function comparableRequest(request: ModelRequest): ModelRequest {
  return {
    requestId: request.requestId,
    model: request.model,
    ...(request.role === undefined ? {} : { role: request.role }),
    messages: request.messages,
  };
}

function collectPairs(events: readonly Event[]): EventLogPair[] {
  const responses = new Map<string, Extract<Event, { type: "model_response" }>>();
  for (const event of events) {
    if (event.type === "model_response") {
      responses.set(event.requestId, event);
    }
  }

  const pairs: EventLogPair[] = [];
  for (const event of events) {
    if (event.type !== "model_request") {
      continue;
    }
    const response = responses.get(event.requestId);
    if (response === undefined) {
      continue;
    }
    const request: ModelRequest = {
      requestId: event.requestId,
      model: { provider: event.provider, model: event.model },
      ...(event.role === undefined ? {} : { role: event.role }),
      messages: event.messages,
    };
    pairs.push({
      requestHash: requestHash(request),
      ...(event.schemaHash === undefined ? {} : { schemaHash: event.schemaHash }),
      request,
      response: ProviderResultSchema.parse({
        parts: response.content,
        usage: {
          inputTokens: response.inputTokens,
          outputTokens: response.outputTokens,
          ...(response.costMicros === undefined ? {} : { costMicros: response.costMicros }),
        },
        finishReason: response.finishReason,
        latencyMs: response.latencyMs,
      }),
    });
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
  async get(_hash: string, request: ModelRequest): Promise<CassetteEntry["response"] | undefined> {
    const pair = this.pairs[this.nextPair];
    if (pair === undefined) {
      return undefined;
    }
    const incomingHash = requestHash(comparableRequest(request));
    const schemaHashMatches = pair.schemaHash === request.output?.schemaHash;
    if (pair.requestHash !== incomingHash || !schemaHashMatches) {
      throw new CassetteDivergenceError(pair.requestHash, incomingHash);
    }
    this.nextPair += 1;
    return pair.response;
  }

  /** @inheritdoc CassetteStore */
  async set(_entry: CassetteEntry): Promise<void> {
    throw new CassetteStoreReadOnlyError();
  }
}
