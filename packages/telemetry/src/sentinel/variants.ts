// SPDX-License-Identifier: Apache-2.0

const DEFAULT_MIN_VALUE_LENGTH = 6;
const INVISIBLE_CONTROLS = /[\u200B-\u200F\u202A-\u202E\u2060\uFEFF]/gu;
const WHITESPACE_AND_DASHES = /[\s-]/gu;

/**
 * Normalize scanned text and also return its whitespace- and dash-free form.
 * @param text Text from a sanitized telemetry payload.
 */
export function normalizeForScan(text: string): readonly [string, string] {
  const normalized = text.normalize("NFKC").replace(INVISIBLE_CONTROLS, "");
  return [normalized, normalized.replace(WHITESPACE_AND_DASHES, "")];
}

/**
 * Return unique, bounded-length matching forms for a raw vault value.
 * Base64 patterns include three byte alignments: prefixing zero, one, or two
 * UTF-8 bytes of padding text and trimming their complete base64 symbols lets
 * the matcher recognize a value encoded at each byte alignment.
 * @param raw Raw value from the vault.
 * @param minValueLength Minimum transformed pattern length.
 */
export function variantsOf(
  raw: string,
  minValueLength = DEFAULT_MIN_VALUE_LENGTH,
): readonly string[] {
  const normalized = normalizeForScan(raw)[0];
  const candidates = new Set<string>([
    normalized,
    normalized.toLowerCase(),
    normalized.replace(WHITESPACE_AND_DASHES, ""),
  ]);

  const digits = normalized.replace(/\D/gu, "");
  if (digits.length >= 7) {
    candidates.add(digits);
  }

  candidates.add(encodeURIComponent(normalized));

  const utf8 = Buffer.from(normalized, "utf8");
  for (let alignment = 0; alignment < 3; alignment += 1) {
    const padded = Buffer.from(`${"x".repeat(alignment)}${normalized}`, "utf8")
      .toString("base64")
      .replace(/=+$/u, "")
      .slice(Math.floor((alignment * 8) / 6));
    candidates.add(padded);
    candidates.add(padded.replace(/\+/gu, "-").replace(/\//gu, "_"));
  }

  const hex = utf8.toString("hex");
  candidates.add(hex);
  candidates.add(hex.toUpperCase());

  candidates.add(
    Array.from(normalized, (character) => {
      if (/^[A-Za-z0-9]$/u.test(character)) {
        return character;
      }
      const codePoint = character.codePointAt(0);
      return codePoint === undefined ? character : `&#${codePoint};`;
    }).join(""),
  );

  return [...candidates].filter((variant) => variant.length >= minValueLength);
}
