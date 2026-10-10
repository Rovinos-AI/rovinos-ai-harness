// SPDX-License-Identifier: Apache-2.0
// Conservative subset: fixed/bounded atom repetitions, no repeated groups or alternation.
import { CustomDetectorSchema } from "@harness/schemas";
import type { CustomDetector } from "@harness/schemas";
import { findTokens } from "@harness/vault";
import { luhn } from "./credit-card.js";
import { mod97 } from "./iban.js";
import { PiiDetectorError, validateText } from "./types.js";
import type { Detection, Detector } from "./types.js";

function repetitionCount(pattern: string, index: number): number {
  const repetition = pattern.slice(index + 1, pattern.indexOf("}", index));
  const parts = repetition.split(",");
  if (!/^\d{1,3}(?:,\d{1,3})?$/u.test(repetition) || Number(parts.at(-1)) > 256) {
    throw new PiiDetectorError("pii_pattern_unsafe");
  }
  return Number(parts.length === 2 && parts[0] !== parts[1]);
}

function screenOperator(pattern: string, index: number): number {
  const character = pattern[index];
  if (
    character === "*" ||
    character === "+" ||
    character === "|" ||
    (character === "(" && pattern[index + 1] === "?" && pattern[index + 2] !== ":") ||
    (character === ")" && /[?{]/u.test(pattern[index + 1] ?? ""))
  ) {
    throw new PiiDetectorError("pii_pattern_unsafe");
  }
  if (character === "{") {
    return repetitionCount(pattern, index);
  }
  return Number(character === "?" && pattern[index - 1] !== "(");
}

function screen(pattern: string): void {
  let inClass = false;
  let variableRepeats = 0;
  for (let index = 0; index < pattern.length; index++) {
    const character = pattern[index];
    if (character === "\\") {
      const escaped = pattern[++index] ?? "";
      if (!inClass && /[1-9kp]/u.test(escaped)) {
        throw new PiiDetectorError("pii_pattern_unsafe");
      }
      continue;
    }
    if (character === "[") {
      inClass = true;
    } else if (character === "]") {
      inClass = false;
    } else if (!inClass) {
      variableRepeats += screenOperator(pattern, index);
      if (character === "{") {
        index = pattern.indexOf("}", index);
      }
      if (variableRepeats > 1) {
        throw new PiiDetectorError("pii_pattern_unsafe");
      }
    }
  }
}

/** Compile once, rejecting unsafe patterns and reporting only closed failure codes. */
export function createCustomDetector(config: CustomDetector): Detector {
  const parsed = CustomDetectorSchema.safeParse(config);
  if (!parsed.success) {
    throw new PiiDetectorError("pii_pattern_invalid");
  }
  const { name, pattern, flags = "", validator } = parsed.data;
  screen(pattern);
  let compiled: RegExp;
  try {
    compiled = new RegExp(pattern, flags.includes("u") ? `${flags}g` : `${flags}gu`);
  } catch {
    throw new PiiDetectorError("pii_pattern_invalid");
  }
  const id = `custom_${name}`;
  return {
    id,
    entityTypes: [id],
    detect(text) {
      validateText(text);
      const tokenRanges = findTokens(text).map(({ index, token }) => ({
        start: index,
        end: index + token.length,
      }));
      const detections: Detection[] = [];
      for (const match of text.matchAll(compiled)) {
        const value = match[0];
        const valid = validator === "luhn" ? luhn(value) : validator !== "mod97" || mod97(value);
        const start = match.index;
        const end = start + value.length;
        if (
          value.length > 0 &&
          valid &&
          !tokenRanges.some((token) => start < token.end && end > token.start)
        ) {
          detections.push({
            entityType: id,
            start,
            end,
            confidence: 1,
            detectorId: id,
          });
        }
      }
      return detections;
    },
  };
}
