// SPDX-License-Identifier: Apache-2.0
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import type { KeyProvider } from "@harness/schemas";
import { OAuthTokenStore, OAuthTokenStoreError } from "./token-store.js";

const tokenCanary = "mcp-oauth-token-store-canary";
const keyProvider: KeyProvider = {
  currentKeyId: () => "test-key",
  getKey: () => Promise.resolve(new Uint8Array(32).fill(31)),
};

describe("OAuthTokenStore", () => {
  it("encrypts values at rest, reloads them, and deletes server credentials", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mcp-oauth-store-"));
    const path = join(directory, "mcp-oauth.db");
    const store = await OAuthTokenStore.open(path, keyProvider);
    try {
      await store.save("server-one", {
        issuer: "https://issuer.example",
        tokens: { access_token: tokenCanary, token_type: "Bearer" },
      });

      expect(await store.load("server-one")).toEqual({
        issuer: "https://issuer.example",
        tokens: { access_token: tokenCanary, token_type: "Bearer" },
      });
      expect((await readFile(path)).includes(Buffer.from(tokenCanary))).toBe(false);

      store.delete("server-one");
      expect(await store.load("server-one")).toBeUndefined();
    } finally {
      store.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("authenticates the server id as AAD when decrypting credentials", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mcp-oauth-aad-"));
    const path = join(directory, "mcp-oauth.db");
    const store = await OAuthTokenStore.open(path, keyProvider);
    try {
      await store.save("original-server", {
        tokens: { access_token: tokenCanary, token_type: "Bearer" },
      });
      store.close();

      const database = new Database(path);
      database
        .prepare("UPDATE oauth_credentials SET server_id = ? WHERE server_id = ?")
        .run("different-server", "original-server");
      database.close();

      const reopened = await OAuthTokenStore.open(path, keyProvider);
      await expect(reopened.load("different-server")).rejects.toBeInstanceOf(OAuthTokenStoreError);
      reopened.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects invalid values and maps database failures to safe errors", async () => {
    const store = await OAuthTokenStore.open(":memory:", keyProvider);
    await expect(
      store.save("server", { tokens: { access_token: "", token_type: "Bearer" } }),
    ).rejects.toBeInstanceOf(OAuthTokenStoreError);
    expect(await store.load("absent")).toBeUndefined();
    store.close();

    await expect(store.load("server")).rejects.toBeInstanceOf(OAuthTokenStoreError);
    expect(() => store.delete("server")).toThrow(OAuthTokenStoreError);
  });
});
