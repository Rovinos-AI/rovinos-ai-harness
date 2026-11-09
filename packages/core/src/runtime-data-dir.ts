// SPDX-License-Identifier: Apache-2.0
import { resolve } from "node:path";

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
 * Resolves the collector configuration directory used for sink-policy validation.
 *
 * @param env - Environment source.
 * @returns Explicit collector directory or the repository-relative default.
 */
export function resolveCollectorConfigDir(
  env: Readonly<Record<string, string | undefined>>,
): string {
  return resolve(env.HARNESS_COLLECTOR_CONFIG_DIR ?? "infra/collector");
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
