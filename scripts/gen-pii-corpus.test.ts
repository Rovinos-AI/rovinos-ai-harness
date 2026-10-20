// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import { parseJson } from "@harness/schemas";
import { describe, expect, it } from "vitest";
import {
  generatePiiCorpus,
  PiiCorpusSampleSchema,
} from "./gen-pii-corpus.js";

describe("generatePiiCorpus", () => {
  it("is deterministic for the same seed and matches its asserted hash", () => {
    const first = generatePiiCorpus(0x13_11_2026);
    const second = generatePiiCorpus(0x13_11_2026);

    expect(second).toBe(first);
    expect(createHash("sha256").update(first).digest("hex")).toBe(
      "3bddd21e02f75ec57b50ce55234e88a602d7bbb5adefc0918e4ca9f8d20d52fd",
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
    for (const sample of samples) {
      for (const span of sample.spans) {
        expect(sample.text.slice(span.start, span.end)).not.toBe("");
      }
    }
  });

});
