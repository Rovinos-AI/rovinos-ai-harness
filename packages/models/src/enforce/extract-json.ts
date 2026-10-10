// SPDX-License-Identifier: Apache-2.0
import { JsonValue, safeParseJson } from "@harness/schemas";

/** Result of extracting one JSON object or array from model text. */
export type ExtractJsonResult =
  | { readonly ok: true; readonly value: JsonValue }
  | { readonly ok: false; readonly code: "no_json" | "invalid_json" };

type JsonScanResult =
  | { readonly kind: "candidate"; readonly text: string }
  | { readonly kind: "no_json" | "invalid_json" };

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

function findBalancedJson(text: string): JsonScanResult {
  const stack: string[] = [];
  let start = -1;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === undefined) {
      continue;
    }
    if (start === -1) {
      if (character === "{" || character === "[") {
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
    } else if (character === "{" || character === "[") {
      stack.push(character);
    } else if (character === "}" || character === "]") {
      const opening = stack.pop();
      if (
        (character === "}" && opening !== "{") ||
        (character === "]" && opening !== "[")
      ) {
        return { kind: "invalid_json" };
      }
      if (stack.length === 0) {
        return { kind: "candidate", text: text.slice(start, index + 1) };
      }
    }
  }

  return { kind: start === -1 ? "no_json" : "invalid_json" };
}

/** Extracts and parses the first balanced JSON object or array in model text. */
export function extractJson(text: string): ExtractJsonResult {
  const scanned = findBalancedJson(stripCodeFence(text));
  if (scanned.kind !== "candidate") {
    return { ok: false, code: scanned.kind };
  }
  const parsed = safeParseJson(JsonValue, scanned.text);
  return parsed.success
    ? { ok: true, value: parsed.data }
    : { ok: false, code: "invalid_json" };
}
