// SPDX-License-Identifier: Apache-2.0
import {
  ContractError,
  splitEvent,
  upcastEvent,
  type Event as StoredEvent,
  type Id,
  type NewEvent,
} from "@rovinos/schemas";
import type { ContentCodec } from "@rovinos/store/adapter-internal";
import { InvalidEventError } from "@rovinos/store/adapter-internal";

const envelopeKeys = new Set(["runId", "seq", "ts", "type", "traceId", "spanId", "segmentId"]);

/** Encoded metadata and content associated with a validated event. */
export interface EncodedEvent {
  event: StoredEvent;
  metaJson: string;
  blob: string;
  keyId: string | null;
}

/** Validate and encode a batch before its atomic SQLite append. */
export async function encodeEvents(
  codec: ContentCodec,
  runId: Id,
  events: readonly NewEvent[],
  expectedSeq: number,
): Promise<EncodedEvent[]> {
  if (events.length === 0) {
    throw new InvalidEventError([[]]);
  }

  const validated: StoredEvent[] = [];
  for (const [index, event] of events.entries()) {
    if (event.runId !== runId) {
      throw new InvalidEventError([["runId"]]);
    }

    try {
      validated.push(upcastEvent({ ...event, seq: expectedSeq + index }));
    } catch (error) {
      if (error instanceof ContractError) {
        throw new InvalidEventError(error.issues.map(({ path }) => [...path]));
      }
      throw new InvalidEventError([[]]);
    }
  }

  return Promise.all(
    validated.map(async (event) => {
      const parts = splitEvent(event);
      const content = await codec.encode({ runId, seq: event.seq }, parts.content);
      const meta = Object.fromEntries(
        Object.entries(parts.meta).filter(([key]) => !envelopeKeys.has(key)),
      );
      return {
        event,
        metaJson: JSON.stringify(meta),
        blob: content.blob,
        keyId: content.keyId ?? null,
      };
    }),
  );
}
