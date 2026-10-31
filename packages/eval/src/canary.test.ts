// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { createCanaries, scanForCanaries } from "./canary.js";

describe("canary helpers", () => {
  it("generates stable, distinct canaries from a seed", () => {
    const first = createCanaries("eval-trial-seed");

    expect(createCanaries("eval-trial-seed")).toEqual(first);
    expect(createCanaries("another-seed").strings).not.toEqual(first.strings);
    expect(new Set(first.strings).size).toBe(first.strings.length);
  });

  it("scans text and byte sinks for plaintext and encoded canaries", () => {
    const canary = createCanaries("eval-trial-seed").email;
    const sinks = [
      { name: "plain", content: `leaked ${canary.value}` },
      { name: "encoded", content: Buffer.from(canary.variants[1] ?? "", "utf8") },
      { name: "clean", content: "no sensitive values" },
    ];

    expect(scanForCanaries([canary.value, ...canary.variants], sinks)).toEqual([
      "plain",
      "encoded",
    ]);
  });

  it("rejects empty canary values", () => {
    expect(() => scanForCanaries([""], [{ name: "sink", content: "anything" }])).toThrow();
  });
});
