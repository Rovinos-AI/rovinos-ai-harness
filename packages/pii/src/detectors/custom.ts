// SPDX-License-Identifier: Apache-2.0
import { CustomDetectorSchema, isRegexSafePattern } from "@rovinos/schemas";
import type { CustomDetector } from "@rovinos/schemas";
import { findTokens } from "@rovinos/vault";
import { luhn } from "./credit-card.js";
import { mod97 } from "./iban.js";
import { PiiDetectorError, validateText } from "./types.js";
import type { Detection, Detector } from "./types.js";

/** Compile once, rejecting unsafe patterns and reporting only closed failure codes. */
export function createCustomDetector(config: CustomDetector): Detector {
  const parsed = CustomDetectorSchema.safeParse(config);
  if (!parsed.success) {
    throw new PiiDetectorError("pii_pattern_invalid");
  }
  const { name, pattern, flags = "", validator } = parsed.data;
  if (!isRegexSafePattern(pattern)) {
    throw new PiiDetectorError("pii_pattern_unsafe");
  }
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
