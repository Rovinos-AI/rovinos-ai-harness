// SPDX-License-Identifier: Apache-2.0
import { candidateDetector } from "./types.js";

/** E.164 and common space, dash, and parenthesized phone formats. */
export const phoneDetector = candidateDetector("phone", "phone", /[+\d(][\d()+ -]*/gu, (value) => {
  if (value.length > 64) {
    return false;
  }
  const digits = value.replaceAll(/\D/gu, "");
  return (
    digits.length >= 7 &&
    digits.length <= 15 &&
    !value.startsWith("+0") &&
    /^(?:\+[1-9]\d{6,14}|\d{7,15}|\+?(?:\(\d{1,4}\)[ -]?)?\d{1,4}(?:[ -]\d{1,4}){1,5})$/u.test(
      value,
    )
  );
});
