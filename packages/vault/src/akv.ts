// SPDX-License-Identifier: Apache-2.0
import { DefaultAzureCredential } from "@azure/identity";
import { SecretClient, type GetSecretOptions, type KeyVaultSecret } from "@azure/keyvault-secrets";
import {
  HarnessError,
  KeysConfigSchema,
  SecretRefSchema,
  type KeyProvider,
  type KeysConfig,
  type SecretRef,
} from "@harness/schemas";
import { inspect } from "node:util";
import { z } from "zod";
import { LocalKeyProvider, LocalKeyProviderError } from "./local-key-provider.js";

const vaultNamePattern = /^[a-zA-Z][a-zA-Z0-9-]{2,23}$/u;
const secretNamePattern = /^[a-zA-Z0-9-]{1,127}$/u;
const secretVersionPattern = /^[a-zA-Z0-9-]{1,64}$/u;
const keyIdPattern = /^[a-zA-Z0-9-]{1,115}$/u;

const AkvSecretReferenceSchema = z
  .object({
    vaultName: z.string().regex(vaultNamePattern),
    secretName: z.string().regex(secretNamePattern),
    version: z.string().regex(secretVersionPattern).optional(),
  })
  .strict();

type AkvSecretReference = z.infer<typeof AkvSecretReferenceSchema>;

/** Stable error codes raised by the Azure Key Vault integration. */
export type AkvSecretResolverErrorCode =
  | "secret_access_denied"
  | "secret_not_found"
  | "secret_ref_invalid"
  | "secret_resolution_cancelled"
  | "secret_resolver_unavailable";

/** Safe error raised when Azure Key Vault cannot resolve a secret reference. */
export class AkvSecretResolverError extends HarnessError {
  /** Stable reason for the failed resolution. */
  readonly code: AkvSecretResolverErrorCode;

  /** Creates a detail-free resolution error. */
  constructor(code: AkvSecretResolverErrorCode) {
    super(code);
    this.code = code;
  }
}

/** Clock used to expire cached secrets. */
export interface AkvClock {
  /** Returns the current time in epoch milliseconds. */
  now(): number;
}

/** Minimal Azure client surface used by the resolver and its tests. */
export interface SecretClientLike {
  /** Retrieves a secret, optionally pinned to a version and cancellable by signal. */
  getSecret(
    name: string,
    options?: Pick<GetSecretOptions, "abortSignal" | "version">,
  ): Promise<Pick<KeyVaultSecret, "value">>;
}

/** Creates an Azure Key Vault client for a validated vault URL. */
export type SecretClientFactory = (vaultUrl: string) => SecretClientLike;

/** Configuration for an Azure Key Vault secret resolver. */
export interface AkvSecretResolverOptions {
  /** Current time source used for cache expiration. */
  readonly clock?: AkvClock;
  /** Secret cache lifetime in milliseconds; defaults to five minutes. */
  readonly cacheTtlMs?: number;
  /** Client factory; defaults to `SecretClient` with `DefaultAzureCredential`. */
  readonly clientFactory?: SecretClientFactory;
}

interface CachedSecret {
  readonly value: AkvSecret;
  readonly expiresAt: number;
}

/** Opaque secret value with redacted text, JSON, and inspection representations. */
export class AkvSecret {
  readonly #value: string;

  /** Wraps a value returned by Key Vault. */
  constructor(value: string) {
    this.#value = value;
  }

  /** Explicitly reveals the secret to its intended consumer. */
  reveal(): string {
    return this.#value;
  }

  /** Returns a redacted representation for string conversion. */
  toString(): string {
    return "[REDACTED]";
  }

  /** Returns a redacted representation for JSON serialization. */
  toJSON(): string {
    return "[REDACTED]";
  }

  /** Returns a redacted representation for Node.js inspection. */
  [inspect.custom](): string {
    return "[REDACTED]";
  }
}

function defaultClientFactory(vaultUrl: string): SecretClientLike {
  return new SecretClient(vaultUrl, new DefaultAzureCredential());
}

function parseReference(ref: SecretRef): AkvSecretReference {
  if (!ref.startsWith("akv:")) {
    throw new AkvSecretResolverError("secret_resolver_unavailable");
  }
  const [resource, ...unexpected] = ref.slice(4).split("#");
  if (unexpected.length > 1 || resource === undefined) {
    throw new AkvSecretResolverError("secret_ref_invalid");
  }
  const [vaultName, secretName, ...extra] = resource.split("/");
  const version = unexpected[0];
  const parsed = AkvSecretReferenceSchema.safeParse({
    vaultName,
    secretName,
    ...(version === undefined ? {} : { version }),
  });
  if (!parsed.success || extra.length !== 0) {
    throw new AkvSecretResolverError("secret_ref_invalid");
  }
  return parsed.data;
}

function statusCodeOf(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null || !("statusCode" in error)) {
    return undefined;
  }
  return typeof error.statusCode === "number" ? error.statusCode : undefined;
}

function mappedResolutionError(error: unknown): AkvSecretResolverError {
  const statusCode = statusCodeOf(error);
  if (statusCode === 404) {
    return new AkvSecretResolverError("secret_not_found");
  }
  if (statusCode === 401 || statusCode === 403) {
    return new AkvSecretResolverError("secret_access_denied");
  }
  return new AkvSecretResolverError("secret_resolver_unavailable");
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted === true) {
    throw new AkvSecretResolverError("secret_resolution_cancelled");
  }
}

/**
 * Resolves `akv:<vaultName>/<secretName>[#version]` references through Azure Key Vault.
 *
 * @param options - Injectable clock, cache TTL, and client factory.
 */
export class AkvSecretResolver {
  readonly #clock: AkvClock;
  readonly #cacheTtlMs: number;
  readonly #clientFactory: SecretClientFactory;
  readonly #clients = new Map<string, SecretClientLike>();
  readonly #cache = new Map<string, CachedSecret>();

  constructor(options: AkvSecretResolverOptions = {}) {
    const ttl = options.cacheTtlMs ?? 300_000;
    if (!Number.isSafeInteger(ttl) || ttl < 0) {
      throw new RangeError("secret_cache_ttl_invalid");
    }
    this.#clock = options.clock ?? { now: () => Date.now() };
    this.#cacheTtlMs = ttl;
    this.#clientFactory = options.clientFactory ?? defaultClientFactory;
  }

  /** Resolves a reference to an opaque, redacting secret value. */
  async resolve(ref: SecretRef, signal?: AbortSignal): Promise<AkvSecret> {
    throwIfAborted(signal);
    const { vaultName, secretName, version } = parseReference(ref);
    const cacheKey = `${vaultName}/${secretName}/${version ?? ""}`;
    const now = this.#clock.now();
    for (const [key, entry] of this.#cache) {
      if (entry.expiresAt <= now) {
        this.#cache.delete(key);
      }
    }
    const cached = this.#cache.get(cacheKey);
    if (cached !== undefined && cached.expiresAt > now) {
      return cached.value;
    }

    let secret: Pick<KeyVaultSecret, "value">;
    try {
      const vaultUrl = `https://${vaultName}.vault.azure.net`;
      let client = this.#clients.get(vaultName);
      if (client === undefined) {
        client = this.#clientFactory(vaultUrl);
        this.#clients.set(vaultName, client);
      }
      secret = await client.getSecret(secretName, {
        ...(version === undefined ? {} : { version }),
        ...(signal === undefined ? {} : { abortSignal: signal }),
      });
    } catch (error) {
      if (signal?.aborted === true) {
        throw new AkvSecretResolverError("secret_resolution_cancelled");
      }
      throw mappedResolutionError(error);
    }
    throwIfAborted(signal);
    if (secret.value === undefined) {
      throw new AkvSecretResolverError("secret_not_found");
    }

    const value = new AkvSecret(secret.value);
    if (this.#cacheTtlMs > 0) {
      this.#cache.set(cacheKey, { value, expiresAt: now + this.#cacheTtlMs });
    }
    return value;
  }
}

/** Options for an Azure Key Vault-backed content key provider. */
export interface AkvKeyProviderOptions {
  /** Configured key versions and active key identifier. */
  readonly config: KeysConfig;
  /** Vault containing secrets named `harness-key-<keyId>`. */
  readonly vaultName: string;
  /** Resolver override, primarily for tests and shared resolver caches. */
  readonly secretResolver?: AkvSecretResolver;
}

/**
 * Loads canonical base64 32-byte keys from `harness-key-<keyId>` Key Vault secrets.
 *
 * Configured references are used only to enumerate active and historical key IDs.
 * Key material is cached in memory by `LocalKeyProvider` and zeroed by `dispose`.
 */
export class AkvKeyProvider implements KeyProvider {
  readonly #provider: LocalKeyProvider;

  constructor(options: AkvKeyProviderOptions) {
    const config = KeysConfigSchema.safeParse(options.config);
    if (
      !config.success ||
      !AkvSecretReferenceSchema.shape.vaultName.safeParse(options.vaultName).success
    ) {
      throw new LocalKeyProviderError("key_config_invalid");
    }
    if (
      config.data.keys.some(
        ({ id, secret }) =>
          !keyIdPattern.test(id) ||
          secret !== `akv:${options.vaultName}/harness-key-${id}` ||
          !SecretRefSchema.safeParse(secret).success,
      )
    ) {
      throw new LocalKeyProviderError("key_config_invalid");
    }
    const secretResolver = options.secretResolver ?? new AkvSecretResolver();
    this.#provider = new LocalKeyProvider({
      config: {
        currentKeyId: config.data.currentKeyId,
        keys: config.data.keys.map(({ id }) => ({
          id,
          secret: SecretRefSchema.parse(`akv:${options.vaultName}/harness-key-${id}`),
        })),
      },
      secretResolver: {
        resolve: (ref) => secretResolver.resolve(ref),
      },
      onWarning: () => undefined,
    });
  }

  /** Returns the configured identifier used for new encrypted content. */
  currentKeyId(): string {
    return this.#provider.currentKeyId();
  }

  /** Resolves and caches a key by its configured identifier. */
  getKey(keyId: string): Promise<Uint8Array> {
    return this.#provider.getKey(keyId);
  }

  /** Zeroes loaded key buffers and prevents further key access. */
  dispose(): void {
    this.#provider.dispose();
  }
}
