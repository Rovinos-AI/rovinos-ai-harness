// SPDX-License-Identifier: Apache-2.0
import {
  EventSchema,
  JsonValue as JsonValueSchema,
  joinEvent,
  splitEvent,
  type Id,
  type JsonValue,
  type NewEvent,
  type PiiActionSummary,
} from "@rovinos/schemas";
import { storedModelRequestHash } from "@rovinos/schemas/request-signature";
import { PiiStorageFailedError } from "./errors.js";
import { isMarked } from "./sanitization-markers.js";
import type { Tokenizer } from "./tokenizer.js";

type SummaryHandler = (summary: PiiActionSummary) => void | Promise<void>;

/** Tokenize unmarked event content before appending it to storage. */
export async function preparePiiEvents(options: {
  readonly runId: Id;
  readonly events: readonly NewEvent[];
  readonly expectedSeq: number;
  readonly tokenizer: Tokenizer;
}): Promise<{ events: NewEvent[]; summaries: PiiActionSummary[] }> {
  const { runId, events, expectedSeq, tokenizer } = options;
  const prepared: NewEvent[] = [];
  const summaries: PiiActionSummary[] = [];
  for (const [index, source] of events.entries()) {
    if (isMarked(source)) {
      prepared.push(source);
      continue;
    }
    const parsed = EventSchema.safeParse({ ...source, seq: expectedSeq + index });
    if (!parsed.success) {
      prepared.push(source);
      continue;
    }
    const { meta, content } = splitEvent(parsed.data);
    const unmarkedContent = Object.fromEntries(
      Object.entries(content).filter(([key]) => !isMarked(source, key)),
    );
    if (Object.keys(unmarkedContent).length === 0) {
      prepared.push(source);
      continue;
    }

    try {
      const contentValue = JsonValueSchema.parse(unmarkedContent);
      const result = await tokenizer.tokenizeJson(runId, contentValue, {
        boundary: "storage",
        destination: "any",
      });
      if (result.actions.some(({ action }) => action === "allow")) {
        throw new PiiStorageFailedError();
      }
      if (
        typeof result.value !== "object" ||
        result.value === null ||
        Array.isArray(result.value)
      ) {
        throw new PiiStorageFailedError();
      }
      const sanitizedContent = result.value;
      summaries.push(...result.actions);
      if (Object.keys(sanitizedContent).length === 0) {
        prepared.push(source);
        continue;
      }
      const event = joinEvent(meta, { ...content, ...sanitizedContent });
      if (
        event.type === "model_request" &&
        event.requestParametersHash !== undefined &&
        event.requestParametersHash !== null
      ) {
        event.requestHash = storedModelRequestHash(event.messages, event.requestParametersHash);
      }
      const { seq, ...newEvent } = event;
      if (seq !== expectedSeq + index) {
        throw new PiiStorageFailedError();
      }
      prepared.push(newEvent);
    } catch {
      throw new PiiStorageFailedError();
    }
  }
  return { events: prepared, summaries };
}

/** Sanitize one opaque JSON value at the storage boundary. */
export async function sanitizeStorageJson(options: {
  readonly runId: Id;
  readonly value: JsonValue;
  readonly tokenizer: Tokenizer;
}): Promise<{ value: JsonValue; actions: readonly PiiActionSummary[] }> {
  if (isMarked(options.value)) {
    return { value: options.value, actions: [] };
  }
  const result = await options.tokenizer.tokenizeJson(options.runId, options.value, {
    boundary: "storage",
    destination: "any",
  });
  if (result.actions.some(({ action }) => action === "allow")) {
    throw new PiiStorageFailedError();
  }
  return result;
}

/** Notify the configured metadata-only handler for each sanitization summary. */
export async function notifyPiiSummaries(
  summaries: readonly PiiActionSummary[],
  onSummary: SummaryHandler,
): Promise<void> {
  for (const summary of summaries) {
    try {
      await onSummary(summary);
    } catch {
      throw new PiiStorageFailedError();
    }
  }
}
