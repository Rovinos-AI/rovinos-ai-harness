// SPDX-License-Identifier: Apache-2.0
import { randomBytes } from "node:crypto";
import {
  HarnessError,
  KEY_PROVIDER_KEY_BYTES,
  KeysConfigSchema,
  type KeyProvider,
  type KeysConfig,
  type SecretRef,
} from "@harness/schemas";

/** Stable errors raised by the local key provider. */
export type LocalKeyProviderErrorCode =
  | "key_config_invalid"
  | "key_config_required"
  | "key_current_missing"
  | "key_invalid_length"
  | "key_not_found"
  | "key_provider_disposed"
  | "key_secret_unavailable";

/** Safe key-provider error that never includes secret material. */
export class LocalKeyProviderError extends HarnessError {
  /** Machine-readable reason for the key operation failure. */
  readonly code: LocalKeyProviderErrorCode;

  /** Creates an error containing only its stable code. */
  constructor(code: LocalKeyProviderErrorCode) {
    super(code);
    this.code = code;
  }
}

/** The portion of a resolved secret required by the provider. */
export interface ResolvedKeySecret {
  /** Reveals the base64 key to the in-memory key provider. */
  reveal(): string;
}

/** Resolver compatible with the secret resolver in `@harness/config`. */
export interface KeySecretResolver {
  /** Resolves an external reference without returning secret values in errors. */
  resolve(ref: SecretRef): Promise<ResolvedKeySecret>;
}

/** Options for a provider backed by config secret references. */
export interface LocalKeyProviderOptions {
  /** Active and historical key references; absent config creates an ephemeral development key. */
  readonly config?: KeysConfig;
  /** Resolves configured key references when first requested. */
  readonly secretResolver: KeySecretResolver;
  /** Environment used to determine whether an ephemeral key is permitted. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Receives the warning code when a development-only ephemeral key is created. */
  readonly onWarning: (code: "keys_ephemeral") => void;
}

interface KeyReference {
  readonly secret: SecretRef;
}

function decodeKey(encoded: string): Uint8Array {
  const decoded = Buffer.from(encoded, "base64");
  if (
    decoded.byteLength !== KEY_PROVIDER_KEY_BYTES ||
    decoded.toString("base64") !== encoded
  ) {
    decoded.fill(0);
    throw new LocalKeyProviderError("key_invalid_length");
  }
  const key = Uint8Array.from(decoded);
  decoded.fill(0);
  return key;
}

/**
 * Resolves configured key versions lazily and keeps their bytes only in memory.
 *
 * Returned buffers are provider-owned and must not be modified by callers.
 * Calling `dispose` zeroes loaded buffers and prevents future resolution.
 */
export class LocalKeyProvider implements KeyProvider {
  readonly #currentKeyId: string;
  readonly #keyReferences: ReadonlyMap<string, KeyReference>;
  readonly #secretResolver: KeySecretResolver;
  readonly #cache = new Map<string, Uint8Array>();
  readonly #pending = new Map<string, Promise<Uint8Array>>();
  #disposed = false;

  /**
   * Creates a provider from configured secret references, or a development-only ephemeral key.
   *
   * @param options - Validated key config, secret resolver, environment, and warning sink.
   * @throws `key_current_missing` when the active identifier has no configured key.
   * @throws `key_config_required` when production has no key configuration.
   */
  constructor(options: LocalKeyProviderOptions) {
    this.#secretResolver = options.secretResolver;
    const env = options.env ?? process.env;
    if (options.config === undefined) {
      if (env.NODE_ENV === "production") {
        throw new LocalKeyProviderError("key_config_required");
      }
      this.#currentKeyId = "ephemeral";
      this.#keyReferences = new Map();
      const ephemeralKey = randomBytes(KEY_PROVIDER_KEY_BYTES);
      this.#cache.set("ephemeral", Uint8Array.from(ephemeralKey));
      ephemeralKey.fill(0);
      options.onWarning("keys_ephemeral");
      return;
    }

    const parsed = KeysConfigSchema.safeParse(options.config);
    if (!parsed.success) {
      throw new LocalKeyProviderError("key_config_invalid");
    }
    const keyReferences = new Map(
      parsed.data.keys.map(({ id, secret }) => [id, { secret } satisfies KeyReference]),
    );
    if (!keyReferences.has(parsed.data.currentKeyId)) {
      throw new LocalKeyProviderError("key_current_missing");
    }
    this.#currentKeyId = parsed.data.currentKeyId;
    this.#keyReferences = keyReferences;
  }

  /** Returns the configured identifier used for new encrypted content. */
  currentKeyId(): string {
    return this.#currentKeyId;
  }

  /**
   * Resolves a configured key version, caching its 32-byte value in memory.
   *
   * @param keyId - Persisted key identifier to resolve.
   * @returns The provider-owned key buffer.
   * @throws `key_not_found` when the identifier is not configured.
   * @throws `key_invalid_length` when the secret is not canonical base64 for 32 bytes.
   */
  async getKey(keyId: string): Promise<Uint8Array> {
    if (this.#disposed) {
      throw new LocalKeyProviderError("key_provider_disposed");
    }
    const reference = this.#keyReferences.get(keyId);
    if (reference === undefined && !this.#cache.has(keyId)) {
      throw new LocalKeyProviderError("key_not_found");
    }
    const cached = this.#cache.get(keyId);
    if (cached !== undefined) {
      return cached;
    }
    const pending = this.#pending.get(keyId);
    if (pending !== undefined) {
      return pending;
    }
    if (reference === undefined) {
      throw new LocalKeyProviderError("key_not_found");
    }

    const loading = this.#resolveKey(keyId, reference.secret);
    this.#pending.set(keyId, loading);
    try {
      return await loading;
    } finally {
      if (this.#pending.get(keyId) === loading) {
        this.#pending.delete(keyId);
      }
    }
  }

  /** Zeroes loaded key buffers and prevents further key access. */
  dispose(): void {
    this.#disposed = true;
    for (const key of this.#cache.values()) {
      key.fill(0);
    }
    this.#cache.clear();
  }

  async #resolveKey(keyId: string, secretRef: SecretRef): Promise<Uint8Array> {
    let key: Uint8Array;
    try {
      key = decodeKey((await this.#secretResolver.resolve(secretRef)).reveal());
    } catch (error) {
      if (error instanceof LocalKeyProviderError) {
        throw error;
      }
      throw new LocalKeyProviderError("key_secret_unavailable");
    }
    if (this.#disposed) {
      key.fill(0);
      throw new LocalKeyProviderError("key_provider_disposed");
    }
    this.#cache.set(keyId, key);
    return key;
  }
}
