// SPDX-License-Identifier: Apache-2.0
import { HarnessError } from "@harness/schemas";
import { z } from "zod";

const vaultOperationErrorCodeSchema = z.enum([
  "vault_encrypt_failed",
  "vault_decrypt_failed",
  "vault_unavailable",
  "vault_migration_checksum_mismatch",
  "vault_migration_newer_than_code",
]);

type VaultOperationErrorCode = z.infer<typeof vaultOperationErrorCodeSchema>;

const ERROR_MESSAGES: Record<VaultOperationErrorCode, string> = {
  vault_encrypt_failed: "Vault encryption failed",
  vault_decrypt_failed: "Vault decryption failed",
  vault_unavailable: "Vault operation failed",
  vault_migration_checksum_mismatch: "Vault migration checksum mismatch",
  vault_migration_newer_than_code: "Vault schema is newer than this version",
};

/** A detail-free failure raised by the encrypted vault adapter. */
export class VaultOperationError extends HarnessError {
  readonly code: VaultOperationErrorCode;

  constructor(code: VaultOperationErrorCode) {
    super(ERROR_MESSAGES[vaultOperationErrorCodeSchema.parse(code)]);
    this.code = vaultOperationErrorCodeSchema.parse(code);
  }
}
