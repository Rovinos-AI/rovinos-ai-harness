// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { aesGcmDecrypt } from "@harness/crypto";
import { Id, type KeyProvider } from "@harness/schemas";
import { deriveVaultKeys } from "./sqlite-crypto.js";
import {
  createWrappedScopeKey,
  decryptScopeValue,
  encryptScopeValue,
  unwrapScopeKey,
} from "./scope-crypto.js";

const scopeId = "A".repeat(26);
const keys = new Map([
  ["key-a", new Uint8Array(32).fill(21)],
  ["key-b", new Uint8Array(32).fill(22)],
]);

function provider(current = "key-a"): KeyProvider {
  return {
    currentKeyId: () => current,
    getKey: (keyId) => {
      const key = keys.get(keyId);
      return key === undefined
        ? Promise.reject(new Error("synthetic missing key"))
        : Promise.resolve(Uint8Array.from(key));
    },
  };
}

describe("scope key encryption", () => {
  it("wraps random data keys to their scope and supports master-key rewrapping", async () => {
    const first = await createWrappedScopeKey(
      provider(),
      "key-a",
      scopeId,
      () => new Uint8Array(32).fill(31),
    );
    const unwrapped = await unwrapScopeKey(provider(), "key-a", scopeId, first.wrappedDek);
    const rewrapped = await createWrappedScopeKey(provider("key-b"), "key-b", scopeId, () =>
      Uint8Array.from(unwrapped),
    );
    const rotated = await unwrapScopeKey(provider(), "key-b", scopeId, rewrapped.wrappedDek);

    expect(first.dataKey).toEqual(unwrapped);
    expect(rotated).toEqual(first.dataKey);
    expect(rewrapped.wrappedDek).not.toEqual(first.wrappedDek);
    first.dataKey.fill(0);
    unwrapped.fill(0);
    rewrapped.dataKey.fill(0);
    rotated.fill(0);
  });

  it("binds wrapped keys and value ciphertext to their scope and token", async () => {
    const wrapped = await createWrappedScopeKey(
      provider(),
      "key-a",
      scopeId,
      () => new Uint8Array(32).fill(41),
    );
    const ciphertext = encryptScopeValue(wrapped.dataKey, "alice@example.test", `${scopeId}:<EMAIL_1>`);

    expect(decryptScopeValue(wrapped.dataKey, ciphertext, `${scopeId}:<EMAIL_1>`)).toBe(
      "alice@example.test",
    );
    expect(() =>
      decryptScopeValue(wrapped.dataKey, ciphertext, `${scopeId}:<EMAIL_2>`),
    ).toThrowError(expect.objectContaining({ code: "vault_decrypt_failed" }));
    await expect(
      unwrapScopeKey(provider(), "key-a", Id.parse("B".repeat(26)), wrapped.wrappedDek),
    ).rejects.toMatchObject({ code: "vault_decrypt_failed" });
    wrapped.dataKey.fill(0);
  });

  it("uses a distinct derived key for wrapped data keys", async () => {
    const wrapped = await createWrappedScopeKey(
      provider(),
      "key-a",
      scopeId,
      () => new Uint8Array(32).fill(41),
    );
    const valueKeys = await deriveVaultKeys(provider(), "key-a", "vault_encrypt_failed");
    try {
      expect(() =>
        aesGcmDecrypt(
          valueKeys.encryption,
          wrapped.wrappedDek,
          Buffer.from(`harness/vault/scope/${scopeId}`, "utf8"),
        ),
      ).toThrow();
      expect(await unwrapScopeKey(provider(), "key-a", scopeId, wrapped.wrappedDek)).toEqual(
        wrapped.dataKey,
      );
    } finally {
      wrapped.dataKey.fill(0);
      wrapped.wrappedDek.fill(0);
      valueKeys.encryption.fill(0);
      valueKeys.lookup.fill(0);
    }
  });

  it("masks invalid random sources and missing master keys", async () => {
    await expect(
      createWrappedScopeKey(provider(), "key-a", scopeId, () => new Uint8Array(31)),
    ).rejects.toMatchObject({ code: "vault_encrypt_failed" });
    await expect(
      createWrappedScopeKey(provider(), "missing", scopeId, () => new Uint8Array(32)),
    ).rejects.toMatchObject({ code: "vault_encrypt_failed" });
  });
});
