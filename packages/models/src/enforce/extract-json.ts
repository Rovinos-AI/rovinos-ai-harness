// SPDX-License-Identifier: Apache-2.0
import { JsonValue, safeParseJson } from "@harness/schemas";

/** Result of extracting one JSON object or array from model text. */
export type ExtractJsonResult =
  | { readonly ok: true; readonly value: JsonValue }
  | { readonly ok: false; readonly code: "no_json" | "invalid_json" };

type JsonScanResult =
  | { readonly kind: "candidate"; readonly start: number; readonly text: string }
  | { readonly kind: "invalid_json"; readonly start: number }
  | { readonly kind: "no_json" };

const MAX_CANDIDATES = 32;

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

function findBalancedJson(text: string, offset: number): JsonScanResult {
  const stack: string[] = [];
  let start = -1;
  let inString = false;
  let escaped = false;

  for (let index = offset; index < text.length; index += 1) {
    const character = text.charAt(index);
    if (start === -1) {
      if (isOpening(character)) {
        start = index;
        stack.push(character);
      }
      continue;
    }
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }
    if (character === '"') {
      inString = true;
      continue;
    }
    if (isOpening(character)) {
      stack.push(character);
      continue;
    }
    if (character !== "}" && character !== "]") {
      continue;
    }
    if (!isMatchingPair(stack[stack.length - 1], character)) {
      return { kind: "invalid_json", start };
    }
    stack.pop();
    if (stack.length === 0) {
      return { kind: "candidate", start, text: text.slice(start, index + 1) };
    }
  }
  return start === -1 ? { kind: "no_json" } : { kind: "invalid_json", start };
}

/** Extracts and parses the first balanced JSON object or array in model text. */
export function extractJson(text: string): ExtractJsonResult {
  const candidateText = stripCodeFence(text);
  let offset = 0;
  let foundCandidate = false;

  for (let attempt = 0; attempt < MAX_CANDIDATES; attempt += 1) {
    const scanned = findBalancedJson(candidateText, offset);
    if (scanned.kind === "no_json") {
      return { ok: false, code: foundCandidate ? "invalid_json" : "no_json" };
    }
    foundCandidate = true;
    if (scanned.kind === "candidate") {
      const parsed = safeParseJson(JsonValue, scanned.text);
      if (parsed.success) {
        return { ok: true, value: parsed.data };
      }
    }
    offset = scanned.start + 1;
  }
  return { ok: false, code: "invalid_json" };
}
