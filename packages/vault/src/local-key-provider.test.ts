// SPDX-License-Identifier: Apache-2.0
import { KeysConfigSchema, type SecretRef } from "@harness/schemas";
import { describe, expect, it } from "vitest";
import { LocalKeyProvider, type KeySecretResolver } from "./local-key-provider.js";

function createConfig(currentKeyId: string, keys: readonly { id: string; secret: string }[]) {
  return KeysConfigSchema.parse({ currentKeyId, keys });
}

function createResolver(secrets: Readonly<Record<string, string>>): KeySecretResolver {
  return {
    resolve(ref: SecretRef) {
      const value = secrets[ref];
      if (value === undefined) {
        return Promise.reject(new Error("synthetic resolver failure"));
      }
      return Promise.resolve({ reveal: () => value });
    },
  };
}

function createProvider(
  config: ReturnType<typeof createConfig>,
  secrets: Readonly<Record<string, string>>,
) {
  return new LocalKeyProvider({
    config,
    secretResolver: createResolver(secrets),
    onWarning: () => undefined,
  });
}

describe("LocalKeyProvider", () => {
  it("resolves a configured key lazily and caches its 32 bytes", async () => {
    const key = Buffer.alloc(32, 7);
    const resolver = createResolver({ "env:CURRENT_KEY": key.toString("base64") });
    let resolutions = 0;
    const provider = new LocalKeyProvider({
      config: createConfig("current", [{ id: "current", secret: "env:CURRENT_KEY" }]),
      secretResolver: {
        resolve(ref) {
          resolutions += 1;
          return resolver.resolve(ref);
        },
      },
      onWarning: () => undefined,
    });

    expect(provider.currentKeyId()).toBe("current");
    expect(resolutions).toBe(0);
    const loaded = await provider.getKey("current");

    expect(loaded).toEqual(new Uint8Array(key));
    expect(await provider.getKey("current")).toBe(loaded);
    expect(resolutions).toBe(1);
  });

  it("reuses an in-flight resolution for concurrent requests", async () => {
    const key = Buffer.alloc(32, 8);
    let release: () => void = () => undefined;
    let notifyStarted: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      notifyStarted = resolve;
    });
    let resolutions = 0;
    const provider = new LocalKeyProvider({
      config: createConfig("current", [{ id: "current", secret: "env:KEY" }]),
      secretResolver: {
        async resolve() {
          resolutions += 1;
          notifyStarted();
          await gate;
          return { reveal: () => key.toString("base64") };
        },
      },
      onWarning: () => undefined,
    });

    const first = provider.getKey("current");
    await started;
    const second = provider.getKey("current");
    release();

    expect(await first).toBe(await second);
    expect(resolutions).toBe(1);
  });

  it("rejects keys that are not canonical base64 for exactly 32 bytes", async () => {
    const secret = Buffer.alloc(31, 1).toString("base64");
    const provider = createProvider(
      createConfig("current", [{ id: "current", secret: "env:KEY" }]),
      { "env:KEY": secret },
    );

    await expect(provider.getKey("current")).rejects.toMatchObject({
      code: "key_invalid_length",
    });
    expect(secret).not.toContain("private");
  });

  it("keeps old key versions readable after the current key rotates", async () => {
    const oldKey = Buffer.alloc(32, 3);
    const newKey = Buffer.alloc(32, 4);
    const provider = createProvider(
      createConfig("new", [
        { id: "old", secret: "env:OLD_KEY" },
        { id: "new", secret: "env:NEW_KEY" },
      ]),
      {
        "env:OLD_KEY": oldKey.toString("base64"),
        "env:NEW_KEY": newKey.toString("base64"),
      },
    );

    expect(provider.currentKeyId()).toBe("new");
    expect(await provider.getKey("old")).toEqual(new Uint8Array(oldKey));
    expect(await provider.getKey("new")).toEqual(new Uint8Array(newKey));
  });

  it("rejects unknown ids without echoing the identifier", async () => {
    const provider = createProvider(
      createConfig("current", [{ id: "current", secret: "env:KEY" }]),
      { "env:KEY": Buffer.alloc(32).toString("base64") },
    );

    await expect(provider.getKey("unknown-sensitive-id")).rejects.toMatchObject({
      code: "key_not_found",
      message: "key_not_found",
    });
  });

  it("requires configured keys in production", () => {
    expect(
      () =>
        new LocalKeyProvider({
          secretResolver: createResolver({}),
          env: { NODE_ENV: "production" },
          onWarning: () => undefined,
        }),
    ).toThrow("key_config_required");
  });

  it("warns when creating a development ephemeral key and zeroes it on dispose", async () => {
    const warnings: string[] = [];
    const provider = new LocalKeyProvider({
      secretResolver: createResolver({}),
      env: { NODE_ENV: "development" },
      onWarning: (code) => warnings.push(code),
    });
    const key = await provider.getKey(provider.currentKeyId());

    expect(key).toHaveLength(32);
    expect(warnings).toEqual(["keys_ephemeral"]);
    provider.dispose();

    expect(key).toEqual(new Uint8Array(32));
    await expect(provider.getKey(provider.currentKeyId())).rejects.toMatchObject({
      code: "key_provider_disposed",
    });
  });

  it("zeroes configured key buffers when disposed", async () => {
    const provider = createProvider(
      createConfig("current", [{ id: "current", secret: "env:KEY" }]),
      { "env:KEY": Buffer.alloc(32, 9).toString("base64") },
    );
    const key = await provider.getKey("current");

    provider.dispose();

    expect(key).toEqual(new Uint8Array(32));
  });

  it("maps resolver failures to a value-free error", async () => {
    const provider = new LocalKeyProvider({
      config: createConfig("current", [{ id: "current", secret: "env:KEY" }]),
      secretResolver: {
        resolve() {
          return Promise.reject(new Error("synthetic-secret-value"));
        },
      },
      onWarning: () => undefined,
    });

    await expect(provider.getKey("current")).rejects.toMatchObject({
      code: "key_secret_unavailable",
      message: "key_secret_unavailable",
    });
  });

  it("zeroes an in-flight key rather than caching it after disposal", async () => {
    const keyBytes = Buffer.alloc(32, 10);
    let release: () => void = () => undefined;
    let notifyStarted: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      notifyStarted = resolve;
    });
    const provider = new LocalKeyProvider({
      config: createConfig("current", [{ id: "current", secret: "env:KEY" }]),
      secretResolver: {
        async resolve() {
          notifyStarted();
          await gate;
          return { reveal: () => keyBytes.toString("base64") };
        },
      },
      onWarning: () => undefined,
    });
    const pending = provider.getKey("current");
    await started;
    provider.dispose();
    release();

    await expect(pending).rejects.toMatchObject({ code: "key_provider_disposed" });
    expect(keyBytes).toEqual(Buffer.alloc(32, 10));
  });
});
