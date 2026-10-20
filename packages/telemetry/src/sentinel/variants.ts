// SPDX-License-Identifier: Apache-2.0
import { AhoCorasickError, MAX_TOTAL_PATTERN_CHARS } from "./aho-corasick.js";

const DEFAULT_MIN_VALUE_LENGTH = 6;
const INVISIBLE_CONTROLS = /[\u200B-\u200F\u202A-\u202E\u2060\uFEFF]/gu;
const WHITESPACE_AND_DASHES = /[\s-]/gu;

/**
 * Normalize scanned text and also return its whitespace- and dash-free form.
 * @param text Text from a sanitized telemetry payload.
 */
export function normalizeForScan(text: string): readonly [string, string] {
  const normalized = text.normalize("NFKC").replaceAll(INVISIBLE_CONTROLS, "");
  return [normalized, normalized.replaceAll(WHITESPACE_AND_DASHES, "")];
}

/**
 * Return unique, bounded-length matching forms for a raw vault value.
 * Base64 patterns retain only complete six-bit symbols inside the source
 * bytes, so arbitrary encoded prefixes and suffixes do not affect the match.
 * @param raw Raw value from the vault.
 * @param minValueLength Minimum transformed pattern length.
 */
export function variantsOf(
  raw: string,
  minValueLength = DEFAULT_MIN_VALUE_LENGTH,
): readonly string[] {
  const normalized = normalizeForScan(raw)[0];
  const candidates = new Set<string>();
  let totalPatternChars = 0;
  const add = (variant: string): void => {
    if (variant.length < minValueLength || candidates.has(variant)) {
      return;
    }
    totalPatternChars += variant.length;
    if (totalPatternChars > MAX_TOTAL_PATTERN_CHARS) {
      throw new AhoCorasickError("sentinel_patterns_too_large");
    }
    candidates.add(variant);
  };

  add(normalized);
  add(normalized.toLowerCase());
  add(normalized.replaceAll(WHITESPACE_AND_DASHES, ""));
  add(normalized.toLowerCase().replaceAll(WHITESPACE_AND_DASHES, ""));

  const digits = normalized.replaceAll(/\D/gu, "");
  if (digits.length >= 7) {
    add(digits);
  }

  for (const source of new Set([raw, normalized])) {
    add(encodeURIComponent(source));

    const utf8 = Buffer.from(source, "utf8");
    for (let alignment = 0; alignment < 3; alignment += 1) {
      const prefixed = `${"x".repeat(alignment)}${source}`;
      const encoded = Buffer.from(prefixed, "utf8").toString("base64").replaceAll(/=+$/gu, "");
      const firstCompleteSymbol = Math.ceil((alignment * 8) / 6);
      const afterLastCompleteSymbol = Math.floor(((alignment + utf8.length) * 8) / 6);
      const base64 = encoded.slice(firstCompleteSymbol, afterLastCompleteSymbol);
      add(base64);
      add(base64.replaceAll("+", "-").replaceAll("/", "_"));
    }

    const hex = utf8.toString("hex");
    add(hex);
    add(hex.toUpperCase());

    add(
      Array.from(source, (character) => {
        const codePoint = character.codePointAt(0);
        if (
          codePoint !== undefined &&
          ((codePoint >= 48 && codePoint <= 57) ||
            (codePoint >= 65 && codePoint <= 90) ||
            (codePoint >= 97 && codePoint <= 122))
        ) {
          return character;
        }
        return codePoint === undefined ? character : `&#${codePoint.toString(10)};`;
      }).join(""),
    );
  }

  return [...candidates];
}

/**
 * Check whether the deduplicated expanded patterns fit the matcher's size budget.
 * @param values Raw vault values to expand.
 * @param minValueLength Minimum transformed pattern length.
 */
export function fitsPatternSizeLimit(
  values: readonly string[],
  minValueLength = DEFAULT_MIN_VALUE_LENGTH,
): boolean {
  const patterns = new Set<string>();
  let totalPatternChars = 0;

  try {
    for (const value of values) {
      for (const pattern of variantsOf(value, minValueLength)) {
        if (patterns.has(pattern)) {
          continue;
        }
        patterns.add(pattern);
        totalPatternChars += pattern.length;
        if (totalPatternChars > MAX_TOTAL_PATTERN_CHARS) {
          return false;
        }
      }
    }
  } catch (error) {
    if (error instanceof AhoCorasickError && error.code === "sentinel_patterns_too_large") {
      return false;
    }
    throw error;
  }

  return true;
}
