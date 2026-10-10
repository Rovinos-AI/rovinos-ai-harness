// SPDX-License-Identifier: Apache-2.0
import { candidateDetector } from "./types.js";

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

/** Card candidates require 13–19 digits and a valid Luhn checksum. */
export const creditCardDetector = candidateDetector(
  "credit_card",
  "credit_card",
  /\d[\d -]*/gu,
  (value) => value.length <= 37 && /^\d(?:[ -]?\d){12,18}$/u.test(value) && luhn(value),
);
