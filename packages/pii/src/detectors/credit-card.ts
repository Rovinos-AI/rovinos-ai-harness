// SPDX-License-Identifier: Apache-2.0
import { validateText } from "./types.js";
import type { Detection, Detector } from "./types.js";

/** Validate decimal digits using Luhn without numeric precision loss. */
export function luhn(value: string): boolean {
  const digits = value.replaceAll(/[ -]/gu, "");
  if (!/^\d{2,256}$/u.test(digits) || /^0+$/u.test(digits)) {
    return false;
  }
  let sum = 0;
  let double = false;
  for (let index = digits.length - 1; index >= 0; index--) {
    let digit = Number(digits[index]);
    if (double) {
      digit *= 2;
      if (digit > 9) {
        digit -= 9;
      }
    }
    sum += digit;
    double = !double;
  }
  return sum % 10 === 0;
}

function isWordCharacter(value: string): boolean {
  return /[\p{L}\p{N}_]/u.test(value);
}

function validCard(value: string): boolean {
  return /^\d(?:[ -]?\d){12,18}$/u.test(value) && luhn(value);
}

/** Card candidates require 13–19 digits and a valid Luhn checksum. */
export const creditCardDetector: Detector = {
  id: "credit_card",
  entityTypes: ["credit_card"],
  detect(text) {
    validateText(text);
    const detections: Detection[] = [];
    for (const match of text.matchAll(/\d[\d -]*/gu)) {
      const candidate = match[0].trim();
      const start = match.index + match[0].indexOf(candidate);
      const digitCount = candidate.replaceAll(/\D/gu, "").length;
      if (digitCount <= 19) {
        if (
          validCard(candidate) &&
          !isWordCharacter(text[start - 1] ?? "") &&
          !isWordCharacter(text[start + candidate.length] ?? "")
        ) {
          detections.push({
            entityType: "credit_card",
            start,
            end: start + candidate.length,
            confidence: 1,
            detectorId: "credit_card",
          });
        }
        continue;
      }

      const groups = [...candidate.matchAll(/\d+/gu)];
      for (let first = 0; first < groups.length; first++) {
        let digits = 0;
        for (let last = first; last < groups.length; last++) {
          const group = groups[last];
          if (group === undefined || group.index === undefined) {
            break;
          }
          digits += group[0].length;
          if (digits > 19) {
            break;
          }
          const firstGroup = groups[first];
          if (firstGroup === undefined || firstGroup.index === undefined || digits < 13) {
            continue;
          }
          const valueStart = start + firstGroup.index;
          const value = candidate.slice(firstGroup.index, group.index + group[0].length);
          const end = valueStart + value.length;
          if (
            validCard(value) &&
            !isWordCharacter(text[valueStart - 1] ?? "") &&
            !isWordCharacter(text[end] ?? "")
          ) {
            detections.push({
              entityType: "credit_card",
              start: valueStart,
              end,
              confidence: 1,
              detectorId: "credit_card",
            });
          }
        }
      }
    }
    return detections;
  },
};
