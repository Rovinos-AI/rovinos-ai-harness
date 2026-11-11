// SPDX-License-Identifier: Apache-2.0
import type { JsonValue } from "@rovinos/schemas";
import { z } from "zod";
import {
  MAX_EXTENSION_JSON_BYTES,
  MAX_EXTENSION_JSON_DEPTH,
  MAX_EXTENSION_JSON_NODES,
} from "./extension-constants.js";

type JsonContainer = Record<string, unknown> | unknown[];
interface VisitItem {
  readonly value: unknown;
  readonly depth: number;
  readonly exit?: JsonContainer;
}

interface JsonValidationOptions {
  readonly allowZodMetadata: boolean;
  readonly maxBytes: number;
}

class ValidationState {
  readonly ancestors = new WeakSet<JsonContainer>();
  readonly stack: VisitItem[];
  private byteCount = 0;
  private nodeCount = 0;

  constructor(value: unknown) {
    this.stack = [{ value, depth: 0 }];
  }

  addBytes(text: string, limit: number): boolean {
    this.byteCount += new TextEncoder().encode(text).byteLength;
    return this.byteCount <= limit;
  }

  nextNode(): boolean {
    this.nodeCount += 1;
    return this.nodeCount <= MAX_EXTENSION_JSON_NODES;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validatePrimitive(
  value: unknown,
  state: ValidationState,
  limit: number,
): boolean | undefined {
  if (value === null) {
    return state.addBytes("null", limit);
  }
  if (typeof value === "boolean" || typeof value === "string") {
    return state.addBytes(JSON.stringify(value), limit);
  }
  if (typeof value === "number") {
    return Number.isFinite(value) && state.addBytes(JSON.stringify(value), limit);
  }
  return undefined;
}

function isDataProperty(
  descriptor: PropertyDescriptor | undefined,
): descriptor is PropertyDescriptor & { readonly value: unknown; readonly enumerable: true } {
  return descriptor?.enumerable === true && "value" in descriptor;
}

function pushArrayItems(
  value: unknown[],
  depth: number,
  state: ValidationState,
  options: JsonValidationOptions,
): boolean {
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== value.length + 1 ||
    !keys.includes("length") ||
    keys.some(
      (key) => key !== "length" && (typeof key !== "string" || !/^(?:0|[1-9]\d*)$/u.test(key)),
    )
  ) {
    return false;
  }
  if (!state.addBytes(`[${",".repeat(Math.max(0, value.length - 1))}]`, options.maxBytes)) {
    return false;
  }
  for (let index = value.length - 1; index >= 0; index -= 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!isDataProperty(descriptor)) {
      return false;
    }
    state.stack.push({ value: descriptor.value, depth: depth + 1 });
  }
  return true;
}

function pushObjectEntries(
  value: Record<string, unknown>,
  depth: number,
  state: ValidationState,
  options: JsonValidationOptions,
): boolean {
  const prototype: unknown = Object.getPrototypeOf(value);
  const keys = Reflect.ownKeys(value);
  const stringKeys: string[] = [];
  for (const key of keys) {
    if (typeof key !== "string") {
      return false;
    }
    stringKeys.push(key);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      descriptor === undefined ||
      (descriptor.enumerable !== true && !(options.allowZodMetadata && key === "~standard"))
    ) {
      return false;
    }
  }
  if (prototype !== Object.prototype && prototype !== null) {
    return false;
  }
  const enumerableKeys = stringKeys.filter(
    (key) => Object.getOwnPropertyDescriptor(value, key)?.enumerable === true,
  );
  if (
    !state.addBytes(`{${",".repeat(Math.max(0, enumerableKeys.length - 1))}}`, options.maxBytes)
  ) {
    return false;
  }
  for (const key of enumerableKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      !isDataProperty(descriptor) ||
      !state.addBytes(`${JSON.stringify(key)}:`, options.maxBytes)
    ) {
      return false;
    }
    state.stack.push({ value: descriptor.value, depth: depth + 1 });
  }
  return true;
}

function pushContainer(
  value: JsonContainer,
  depth: number,
  state: ValidationState,
  options: JsonValidationOptions,
): boolean {
  if (state.ancestors.has(value)) {
    return false;
  }
  state.ancestors.add(value);
  state.stack.push({ value: undefined, depth, exit: value });
  return Array.isArray(value)
    ? pushArrayItems(value, depth, state, options)
    : pushObjectEntries(value, depth, state, options);
}

function verifyBoundedJsonValue(
  value: unknown,
  options: JsonValidationOptions,
): value is JsonValue {
  const state = new ValidationState(value);
  while (state.stack.length > 0) {
    const item = state.stack.pop();
    if (item === undefined) {
      return false;
    }
    if (item.exit !== undefined) {
      state.ancestors.delete(item.exit);
      continue;
    }
    if (!state.nextNode() || item.depth > MAX_EXTENSION_JSON_DEPTH) {
      return false;
    }
    const primitive = validatePrimitive(item.value, state, options.maxBytes);
    if (primitive !== undefined) {
      if (!primitive) {
        return false;
      }
      continue;
    }
    if (Array.isArray(item.value)) {
      if (!pushContainer(item.value, item.depth, state, options)) {
        return false;
      }
      continue;
    }
    if (!isRecord(item.value) || !pushContainer(item.value, item.depth, state, options)) {
      return false;
    }
  }
  return true;
}

/** Validates acyclic, bounded JSON without invoking accessors. */
export function isBoundedJsonValue(
  value: unknown,
  allowZodMetadata = false,
  maxBytes = MAX_EXTENSION_JSON_BYTES,
): value is JsonValue {
  try {
    return verifyBoundedJsonValue(value, { allowZodMetadata, maxBytes });
  } catch {
    return false;
  }
}

export const BoundedJsonValueSchema = z.custom<JsonValue>(isBoundedJsonValue);
