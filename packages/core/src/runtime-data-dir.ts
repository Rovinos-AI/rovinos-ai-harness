// SPDX-License-Identifier: Apache-2.0

/**
 * Resolves the data directory used for harness runtime state.
 *
 * @param env - Environment source.
 * @param override - Explicit directory override.
 * @returns Explicit override, environment value, or the current directory.
 */
export function resolveDataDir(
  env: Readonly<Record<string, string | undefined>>,
  override?: string,
): string {
  return override ?? env.HARNESS_DATA_DIR ?? process.cwd();
}

/**
 * Resolves the vault directory, defaulting to the shared runtime data directory.
 *
 * @param env - Environment source.
 * @param dataDir - Resolved runtime data directory.
 * @returns The configured vault directory or runtime data directory.
 */
export function resolveVaultDataDir(
  env: Readonly<Record<string, string | undefined>>,
  dataDir: string,
): string {
  return env.HARNESS_VAULT_DATA_DIR ?? dataDir;
}
