// SPDX-License-Identifier: Apache-2.0
import { performance } from "node:perf_hooks";
import { describe, expect, it } from "vitest";
import {
  creditCardDetector,
  emailDetector,
  ibanDetector,
  ipDetector,
  phoneDetector,
  secretsDetector,
  urlCredentialsDetector,
} from "../index.js";

// Synthetic identifier fixtures only; keys are assembled rather than usable credentials.
const cases = [
  {
    detector: emailDetector,
    positive: ["alice@example.test", "first.last+tag@sub.example.test", "o'hara@example.test"],
    negative: [
      "user@localhost",
      ".user@example.test",
      "a..b@example.test",
      "a@-bad.test",
      "a@b..test",
      "a".repeat(65) + "@example.test",
    ],
  },
  {
    detector: phoneDetector,
    positive: [
      "+12025550199",
      "202-555-0199",
      "(202) 555-0199",
      "(202)555-0199",
      "1234567",
      "+44 20 7946 0958",
      "02079460958",
    ],
    negative: ["123456", "1234567890123456", "+0123456789", "123--456-7890", "abc1234567890def"],
  },
  {
    detector: creditCardDetector,
    positive: [
      "4111111111111111",
      "4111 1111 1111 1111",
      "4111-1111-1111-1111",
      "4222222222222",
      "4000000000000000006",
    ],
    negative: [
      "1234567890123456",
      "4111111111111112",
      "0000000000000000",
      "4111--1111-1111-1111",
      "41111111111111111111",
    ],
  },
  {
    detector: ibanDetector,
    positive: [
      "GB82WEST12345698765432",
      "GB82 WEST 1234 5698 7654 32",
      "DE89370400440532013000",
      "NO9386011117947",
    ],
    negative: [
      "GB83WEST12345698765432",
      "GB82WEST1234569876543",
      "ZZ82WEST12345698765432",
      "DE00370400440532013000",
    ],
  },
  {
    detector: ipDetector,
    positive: ["192.0.2.1", "255.255.255.255", "2001:db8::1", "::1", "::ffff:192.0.2.1"],
    negative: ["999.1.1.1", "256.0.0.1", "01.2.3.4", "2001:db8:::1", "1.2.3.4.5", "not-an-ip"],
  },
  {
    detector: secretsDetector,
    positive: [
      "AKIA" + "A".repeat(16),
      "ghp_" + "a".repeat(36),
      "eyJ0ZXN0.e30.c2ln",
      "-----BEGIN RSA PRIVATE KEY-----",
      "-----BEGIN PRIVATE KEY-----",
    ],
    negative: [
      "AKIA" + "A".repeat(15),
      "ghp_" + "a".repeat(35),
      "e30..c2ln",
      "e30.e30",
      "-----BEGIN PUBLIC KEY-----",
    ],
  },
  {
    detector: urlCredentialsDetector,
    positive: [
      "https://" + "fixture:synthetic@" + "host.test",
      "ssh://" + "fixture:synthetic@" + "192.0.2.1",
    ],
    negative: [
      "https://host.test",
      "https://user@host.test",
      "https://:pass@host.test",
      "https://" + "fixture:synthetic@",
      "https://" + "fixture:synthetic@" + "host@other",
    ],
  },
];

describe.each(cases)("$detector.id", ({ detector, positive, negative }) => {
  it.each(positive)("detects synthetic %s with original UTF-16 offsets", (value) => {
    const prefix = "😀 漢字 ";
    const text = prefix + value + " suffix";
    const detections = detector.detect(text);
    expect(detections).toEqual([
      {
        entityType: detector.entityTypes[0],
        start: prefix.length,
        end: prefix.length + value.length,
        confidence: 1,
        detectorId: detector.id,
      },
    ]);
    for (const detection of detections) {
      expect(text.slice(detection.start, detection.end)).toBe(value);
    }
  });

  it.each(negative)("rejects synthetic %s", (value) => {
    expect(detector.detect(value)).toEqual([]);
  });

  it("is repeatable, handles empty input, and detects multiple values", () => {
    const value = positive[0] ?? "";
    const text = `${value}; ${value}`;
    expect(detector.detect(text)).toHaveLength(2);
    expect(detector.detect(text)).toEqual(detector.detect(text));
    expect(detector.detect("")).toEqual([]);
    expect(detector.detect("ordinary prose")).toEqual([]);
  });

  it("stays within a 1500 ms budget for each 1 MiB pathological input", () => {
    const size = 1024 * 1024;
    const pathological = [
      "a".repeat(size),
      "1".repeat(size),
      ".".repeat(size),
      ":".repeat(size),
      "(".repeat(size),
      ".".repeat(size - 1) + "x",
      " ".repeat(size),
      "a.".repeat(size / 2),
      "GB00" + "A".repeat(size - 4),
      "https://" + "a".repeat(size - 8),
    ];
    for (const text of pathological) {
      const start = performance.now();
      expect(detector.detect(text)).toEqual([]);
      expect(performance.now() - start).toBeLessThan(1500);
    }
  }, 20_000);
});

describe("punctuation boundaries", () => {
  it.each([
    { detector: emailDetector, value: "alice@example.test" },
    { detector: ipDetector, value: "192.0.2.1" },
    { detector: secretsDetector, value: "AKIA" + "A".repeat(16) },
    { detector: secretsDetector, value: "ghp_" + "a".repeat(36) },
    { detector: secretsDetector, value: "eyJ0ZXN0.e30.c2ln" },
  ])("does not include a sentence period for $detector.id", ({ detector, value }) => {
    const text = `😀 ${value}.`;
    expect(detector.detect(text)).toEqual([
      {
        entityType: detector.entityTypes[0],
        detectorId: detector.id,
        start: 3,
        end: 3 + value.length,
        confidence: 1,
      },
    ]);
  });

  it.each(["GB82 WEST 1234 5698 7654 32", "GB82WEST12345698765432", "gb82west12345698765432"])(
    "stops a valid IBAN before following prose: %s",
    (value) => {
      const text = `😀 ${value} USD PAYMENT`;
      const detected = ibanDetector.detect(text);
      expect(detected).toHaveLength(1);
      expect(detected[0]).toMatchObject({ start: 3, end: 3 + value.length });
      expect(text.slice(detected[0]?.start, detected[0]?.end)).toBe(value);
    },
  );

  it("ends URL credentials before paths and handles quoted JSON", () => {
    const value = "https://" + "fixture:synthetic@" + "host.test";
    expect(urlCredentialsDetector.detect(`{"url":"${value}/path?query=1"}`)[0]).toMatchObject({
      start: 8,
      end: 8 + value.length,
    });
  });

  it("does not detect inside existing tokens or alphanumeric identifiers", () => {
    for (const { detector } of cases) {
      expect(detector.detect("<EMAIL_1> <CUSTOM_ID_123456>")).toEqual([]);
    }
    expect(ipDetector.detect("id192.0.2.1other")).toEqual([]);
  });
});
