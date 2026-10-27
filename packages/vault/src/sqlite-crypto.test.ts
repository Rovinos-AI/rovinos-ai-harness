// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from "vitest";

const cryptoMocks = vi.hoisted(() => ({
  hkdfSha256: vi.fn(),
}));

vi.mock("@rovinos/crypto", () => ({ hkdfSha256: cryptoMocks.hkdfSha256 }));

import type { KeyProvider } from "@rovinos/schemas";
import { currentKeyId, deriveVaultKeys, loadMasterKey } from "./sqlite-crypto.js";

function provider(getKey: KeyProvider["getKey"], getCurrentKeyId: () => string = () => "key_a") {
  return { currentKeyId: getCurrentKeyId, getKey } satisfies KeyProvider;
}

describe("SQLite vault key derivation", () => {
  it("copies valid master key material and maps invalid or unavailable keys to a closed code", async () => {
    const masterKey = new Uint8Array(32).fill(7);
    const loaded = await loadMasterKey(
      provider(() => Promise.resolve(masterKey)),
      "key_a",
      "vault_decrypt_failed",
    );
    expect(loaded).toEqual(masterKey);
    expect(loaded).not.toBe(masterKey);

    await expect(
      loadMasterKey(
        provider(() => Promise.resolve(new Uint8Array(31))),
        "key_a",
        "vault_encrypt_failed",
      ),
    ).rejects.toMatchObject({ code: "vault_encrypt_failed" });
    await expect(
      loadMasterKey(
        provider(() => Promise.reject(new Error("synthetic key provider failure"))),
        "key_a",
        "vault_decrypt_failed",
      ),
    ).rejects.toMatchObject({ code: "vault_decrypt_failed" });
  });

  it("clears a partially derived key when the next derivation fails", async () => {
    const masterKey = new Uint8Array(32).fill(9);
    const encryptionKey = new Uint8Array(32).fill(11);
    cryptoMocks.hkdfSha256
      .mockReset()
      .mockReturnValueOnce(encryptionKey)
      .mockImplementationOnce(() => {
        throw new Error("synthetic derivation failure");
      });

    await expect(
      deriveVaultKeys(provider(() => Promise.resolve(masterKey)), "key_a", "vault_encrypt_failed"),
    ).rejects.toMatchObject({ code: "vault_encrypt_failed" });
    expect(encryptionKey).toEqual(new Uint8Array(32));
    expect(masterKey).toEqual(new Uint8Array(32).fill(9));
  });

  it("maps failures reading the current key id to the encryption error code", () => {
    expect(currentKeyId(provider(() => Promise.resolve(new Uint8Array(32))))).toBe("key_a");
    expect(() =>
      currentKeyId(provider(() => Promise.resolve(new Uint8Array(32)), () => {
        throw new Error("synthetic current-key failure");
      })),
    ).toThrow(expect.objectContaining({ code: "vault_encrypt_failed" }));
  });
});
