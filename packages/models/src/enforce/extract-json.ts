// SPDX-License-Identifier: Apache-2.0
import { JsonValue, safeParseJson } from "@harness/schemas";

/** Result of extracting one JSON object or array from model text. */
export type ExtractJsonResult =
  | { readonly ok: true; readonly value: JsonValue }
  | { readonly ok: false; readonly code: "no_json" | "invalid_json" };

type JsonScanResult =
  | { readonly kind: "candidate"; readonly text: string }
  | { readonly kind: "no_json" | "invalid_json" };

interface JsonScannerState {
  readonly stack: readonly string[];
  readonly start: number;
  readonly inString: boolean;
  readonly escaped: boolean;
}

interface JsonScanStep {
  readonly state: JsonScannerState;
  readonly result?: JsonScanResult;
}

function stripCodeFence(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith("```")) {
    return trimmed;
  }
  const openingEnd = trimmed.indexOf("\n");
  if (openingEnd === -1) {
    return trimmed.slice(3).trimEnd();
  }
  const content = trimmed.slice(openingEnd + 1).trimEnd();
  return content.endsWith("```") ? content.slice(0, -3).trimEnd() : content;
}

function isOpening(character: string): boolean {
  return character === "{" || character === "[";
}

function isMatchingPair(opening: string | undefined, closing: string): boolean {
  return (closing === "}" && opening === "{") || (closing === "]" && opening === "[");
}

function consumeStringCharacter(state: JsonScannerState, character: string): JsonScannerState {
  if (state.escaped) {
    return { ...state, escaped: false };
  }
  if (character === "\\") {
    return { ...state, escaped: true };
  }
  return character === '"' ? { ...state, inString: false } : state;
}

function scanCharacter(
  text: string,
  index: number,
  character: string,
  state: JsonScannerState,
): JsonScanStep {
  if (state.start === -1) {
    return isOpening(character)
      ? { state: { ...state, start: index, stack: [character] } }
      : { state };
  }
  if (state.inString) {
    return { state: consumeStringCharacter(state, character) };
  }
  if (character === '"') {
    return { state: { ...state, inString: true } };
  }
  if (isOpening(character)) {
    return { state: { ...state, stack: [...state.stack, character] } };
  }
  if (character !== "}" && character !== "]") {
    return { state };
  }

  const opening = state.stack[state.stack.length - 1];
  if (!isMatchingPair(opening, character)) {
    return { state, result: { kind: "invalid_json" } };
  }
  const stack = state.stack.slice(0, -1);
  const nextState = { ...state, stack };
  return stack.length === 0
    ? {
        state: nextState,
        result: { kind: "candidate", text: text.slice(state.start, index + 1) },
      }
    : { state: nextState };
}

function findBalancedJson(text: string): JsonScanResult {
  let state: JsonScannerState = { stack: [], start: -1, inString: false, escaped: false };
  for (let index = 0; index < text.length; index += 1) {
    const step = scanCharacter(text, index, text.charAt(index), state);
    state = step.state;
    if (step.result !== undefined) {
      return step.result;
    }
  }
  return { kind: state.start === -1 ? "no_json" : "invalid_json" };
}

/** Extracts and parses the first balanced JSON object or array in model text. */
export function extractJson(text: string): ExtractJsonResult {
  const scanned = findBalancedJson(stripCodeFence(text));
  if (scanned.kind !== "candidate") {
    return { ok: false, code: scanned.kind };
  }
  const parsed = safeParseJson(JsonValue, scanned.text);
  return parsed.success ? { ok: true, value: parsed.data } : { ok: false, code: "invalid_json" };
}
