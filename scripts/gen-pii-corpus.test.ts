// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import { secretsDetector } from "@rovinos/pii";
import { parseJson } from "@rovinos/schemas";
import { describe, expect, it } from "vitest";
import {
  generatePiiCorpus,
  materializePiiCorpusSample,
  PiiCorpusSampleSchema,
} from "./gen-pii-corpus.js";

describe("generatePiiCorpus", () => {
  it("is deterministic for the same seed and matches its asserted hash", () => {
    const first = generatePiiCorpus(0x13_11_2026);
    const second = generatePiiCorpus(0x13_11_2026);

    expect(second).toBe(first);
    const materialized = `${first
      .trim()
      .split("\n")
      .map((line) =>
        JSON.stringify(materializePiiCorpusSample(parseJson(PiiCorpusSampleSchema, line))),
      )
      .join("\n")}\n`;
    expect(createHash("sha256").update(materialized).digest("hex")).toBe(
      "cd1b8e3903d904c37f2d2afb357a9266b365547180d14c5fe7b0e660c65f6344",
    );
  });

  it("stores a non-JWT placeholder but detects the original JWT and exact span at runtime", () => {
    const serialized = generatePiiCorpus();
    expect(serialized).not.toMatch(/eyJ[\w-]+\.[\w-]+\.[\w-]+/u);
    const samples = serialized
      .trim()
      .split("\n")
      .map((line) => parseJson(PiiCorpusSampleSchema, line));
    const stored = samples.find(({ id }) => id === "pii-key-5");
    expect(stored).toBeDefined();
    if (stored === undefined) {
      throw new TypeError("JWT corpus sample is missing.");
    }
    const runtime = materializePiiCorpusSample(stored);
    expect(runtime.text).toHaveLength(stored.text.length);
    expect(runtime.spans).toEqual([{ start: 21, end: 84, entityType: "api_key" }]);
    expect(runtime.text.slice(21, 84)).toMatch(/^eyJ[\w-]+\.[\w-]+\.[\w-]+$/u);
    expect(secretsDetector.detect(runtime.text)).toEqual([
      expect.objectContaining({ start: 21, end: 84, entityType: "api_key" }),
    ]);
    expect(materializePiiCorpusSample(runtime)).toEqual(runtime);
    for (const sample of samples.filter(({ id }) => id !== "pii-key-5")) {
      expect(materializePiiCorpusSample(sample)).toBe(sample);
    }
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
