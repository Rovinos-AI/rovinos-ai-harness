// SPDX-License-Identifier: Apache-2.0
export {
  AuditingVaultResolver,
  vaultAuditToPiiAction,
  type VaultAuditHandler,
  type VaultAuditPiiAction,
  type VaultScopeResolver,
} from "./auditing-resolver.js";
export { InMemoryVault } from "./memory.js";
export { SqliteVault } from "./sqlite.js";
export { normalize } from "./normalize.js";
export { findTokens, isToken, Token, tokenType, tokenTypeName } from "./token.js";
export type { Token as TokenType } from "./token.js";
export {
  VaultValueError,
  VaultAuditSchema,
  VaultResolveContextSchema,
  type VaultAdmin,
  type VaultAudit,
  type VaultReader,
  type VaultResolver,
  type VaultResolveContext,
  type VaultWriter,
} from "./types.js";
export { VaultOperationError } from "./errors.js";
export {
  LocalKeyProvider,
  LocalKeyProviderError,
  type KeySecretResolver,
  type LocalKeyProviderErrorCode,
  type LocalKeyProviderOptions,
  type ResolvedKeySecret,
} from "./local-key-provider.js";
