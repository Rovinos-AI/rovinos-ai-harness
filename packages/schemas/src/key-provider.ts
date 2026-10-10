// SPDX-License-Identifier: Apache-2.0

/** Required key size for AES-256 content encryption. */
export const KEY_PROVIDER_KEY_BYTES = 32;

/** Provides the active content-encryption key and historical keys by identifier. */
export interface KeyProvider {
  /** Return the identifier for the key that should encrypt new content. */
  currentKeyId(): string;

  /**
   * Resolve a key by its persisted identifier.
   *
   * @param keyId Identifier stored alongside encrypted content.
   * @returns The 32-byte AES-256 key.
   * @throws An error with code `key_not_found` when the identifier is unavailable.
   */
  getKey(keyId: string): Promise<Uint8Array>;
}
