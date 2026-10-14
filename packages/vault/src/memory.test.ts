// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { InMemoryVault, VaultValueError } from "./index.js";

const runId = "A".repeat(26);
const anotherRunId = "B".repeat(26);

describe("InMemoryVault", () => {
  it("reuses tokens by run, type, and normalized value while storing the trimmed original", async () => {
    const vault = new InMemoryVault();

    const first = await vault.put(runId, "email", "  Alice@Example.test ");
    const sameIdentity = await vault.put(runId, "email", "alice@example.test");

    expect(first).toBe("<EMAIL_1>");
    expect(sameIdentity).toBe(first);
    await expect(vault.resolve(runId, first, { boundary: "ui" })).resolves.toBe(
      "Alice@Example.test",
    );
  });

  it("numbers independently by run and entity type", async () => {
    const vault = new InMemoryVault();

    await expect(vault.put(runId, "email", "alice@example.test")).resolves.toBe("<EMAIL_1>");
    await expect(vault.put(runId, "email", "bob@example.test")).resolves.toBe("<EMAIL_2>");
    await expect(vault.put(runId, "phone", "5550100000")).resolves.toBe("<PHONE_1>");
    await expect(vault.put(anotherRunId, "email", "alice@example.test")).resolves.toBe("<EMAIL_1>");
  });

  it("shares numbering across entity types with the same token prefix", async () => {
    const vault = new InMemoryVault();
    const hyphenated = await vault.put(runId, "a-b", "first value");
    const dotted = await vault.put(runId, "a.b", "second value");

    expect(hyphenated).toBe("<A_B_1>");
    expect(dotted).toBe("<A_B_2>");
    await expect(vault.put(runId, "a-b", "first value")).resolves.toBe(hyphenated);
    await expect(vault.put(runId, "a.b", "second value")).resolves.toBe(dotted);
    await expect(vault.resolve(runId, hyphenated, { boundary: "ui" })).resolves.toBe("first value");
    await expect(vault.resolve(runId, dotted, { boundary: "ui" })).resolves.toBe("second value");
  });

  it("serializes concurrent duplicate puts to one token", async () => {
    const vault = new InMemoryVault();
    const tokens = await Promise.all(
      Array.from({ length: 20 }, () => vault.put(runId, "email", "alice@example.test")),
    );

    expect(new Set(tokens)).toEqual(new Set(["<EMAIL_1>"]));
    await expect(vault.stats(runId)).resolves.toEqual({ entries: 1 });
  });

  it("returns undefined for unknown or cross-run tokens", async () => {
    const vault = new InMemoryVault();
    const token = await vault.put(runId, "email", "alice@example.test");

    await expect(vault.resolve(runId, "<EMAIL_2>", { boundary: "ui" })).resolves.toBeUndefined();
    await expect(vault.resolve(anotherRunId, token, { boundary: "ui" })).resolves.toBeUndefined();
  });

  it("lists detached values and reports zero entries for unknown runs", async () => {
    const vault = new InMemoryVault();
    await vault.put(runId, "email", " alice@example.test ");
    const values = await vault.listRawValues(runId);

    expect(values).toEqual(["alice@example.test"]);
    expect(values).not.toBe(await vault.listRawValues(runId));
    await expect(vault.listRawValueEntries(runId)).resolves.toEqual([
      { entityType: "email", rawValue: "alice@example.test" },
    ]);
    await expect(vault.listRawValueEntries(anotherRunId)).resolves.toEqual([]);
    await expect(vault.listRawValues(anotherRunId)).resolves.toEqual([]);
    await expect(vault.stats(anotherRunId)).resolves.toEqual({ entries: 0 });
  });

  it("purges entries without resetting token counters", async () => {
    const vault = new InMemoryVault();
    const token = await vault.put(runId, "email", "alice@example.test");

    await expect(vault.purge(runId)).resolves.toBe(1);
    await expect(vault.purge(runId)).resolves.toBe(0);
    await expect(vault.stats(runId)).resolves.toEqual({ entries: 0 });
    await expect(vault.resolve(runId, token, { boundary: "ui" })).resolves.toBeUndefined();
    await expect(vault.put(runId, "email", "alice@example.test")).resolves.toBe("<EMAIL_2>");
  });

  it("enforces the UTF-8 byte-size limit", async () => {
    const vault = new InMemoryVault();

    await expect(vault.put(runId, "name", "a".repeat(8192))).resolves.toBe("<NAME_1>");
    await expect(vault.put(runId, "name", "a".repeat(8193))).rejects.toMatchObject({
      code: "vault_value_too_large",
    });
    await expect(vault.put(runId, "name", "é".repeat(4097))).rejects.toMatchObject({
      code: "vault_value_too_large",
    });
  });

  it("rejects empty values without including input in an error", async () => {
    const vault = new InMemoryVault();
    const sensitiveValue = "   ";

    await expect(vault.put(runId, "name", sensitiveValue)).rejects.toBeInstanceOf(VaultValueError);
    await expect(vault.put(runId, "name", sensitiveValue)).rejects.toMatchObject({
      code: "vault_value_empty",
      message: "Vault value is empty",
    });
  });

  it("rejects entity codes that cannot fit the token format without consuming a counter", async () => {
    const vault = new InMemoryVault();

    await expect(vault.put(runId, "123", "value")).rejects.toMatchObject({
      code: "vault_entity_type_invalid",
    });
    await expect(vault.put(runId, "email", "alice@example.test")).resolves.toBe("<EMAIL_1>");
  });

  it("rejects token numbers beyond the six-digit limit", async () => {
    const vault = new InMemoryVault();
    Object.defineProperty(vault, "counters", {
      value: new Map([[runId, new Map([["NAME", 999_998]])]]),
    });

    await expect(vault.put(runId, "name", "last valid token")).resolves.toBe("<NAME_999999>");
    await expect(vault.put(runId, "name", "overflow")).rejects.toMatchObject({
      code: "vault_token_space_exhausted",
      message: "Vault token space is exhausted",
    });
  });
});
