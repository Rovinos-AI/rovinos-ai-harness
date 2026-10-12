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
