// SPDX-License-Identifier: Apache-2.0
// Conservative subset: fixed/bounded atom repetitions, no repeated groups or alternation.

function repetitionCount(pattern: string, index: number): number {
  const closingBrace = pattern.indexOf("}", index);
  if (closingBrace < 0) {
    return Number.POSITIVE_INFINITY;
  }
  const repetition = pattern.slice(index + 1, closingBrace);
  const parts = repetition.split(",");
  if (!/^\d{1,3}(?:,\d{1,3})?$/u.test(repetition) || Number(parts.at(-1)) > 256) {
    return Number.POSITIVE_INFINITY;
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
    return Number.POSITIVE_INFINITY;
  }
  if (character === "{") {
    return repetitionCount(pattern, index);
  }
  return Number(character === "?" && pattern[index - 1] !== "(");
}

/**
 * Screens a regular expression against the conservative subset used for user-authored patterns.
 *
 * @param pattern - The regular expression source to screen.
 * @returns Whether the pattern avoids constructs likely to cause catastrophic backtracking.
 */
export function isRegexSafePattern(pattern: string): boolean {
  let inClass = false;
  let variableRepeats = 0;
  for (let index = 0; index < pattern.length; index++) {
    const character = pattern[index];
    if (character === "\\") {
      const escaped = pattern[++index] ?? "";
      if (!inClass && /[1-9kp]/u.test(escaped)) {
        return false;
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
        return false;
      }
    }
  }
  return true;
}
