// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import { parseJson } from "@rovinos/schemas";
import { describe, expect, it } from "vitest";
import { generatePiiCorpus, PiiCorpusSampleSchema } from "./gen-pii-corpus.js";

describe("generatePiiCorpus", () => {
  it("is deterministic for the same seed and matches its asserted hash", () => {
    const first = generatePiiCorpus(0x13_11_2026);
    const second = generatePiiCorpus(0x13_11_2026);

    expect(second).toBe(first);
    expect(createHash("sha256").update(first).digest("hex")).toBe(
      "cd1b8e3903d904c37f2d2afb357a9266b365547180d14c5fe7b0e660c65f6344",
    );
  });

  it("contains only valid synthetic labels and negative controls", () => {
    const samples = generatePiiCorpus()
      .trim()
      .split("\n")
      .map((line) => parseJson(PiiCorpusSampleSchema, line));

    expect(samples.some(({ text }) => text.includes("@example.test"))).toBe(true);
    expect(samples.some(({ id, spans }) => id.includes("negative") && spans.length === 0)).toBe(
      true,
    );
    const positiveCounts = new Map<string, number>();
    for (const sample of samples) {
      for (const { entityType } of sample.spans) {
        positiveCounts.set(entityType, (positiveCounts.get(entityType) ?? 0) + 1);
      }
    }
    for (const entityType of [
      "api_key",
      "credit_card",
      "email",
      "iban",
      "ip_address",
      "location",
      "person_name",
      "phone",
      "url_credentials",
    ]) {
      expect(positiveCounts.get(entityType)).toBeGreaterThanOrEqual(5);
    }
    expect(
      samples.filter(({ id, spans }) => id.includes("negative") && spans.length === 0),
    ).toHaveLength(15);
    for (const sample of samples) {
      for (const span of sample.spans) {
        expect(sample.text.slice(span.start, span.end)).not.toBe("");
      }
    }
  });
});
