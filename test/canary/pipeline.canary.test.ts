// SPDX-License-Identifier: Apache-2.0
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CanaryHarness } from "./harness.js";
import { scanCommittedFixtures } from "./scanning.js";
import { createCanaries } from "./canaries.js";

function luhnValid(value: string): boolean {
  let sum = 0;
  let double = false;
  for (let index = value.length - 1; index >= 0; index -= 1) {
    let number = Number(value.charAt(index));
    if (double) {
      number *= 2;
      if (number > 9) {
        number -= 9;
      }
    }
    sum += number;
    double = !double;
  }
  return sum % 10 === 0;
}

describe("canary release gate", () => {
  let harness: CanaryHarness | undefined;

  function currentHarness(): CanaryHarness {
    if (harness === undefined) {
      throw new Error("The canary harness has not been initialized.");
    }
    return harness;
  }

  beforeAll(async () => {
    harness = await CanaryHarness.create();
  });

  afterAll(async () => {
    if (harness !== undefined) {
      await harness.close();
    }
  });

  it("generates unique synthetic values and encoded variants from the seed", () => {
    const canaries = createCanaries("seed-a");
    expect(canaries.all.map(({ value }) => value)).toHaveLength(5);
    expect(new Set(canaries.strings).size).toBe(canaries.strings.length);
    expect(canaries.email.value).toMatch(/^c[a-f0-9]{16}@example\.test$/u);
    expect(canaries.phone.value).toMatch(/^\+1-202-555-\d{4}$/u);
    expect(canaries.card.value).toMatch(/^\d{16}$/u);
    expect(canaries.apiKey.value).toMatch(/^hsk_live_[a-f0-9]{24}$/u);
    expect(canaries.person.value).toMatch(/^(?:Ada|Grace|Katherine|Margaret)-[a-f0-9]{8}$/u);
    expect(canaries.all.every(({ variants }) => variants.length === 2)).toBe(true);
    expect(
      canaries.all.every(
        ({ value, variants }) =>
          variants[0] !== undefined &&
          variants[0] !== value &&
          decodeURIComponent(variants[0]) === value &&
          variants[1] !== undefined &&
          Buffer.from(variants[1], "base64").toString("utf8") === value,
      ),
    ).toBe(true);
    expect(luhnValid(canaries.card.value)).toBe(true);
    expect(createCanaries("seed-a")).toEqual(canaries);
    expect(createCanaries("seed-b").strings).not.toEqual(canaries.strings);
  });

  it("keeps canaries out of every captured sink across the scenario matrix", async () => {
    const current = currentHarness();
    await current.runRuntimeScenario();
    await current.exerciseTelemetry();
    await current.exerciseKeysRotatedLog();

    expect(current.captured.toolBoundary.join("\n")).toContain(current.canaries.phone.value);
    expect(current.captured.toolBoundary.join("\n")).toContain(current.canaries.card.value);
    expect(current.captured.toolErrors.join("\n")).toContain(current.canaries.card.value);
    expect(current.executedTools).toEqual(["canary.echo", "canary.fail"]);
    expect(await current.findLeaks()).toEqual([]);
    expect(
      current.captured.logs.some(
        ({ eventName, attributes }) =>
          eventName === "harness.keys.rotated" &&
          attributes["harness.keys.vault.rows_rotated"] === 3 &&
          attributes["harness.keys.store.rows_rotated"] === 5,
      ),
    ).toBe(true);
    await expect(current.assertVaultRoundTrips()).resolves.toBeUndefined();
  });

  it("detects leaks when the shipped allowlist processor runs without the sentinel", async () => {
    const current = currentHarness();
    await current.captureWithoutSentinel();
    expect(await current.findLeaks()).toContain("unprotected-exporter");
  });

  it("rejects canary-like values in committed cassettes and fixture directories", async () => {
    const root = fileURLToPath(new URL("../..", import.meta.url));
    expect(await scanCommittedFixtures(root)).toEqual([]);
  });
});
