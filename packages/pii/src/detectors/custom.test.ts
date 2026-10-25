// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { PiiConfigSchema, parseYaml } from "@rovinos/schemas";
import { createCustomDetector, PiiDetectorError } from "../index.js";

describe("custom detectors", () => {
  it("loads configuration, compiles once, and preserves exact matches", () => {
    const config = parseYaml(
      PiiConfigSchema,
      `
custom:
  - name: synthetic_id
    pattern: 'ID-[A-Z]{2}-\\d{6}'
    flags: i
`,
    );
    const entry = config.custom?.[0];
    expect(entry).toBeDefined();
    if (entry === undefined) {
      throw new Error("missing synthetic fixture");
    }
    const detector = createCustomDetector(entry);
    expect(detector.id).toBe("custom_synthetic_id");
    expect(detector.entityTypes).toEqual(["custom_synthetic_id"]);
    const text = "😀 id-AB-123456 / ID-CD-654321";
    const result = detector.detect(text);
    expect(result.map((detection) => text.slice(detection.start, detection.end))).toEqual([
      "id-AB-123456",
      "ID-CD-654321",
    ]);
    expect(result[0]?.start).toBe(3);
    expect(detector.detect(text)).toEqual(result);
    expect(detector.detect("")).toEqual([]);
    expect(
      createCustomDetector({ name: "space", pattern: " ID " }).detect(" ID ")[0],
    ).toMatchObject({ start: 0, end: 4 });
  });

  it.each([
    {
      validator: "luhn",
      pattern: "\\d{16}",
      valid: "4111111111111111",
      invalid: "1234567890123456",
    },
    {
      validator: "mod97",
      pattern: "[A-Z]{2}\\d{2}[A-Z0-9]{18}",
      valid: "GB82WEST12345698765432",
      invalid: "GB83WEST12345698765432",
    },
  ] as const)("applies $validator", ({ validator, pattern, valid, invalid }) => {
    const detector = createCustomDetector({ name: "checksum", pattern, validator });
    expect(detector.detect(valid)).toHaveLength(1);
    expect(detector.detect(invalid)).toEqual([]);
  });

  it.each([
    "(a+)+$",
    "(a{1,4}){2}",
    "(a|aa){2}",
    "a*a*",
    "a{1,}",
    "(?=a)a",
    "(a)\\1",
    "a{257}",
    "a?a?",
    "a{1,3}a{1,3}",
    "\\p{L}{2}",
    "(a)?",
  ])("rejects unsafe %s without exposing the pattern", (pattern) => {
    expect(() => createCustomDetector({ name: "unsafe", pattern })).toThrow(
      new PiiDetectorError("pii_pattern_unsafe"),
    );
  });

  it.each([
    { name: "bad-name", pattern: "abc" },
    { name: "invalid", pattern: "[" },
    { name: "invalid", pattern: "abc", flags: "ii" },
    { name: "invalid", pattern: "" },
    { name: "a".repeat(26), pattern: "abc" },
  ])("rejects invalid configuration with a closed code", (config) => {
    expect(() => createCustomDetector(config)).toThrow(new PiiDetectorError("pii_pattern_invalid"));
  });

  it("accepts names whose resulting token type fits the vault limit", () => {
    expect(createCustomDetector({ name: "a".repeat(25), pattern: "abc" }).id).toBe(
      `custom_${"a".repeat(25)}`,
    );
  });

  it.each(["(?:ab)\\d{2}", "(ab)\\d{2}", "[+*?()]{2}", "\\+\\d{2}", "a{1,3}", "ab?", "a{2,2}"])(
    "accepts screened syntax %s",
    (pattern) => {
      expect(createCustomDetector({ name: "safe", pattern, flags: "u" }).id).toBe("custom_safe");
    },
  );

  it("skips empty matches and validates non-string input without raw errors", () => {
    const detector = createCustomDetector({ name: "empty", pattern: "^" });
    expect(detector.detect("text")).toEqual([]);
    // @ts-expect-error -- Exercise the runtime boundary with invalid input.
    expect(() => detector.detect(42)).toThrow(new PiiDetectorError("pii_detector_invalid_input"));
  });

  it("rejects non-decimal Luhn input and malformed mod-97 input", () => {
    expect(
      createCustomDetector({ name: "card", pattern: "[A-Z]{4}", validator: "luhn" }).detect("TEST"),
    ).toEqual([]);
    expect(
      createCustomDetector({ name: "iban", pattern: "\\d{4}", validator: "mod97" }).detect("1234"),
    ).toEqual([]);
  });
});
