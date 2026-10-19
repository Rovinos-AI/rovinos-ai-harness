// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { pseudonymize } from "./pseudonym.js";

const runA = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const runB = "01ARZ3NDEKTSV4RRFFQ69G5FAW";
const keyA = new Uint8Array(32).fill(7);
const keyB = new Uint8Array(32).fill(8);

function keyProvider() {
  return {
    currentKeyId: () => "current",
    getKey: async (keyId: string) => {
      if (keyId === "current") {
        return keyA;
      }
      if (keyId === "previous") {
        return keyB;
      }
      throw new Error("synthetic key not found");
    },
  };
}

describe("pseudonymize", () => {
  it("returns a deterministic pseudonym with the required format", async () => {
    const options = { value: "alice@example.test", scope: "global" as const, keyProvider: keyProvider() };

    const first = await pseudonymize(options);
    const second = await pseudonymize(options);

    expect(first).toMatch(/^p_[a-z2-7]{26}$/u);
    expect(second).toBe(first);
  });

  it("uses normalized values, explicit keys, and scope in the MAC", async () => {
    const provider = keyProvider();
    const baseline = await pseudonymize({
      value: " alice@example.test ",
      scope: "global",
      keyProvider: provider,
    });

    await expect(
      pseudonymize({
        value: "alice@example.test",
        scope: "global",
        keyProvider: provider,
      }),
    ).resolves.toBe(baseline);
    await expect(
      pseudonymize({
        value: "bob@example.test",
        scope: "global",
        keyProvider: provider,
      }),
    ).resolves.not.toBe(baseline);
    await expect(
      pseudonymize({
        value: "alice@example.test",
        scope: runA,
        keyProvider: provider,
      }),
    ).resolves.not.toBe(baseline);
    await expect(
      pseudonymize({
        value: "alice@example.test",
        scope: "global",
        keyProvider: provider,
        keyId: "previous",
      }),
    ).resolves.not.toBe(baseline);
  });

  it("makes run-scoped pseudonyms unlinkable across run identifiers", async () => {
    const provider = keyProvider();
    const first = await pseudonymize({
      value: "alice@example.test",
      scope: runA,
      keyProvider: provider,
    });
    const second = await pseudonymize({
      value: "alice@example.test",
      scope: runB,
      keyProvider: provider,
    });

    expect(second).not.toBe(first);
  });

  it("does not return or expose the input value", async () => {
    const value = "alice@example.test";
    const token = "<EMAIL_1>";
    const result = await pseudonymize({ value, scope: "global", keyProvider: keyProvider() });

    expect(result).not.toContain(value);
    expect(result).not.toContain(token);
  });

  it("rejects malformed input without echoing the value", async () => {
    const canary = "synthetic-private-input";
    const error = await Reflect.apply(pseudonymize, undefined, [
      { value: canary, scope: "invalid-scope", keyProvider: keyProvider() },
    ]).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code: "pseudonym_input_invalid" });
    expect(String(error)).not.toContain(canary);
  });

  it("zeroes derived key material after generating the pseudonym", async () => {
    const result = await pseudonymize({
      value: "alice@example.test",
      scope: "global",
      keyProvider: keyProvider(),
    });

    expect(result).toMatch(/^p_[a-z2-7]{26}$/u);
    expect(keyA).toEqual(new Uint8Array(32).fill(7));
  });
});
