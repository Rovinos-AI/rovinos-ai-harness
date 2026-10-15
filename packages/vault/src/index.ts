// SPDX-License-Identifier: Apache-2.0
export {
  AuditingVaultResolver,
  vaultAuditToPiiAction,
  type VaultAuditHandler,
  type VaultAuditPiiAction,
  type VaultScopeResolver,
} from "./auditing-resolver.js";
export { InMemoryVault } from "./memory.js";
export { PostgresVault, type PostgresVaultOptions } from "./postgres.js";
export { SqliteVault } from "./sqlite.js";
export {
  purgeExpired,
  VaultPurger,
  type VaultPurgeClock,
  type VaultPurgerOptions,
} from "./purger.js";
export { normalize } from "./normalize.js";
export { findTokens, isToken, Token, tokenType, tokenTypeName } from "./token.js";
export type { Token as TokenType } from "./token.js";
export {
  VaultValueError,
  VaultAuditSchema,
  VaultPurgeResultSchema,
  VaultResolveContextSchema,
  VaultTerminalRunsQuerySchema,
  VaultTimestampSchema,
  type VaultAdmin,
  type VaultAudit,
  type VaultPurgeResult,
  type VaultReader,
  type VaultResolver,
  type VaultResolveContext,
  type VaultTerminalRunsQuery,
  type VaultWriter,
} from "./types.js";
export { VaultOperationError } from "./errors.js";
export {
  ReencryptBatchResultSchema,
  VaultKeyRowCountSchema,
  VaultReencryptBatchInputSchema,
  decodeVaultRotationCursor,
  encodeVaultRotationCursor,
  type ReencryptBatchResult,
  type VaultKeyRotation,
  type VaultKeyRowCount,
  type VaultReencryptBatchInput,
} from "./rotate.js";
export {
  LocalKeyProvider,
  LocalKeyProviderError,
  type KeySecretResolver,
  type LocalKeyProviderErrorCode,
  type LocalKeyProviderOptions,
  type ResolvedKeySecret,
} from "./local-key-provider.js";
