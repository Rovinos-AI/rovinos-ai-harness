// SPDX-License-Identifier: Apache-2.0
import type { SecretRef } from "@rovinos/schemas";
import type { Clock, StoreKeyRotation } from "@rovinos/store";
import type { VaultAdmin, VaultKeyRotation } from "@rovinos/vault";

/** Inputs shared by runtime and CLI configured-store operations. */
export interface ConfiguredStoreOptions {
  readonly dataDir?: string;
  readonly readOnly?: boolean;
  readonly appliedAt?: number;
  readonly clock?: Clock;
  readonly secretResolver?: {
    resolve(ref: SecretRef): Promise<{ reveal(): string }>;
  };
}

/** Options for opening the configured vault for maintenance. */
export interface ConfiguredVaultOptions {
  readonly dataDir?: string;
  readonly clock?: Clock;
  readonly secretResolver?: ConfiguredStoreOptions["secretResolver"];
}

/** Vault administration handle with ownership of its SQLite and key resources. */
export interface ConfiguredVaultAdmin extends VaultAdmin {
  /** Close the vault database and dispose its cached keys. */
  close(): void | Promise<void>;
}

/** Opened rotation adapters and the key provider they share. */
export interface ConfiguredKeyRotation {
  /** The configured current key id used for new writes. */
  readonly currentKeyId: string;
  /** Selected dedicated vault adapter, when requested. */
  readonly vault?: VaultKeyRotation & { close(): void | Promise<void> };
  /** Selected event-store adapter, when requested. */
  readonly store?: StoreKeyRotation & { close(): Promise<void> };
  /** Close opened databases and zero cached key material. */
  close(): Promise<void>;
}

/** Selects which configured stores to open for key rotation maintenance. */
export interface ConfiguredKeyRotationOptions extends ConfiguredStoreOptions {
  readonly vault: boolean;
  readonly store: boolean;
}
