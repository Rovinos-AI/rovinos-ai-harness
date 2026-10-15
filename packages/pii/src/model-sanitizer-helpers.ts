// SPDX-License-Identifier: Apache-2.0
import { type Code, type JsonValue, type PiiAction, type PiiActionSummary } from "@harness/schemas";
import { findTokens, type Token } from "@harness/vault";
import { PiiTokenizerError } from "./errors.js";

/** Increments an action/entity count in the mutable summary map. */
export function addCount(
  counts: Map<PiiAction, Map<Code, number>>,
  action: PiiAction,
  entity: Code,
): void {
  const entities = counts.get(action) ?? new Map<Code, number>();
  entities.set(entity, (entities.get(entity) ?? 0) + 1);
  counts.set(action, entities);
}

/** Converts action/entity counts to metadata-only model-input summaries. */
export function summarizeTokenActions(
  counts: ReadonlyMap<PiiAction, ReadonlyMap<Code, number>>,
): PiiActionSummary[] {
  return [...counts].map(([action, entities]) => ({
    boundary: "model_input",
    action,
    entities: [...entities].map(([type, count]) => ({ type, count })),
  }));
}

/** Collects every string, including object keys, from a JSON value. */
export function collectStrings(value: JsonValue, output: string[]): void {
  if (typeof value === "string") {
    output.push(value);
  } else if (Array.isArray(value)) {
    for (const child of value) {
      collectStrings(child, output);
    }
  } else if (value !== null && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      output.push(key);
      collectStrings(child, output);
    }
  }
}

/** Collects typed tokens from every string and key in a JSON value. */
export function collectTokens(value: JsonValue, output: Token[] = []): Token[] {
  if (typeof value === "string") {
    output.push(...findTokens(value).map(({ token }) => token));
  } else if (Array.isArray(value)) {
    for (const child of value) {
      collectTokens(child, output);
    }
  } else if (value !== null && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      output.push(...findTokens(key).map(({ token }) => token));
      collectTokens(child, output);
    }
  }
  return output;
}

/** Applies an async transform to every string and object key in a JSON value. */
export async function mapJsonStrings(
  value: JsonValue,
  transform: (text: string) => Promise<string>,
): Promise<JsonValue> {
  if (typeof value === "string") {
    return transform(value);
  }
  if (Array.isArray(value)) {
    const result: JsonValue[] = [];
    for (const child of value) {
      result.push(await mapJsonStrings(child, transform));
    }
    return result;
  }
  if (value !== null && typeof value === "object") {
    const entries: [string, JsonValue][] = [];
    const keys = new Set<string>();
    for (const [key, child] of Object.entries(value)) {
      const transformedKey = await transform(key);
      if (keys.has(transformedKey)) {
        throw new PiiTokenizerError("pii_input_invalid");
      }
      keys.add(transformedKey);
      entries.push([transformedKey, await mapJsonStrings(child, transform)]);
    }
    return Object.fromEntries(entries);
  }
  return value;
}
