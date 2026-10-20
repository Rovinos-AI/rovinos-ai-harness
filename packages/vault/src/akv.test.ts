// SPDX-License-Identifier: Apache-2.0
import { format, inspect } from "node:util";
import { KeysConfigSchema, SecretRefSchema } from "@harness/schemas";
import { describe, expect, it } from "vitest";
import {
  AkvKeyProvider,
  AkvSecret,
  AkvSecretResolver,
  AkvSecretResolverError,
  type AkvClock,
  type SecretClientLike,
} from "./akv.js";

function secretRef(ref: string) {
  return SecretRefSchema.parse(ref);
}

function secretResponse(value: string | undefined): Promise<{ value?: string }> {
  return Promise.resolve(value === undefined ? {} : { value });
}

describe("AkvSecret", () => {
  it("reveals only explicitly and redacts text, JSON, and inspection", () => {
    const secret = new AkvSecret("AKV_SECRET_CANARY");

    expect(secret.reveal()).toBe("AKV_SECRET_CANARY");
    expect(String(secret)).toBe("[REDACTED]");
    expect(JSON.stringify(secret)).toBe('"[REDACTED]"');
    expect(inspect(secret)).toBe("[REDACTED]");
    expect(format("%s %o", secret, secret)).toBe("[REDACTED] [REDACTED]");
  });
});

describe("AkvSecretResolver", () => {
  it("resolves a secret from the validated HTTPS vault URL", async () => {
    const urls: string[] = [];
    let calls = 0;
    const client: SecretClientLike = {
      getSecret: () => {
        calls += 1;
        return secretResponse("AKV_SECRET_CANARY");
      },
    };
    const resolver = new AkvSecretResolver({
      clientFactory: (url) => {
        urls.push(url);
        return client;
      },
    });
    const secret = await resolver.resolve(secretRef("akv:vault-name/database-password"));

    expect(secret.reveal()).toBe("AKV_SECRET_CANARY");
    expect(urls).toEqual(["https://vault-name.vault.azure.net"]);
    expect(calls).toBe(1);
  });

  it("pins requested versions and caches each vault, name, and version independently", async () => {
    const requests: { name: string; version: string | undefined }[] = [];
    const resolver = new AkvSecretResolver({
      clientFactory: () => ({
        getSecret: (name, options) => {
          requests.push({ name, version: options?.version });
          return secretResponse(options?.version ?? "latest-value");
        },
      }),
    });

    const latest = await resolver.resolve(secretRef("akv:vault-name/api-key"));
    const pinned = await resolver.resolve(secretRef("akv:vault-name/api-key#version-1"));
    const pinnedAgain = await resolver.resolve(secretRef("akv:vault-name/api-key#version-1"));

    expect(latest.reveal()).toBe("latest-value");
    expect(pinned.reveal()).toBe("version-1");
    expect(pinnedAgain).toBe(pinned);
    expect(requests).toEqual([
      { name: "api-key", version: undefined },
      { name: "api-key", version: "version-1" },
    ]);
  });

  it("expires cached values at the TTL boundary using the injected clock", async () => {
    let now = 100;
    let calls = 0;
    const clock: AkvClock = { now: () => now };
    const resolver = new AkvSecretResolver({
      clock,
      cacheTtlMs: 10,
      clientFactory: () => ({
        getSecret: () => {
          calls += 1;
          return secretResponse(`value-${String(calls)}`);
        },
      }),
    });
    const ref = secretRef("akv:vault-name/secret-name");

    expect((await resolver.resolve(ref)).reveal()).toBe("value-1");
    expect((await resolver.resolve(ref)).reveal()).toBe("value-1");
    now = 110;
    expect((await resolver.resolve(ref)).reveal()).toBe("value-2");
    expect(calls).toBe(2);
  });

  it("does not cache when the TTL is zero", async () => {
    let calls = 0;
    const resolver = new AkvSecretResolver({
      cacheTtlMs: 0,
      clientFactory: () => ({
        getSecret: () => {
          calls += 1;
          return secretResponse("value");
        },
      }),
    });
    const ref = secretRef("akv:vault-name/secret-name");

    await resolver.resolve(ref);
    await resolver.resolve(ref);

    expect(calls).toBe(2);
  });

  it.each([
    ["404", 404, "secret_not_found"],
    ["401", 401, "secret_access_denied"],
    ["403", 403, "secret_access_denied"],
    ["other status", 500, "secret_resolver_unavailable"],
  ] as const)("maps %s without preserving the response body", async (_label, statusCode, code) => {
    const resolver = new AkvSecretResolver({
      clientFactory: () => ({
        getSecret: () =>
          Promise.reject(Object.assign(new Error("AKV_ERROR_BODY_CANARY"), { statusCode })),
      }),
    });
    let error: unknown;
    try {
      await resolver.resolve(secretRef("akv:vault-name/secret-name"));
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(AkvSecretResolverError);
    expect(error).toMatchObject({ code, message: code });
    expect(String(error)).not.toContain("AKV_ERROR_BODY_CANARY");
  });

  it("maps missing values and errors without HTTP status to safe resolver errors", async () => {
    const resolver = new AkvSecretResolver({
      clientFactory: () => ({
        getSecret: () => secretResponse(undefined),
      }),
    });
    await expect(resolver.resolve(secretRef("akv:vault-name/secret-name"))).rejects.toMatchObject({
      code: "secret_not_found",
    });

    const unavailable = new AkvSecretResolver({
      clientFactory: () => ({
        getSecret: () => Promise.reject(new Error("AKV_ERROR_BODY_CANARY")),
      }),
    });
    await expect(
      unavailable.resolve(secretRef("akv:vault-name/secret-name")),
    ).rejects.toMatchObject({
      code: "secret_resolver_unavailable",
      message: "secret_resolver_unavailable",
    });

    const failedFactory = new AkvSecretResolver({
      clientFactory: () => {
        throw new Error("AKV_FACTORY_ERROR_CANARY");
      },
    });
    await expect(
      failedFactory.resolve(secretRef("akv:vault-name/secret-name")),
    ).rejects.toMatchObject({ code: "secret_resolver_unavailable" });
  });

  it.each([
    "akv:va/secret-name",
    "akv:1invalid-vault/secret-name",
    "akv:vault-name/invalid_secret",
    "akv:vault-name/secret-name#",
    "akv:vault-name/secret-name#bad/version",
    "akv:vault-name/secret-name#one#two",
  ])("rejects invalid AKV references in the schema: %s", (ref) => {
    expect(SecretRefSchema.safeParse(ref).success).toBe(false);
  });

  it("rejects references for other schemes", async () => {
    const resolver = new AkvSecretResolver({
      clientFactory: () => ({
        getSecret: () => secretResponse("unused"),
      }),
    });

    await expect(resolver.resolve(secretRef("env:API_KEY"))).rejects.toMatchObject({
      code: "secret_resolver_unavailable",
    });
  });

  it("honors abort signals before and during retrieval", async () => {
    const cancelled = new AbortController();
    cancelled.abort();
    const resolver = new AkvSecretResolver({
      clientFactory: () => ({
        getSecret: () => secretResponse("unused"),
      }),
    });
    await expect(
      resolver.resolve(secretRef("akv:vault-name/secret-name"), cancelled.signal),
    ).rejects.toMatchObject({ code: "secret_resolution_cancelled" });

    const inFlight = new AbortController();
    const pendingResolver = new AkvSecretResolver({
      clientFactory: () => ({
        getSecret: (_name, options) =>
          new Promise((_resolve, reject) => {
            options?.abortSignal?.addEventListener(
              "abort",
              () => {
                reject(new Error("cancelled"));
              },
              { once: true },
            );
            inFlight.abort();
          }),
      }),
    });
    await expect(
      pendingResolver.resolve(secretRef("akv:vault-name/secret-name"), inFlight.signal),
    ).rejects.toMatchObject({ code: "secret_resolution_cancelled" });
  });

  it("rejects invalid TTL values", () => {
    expect(() => new AkvSecretResolver({ cacheTtlMs: -1 })).toThrow("secret_cache_ttl_invalid");
  });
});

describe("AkvKeyProvider", () => {
  it("loads and caches a configured 32-byte key from its conventional secret name", async () => {
    const keyBytes = Buffer.alloc(32, 17);
    const requests: string[] = [];
    const secretResolver = new AkvSecretResolver({
      clientFactory: (url) => ({
        getSecret: (name) => {
          requests.push(`${url}/${name}`);
          return secretResponse(keyBytes.toString("base64"));
        },
      }),
    });
    const provider = new AkvKeyProvider({
      config: KeysConfigSchema.parse({
        currentKeyId: "primary",
        keys: [{ id: "primary", secret: "akv:vault-name/harness-key-primary" }],
      }),
      vaultName: "vault-name",
      secretResolver,
    });

    const loaded = await provider.getKey("primary");
    expect(provider.currentKeyId()).toBe("primary");
    expect(loaded).toEqual(new Uint8Array(keyBytes));
    expect(await provider.getKey("primary")).toBe(loaded);
    expect(requests).toEqual(["https://vault-name.vault.azure.net/harness-key-primary"]);
    provider.dispose();
    expect(loaded).toEqual(new Uint8Array(32));
    await expect(provider.getKey("primary")).rejects.toMatchObject({
      code: "key_provider_disposed",
    });
  });

  it("preserves pinned versions when resolving configured key references", async () => {
    const keyBytes = Buffer.alloc(32, 23);
    const requests: { name: string; version: string | undefined }[] = [];
    const provider = new AkvKeyProvider({
      config: KeysConfigSchema.parse({
        currentKeyId: "primary",
        keys: [
          {
            id: "primary",
            secret: "akv:vault-name/harness-key-primary#0123456789abcdef0123456789abcdef",
          },
        ],
      }),
      vaultName: "vault-name",
      secretResolver: new AkvSecretResolver({
        clientFactory: () => ({
          getSecret: (name, options) => {
            requests.push({ name, version: options?.version });
            return secretResponse(keyBytes.toString("base64"));
          },
        }),
      }),
    });

    await expect(provider.getKey("primary")).resolves.toEqual(new Uint8Array(keyBytes));
    expect(requests).toEqual([
      { name: "harness-key-primary", version: "0123456789abcdef0123456789abcdef" },
    ]);
    provider.dispose();
  });

  it("reuses local key validation and rejects unknown or invalid configured IDs", async () => {
    const resolver = new AkvSecretResolver({
      clientFactory: () => ({
        getSecret: () => secretResponse(Buffer.alloc(31, 1).toString("base64")),
      }),
    });
    const provider = new AkvKeyProvider({
      config: KeysConfigSchema.parse({
        currentKeyId: "primary",
        keys: [{ id: "primary", secret: "akv:vault-name/harness-key-primary" }],
      }),
      vaultName: "vault-name",
      secretResolver: resolver,
    });
    await expect(provider.getKey("unknown")).rejects.toMatchObject({ code: "key_not_found" });
    await expect(provider.getKey("primary")).rejects.toMatchObject({
      code: "key_invalid_length",
    });

    expect(
      () =>
        new AkvKeyProvider({
          config: KeysConfigSchema.parse({
            currentKeyId: "has.dot",
            keys: [{ id: "has.dot", secret: "akv:vault-name/harness-key-has-dot" }],
          }),
          vaultName: "vault-name",
          secretResolver: resolver,
        }),
    ).toThrow("key_config_invalid");
    expect(
      () =>
        new AkvKeyProvider({
          config: KeysConfigSchema.parse({
            currentKeyId: "primary",
            keys: [{ id: "primary", secret: "akv:vault-name/harness-key-primary" }],
          }),
          vaultName: "invalid",
          secretResolver: resolver,
        }),
    ).toThrow("key_config_invalid");
  });
});
