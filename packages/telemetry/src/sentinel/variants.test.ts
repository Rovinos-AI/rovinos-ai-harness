// SPDX-License-Identifier: Apache-2.0
import { performance } from "node:perf_hooks";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { Code, Id } from "@harness/schemas";
import { ActiveRuns } from "./active-runs.js";
import { SentinelGate } from "./gate.js";
import { VaultRunView, type VaultRunReader } from "./run-values.js";
import { normalizeForScan, variantsOf } from "./variants.js";

const runId = Id.parse("A".repeat(26));

function createGate(value: string): SentinelGate {
  const reader: VaultRunReader = {
    version: () => Promise.resolve(1),
    listRawValueEntries: () =>
      Promise.resolve([{ entityType: Code.parse("email"), rawValue: value }]),
  };
  return new SentinelGate(new VaultRunView(reader), new ActiveRuns(), {
    maxPrepareMs: 1_000,
    maxScanMs: 1_000,
  });
}

function htmlNumericEntities(value: string): string {
  return Array.from(value, (character) => {
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
  }).join("");
}

function asciiCompatibilityForm(value: string): string {
  return Array.from(value, (character) =>
    String.fromCodePoint(character.charCodeAt(0) + 0xfee0),
  ).join("");
}

describe("sentinel variants", () => {
  it.each([
    ["case folding", "Sensitive-Value", "sensitive-value"],
    ["whitespace and dash removal", "grouped-value", "grouped" + "value"],
    ["digits only", "123-456-7890", "1234567890"],
    ["percent encoding", "person+tag@example.test", encodeURIComponent("person+tag@example.test")],
    [
      "base64",
      "alignment-value",
      Buffer.from("alignment-value").toString("base64").replaceAll(/=+$/gu, ""),
    ],
    ["base64url", "🧪+value", Buffer.from("🧪+value").toString("base64url")],
    ["lowercase hex", "Sensitive-Value", Buffer.from("Sensitive-Value").toString("hex")],
    [
      "uppercase hex",
      "Sensitive-Value",
      Buffer.from("Sensitive-Value").toString("hex").toUpperCase(),
    ],
    ["HTML numeric entities", "person@example.test", "person&#64;example&#46;test"],
  ])("detects %s in surrounding text", async (_name, raw, transformed) => {
    await expect(
      createGate(raw).check({ runId, text: `before ${transformed} after` }),
    ).resolves.toEqual({ ok: false, reason: "hit" });
  });

  it("normalizes compatibility characters and removes zero-width and bidi controls", async () => {
    const raw = "Sensitive-Value";
    const obfuscated = `${asciiCompatibilityForm("Sensitive")}\u200B-\u202E${asciiCompatibilityForm("Value")}`;

    expect(normalizeForScan(obfuscated)).toEqual(["Sensitive-Value", "SensitiveValue"]);
    await expect(
      createGate(raw).check({ runId, text: `prefix ${obfuscated} suffix` }),
    ).resolves.toEqual({
      ok: false,
      reason: "hit",
    });
  });

  it("scans a second form with all whitespace and dashes removed", async () => {
    await expect(
      createGate("grouped" + "value").check({ runId, text: "before grouped - value after" }),
    ).resolves.toEqual({ ok: false, reason: "hit" });
  });

  it("includes all three trimmed base64 byte alignments and removes short variants", () => {
    const raw = "alignment-value";
    const variants = variantsOf(raw, 1);
    const expected = [0, 1, 2].map((alignment) =>
      Buffer.from(`${"x".repeat(alignment)}${raw}`)
        .toString("base64")
        .replaceAll(/=+$/gu, "")
        .slice(Math.floor((alignment * 8) / 6)),
    );

    expect(expected.every((variant) => variants.includes(variant))).toBe(true);
    expect(variantsOf("a", 6)).toEqual([]);
    expect(variantsOf("123/45", 6)).not.toContain("12345");
    expect(variantsOf("123-456-7", 6)).toContain("1234567");
  });

  it("detects random supported transforms embedded between random prefixes and suffixes", async () => {
    const transforms = [
      (value: string) => value.toLowerCase(),
      (value: string) => value.replaceAll(/[\s-]/gu, ""),
      (value: string) => encodeURIComponent(value),
      (value: string) => Buffer.from(value).toString("base64").replaceAll(/=+$/gu, ""),
      (value: string) => Buffer.from(value).toString("base64url"),
      (value: string) => Buffer.from(value).toString("hex"),
      (value: string) => Buffer.from(value).toString("hex").toUpperCase(),
      htmlNumericEntities,
    ];
    const rawCharacter = fc.constantFrom(
      ...Array.from("abcdefghijklmnopqrstuvwxyz0123456789@._+-"),
    );
    const affixCharacter = fc.constantFrom(...Array.from("abcdefghijklmnopqrstuvwxyz"));
    const propertyCheck = await fc.check(
      fc.asyncProperty(
        fc
          .array(rawCharacter, { minLength: 8, maxLength: 24 })
          .map((characters) => characters.join("")),
        fc.integer({ min: 0, max: transforms.length - 1 }),
        fc.array(affixCharacter, { maxLength: 12 }).map((characters) => characters.join("")),
        fc.array(affixCharacter, { maxLength: 12 }).map((characters) => characters.join("")),
        (raw, transformIndex, prefix, suffix) => {
          const transformed = transforms[transformIndex]?.(raw);
          if (transformed === undefined) {
            return Promise.resolve(false);
          }
          return createGate(raw)
            .check({ runId, text: `${prefix}${transformed}${suffix}` })
            .then((gateResult) => !gateResult.ok && gateResult.reason === "hit");
        },
      ),
      { numRuns: 250 },
    );

    expect(propertyCheck.failed).toBe(false);
  });

  it("does not claim arbitrary encryption or compression are supported", async () => {
    const raw = "private-value-123";
    const unsupported = "ciphertext:sealed-payload-987654321";

    await expect(createGate(raw).check({ runId, text: unsupported })).resolves.toEqual({
      ok: true,
    });
  });

  it("keeps a generous performance budget with variants enabled", async () => {
    const values = Array.from(
      { length: 25 },
      (_, index) => `known-value-${index.toString(10)}-123456`,
    );
    const patterns = values.flatMap((value) => variantsOf(value));
    const gateReader: VaultRunReader = {
      version: () => Promise.resolve(1),
      listRawValueEntries: () =>
        Promise.resolve(values.map((rawValue) => ({ entityType: Code.parse("email"), rawValue }))),
    };
    const gate = new SentinelGate(new VaultRunView(gateReader), new ActiveRuns(), {
      maxPrepareMs: 1_000,
      maxScanMs: 1_000,
    });
    const startedAt = performance.now();

    await expect(gate.check({ runId, text: "safe telemetry ".repeat(6_667) })).resolves.toEqual({
      ok: true,
    });
    expect(patterns.length).toBeGreaterThan(values.length);
    expect(performance.now() - startedAt).toBeLessThan(500);
  });
});
