// SPDX-License-Identifier: Apache-2.0
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CanaryHarness, scanCommittedFixtures } from "./harness.js";
import { createCanaries } from "./canaries.js";

describe("canary release gate", () => {
  let harness: CanaryHarness;

  beforeAll(async () => {
    harness = await CanaryHarness.create();
  });

  afterAll(async () => {
    await harness.close();
  });

  it("generates unique synthetic values and encoded variants from the seed", () => {
    const canaries = createCanaries("seed-a");
    expect(canaries.all.map(({ value }) => value)).toHaveLength(5);
    expect(new Set(canaries.strings).size).toBe(canaries.strings.length);
    expect(canaries.email.value).toMatch(/^c[a-f0-9]{16}@example\.test$/u);
    expect(canaries.phone.value).toMatch(/^\+1-202-555-\d{4}$/u);
    expect(canaries.card.value).toMatch(/^\d{16}$/u);
    expect(canaries.apiKey.value).toMatch(/^hsk_live_[a-f0-9]{24}$/u);
    expect(canaries.person.value).toMatch(/^Ada-[a-f0-9]{8}$/u);
    expect(canaries.all.every(({ variants }) => variants.length === 2)).toBe(true);
    expect(createCanaries("seed-a")).toEqual(canaries);
    expect(createCanaries("seed-b").strings).not.toEqual(canaries.strings);
  });

  it("keeps canaries out of every captured sink across the scenario matrix", async () => {
    await harness.recordRunContent(harness.canaries.email);

    harness.captured.stdout.push(await harness.runTool(harness.canaries.phone));
    harness.captured.stderr.push(
      await harness.runTool(harness.canaries.person, { failure: true }),
    );
    await harness.captureTokenized("stdout", harness.canaries.apiKey, "ui");
    await harness.captureTokenized("stderr", harness.canaries.card, "model_input");
    await harness.emitBadLog(harness.canaries.email);
    await harness.emitUnsafeSpan(harness.canaries.phone);
    await harness.offloadToolResult(harness.canaries.card);
    await harness.recordCassette(harness.canaries.apiKey);

    expect(harness.captured.toolBoundary.join("\n")).toContain(harness.canaries.phone.value);
    expect(await harness.findLeaks()).toEqual([]);
    await expect(harness.assertVaultRoundTrips()).resolves.toBeUndefined();
  });

  it("detects leaks when the sentinel and processor path is bypassed", async () => {
    for (const value of harness.canaries.strings) {
      harness.captureUnprotectedSink("stdout", value);
    }
    expect(await harness.findLeaks()).toContain("stdout");
    harness.captured.stdout.length = 0;
  });

  it("rejects canary-like values in committed cassettes and fixture directories", async () => {
    const root = fileURLToPath(new URL("../..", import.meta.url));
    expect(await scanCommittedFixtures(root)).toEqual([]);
  });
});
