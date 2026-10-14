// SPDX-License-Identifier: Apache-2.0
import { VaultConfigSchema } from "@harness/schemas";
import { VaultPurgeResultSchema, type VaultAdmin, type VaultPurgeResult } from "./types.js";

const MILLIS_PER_DAY = 86_400_000;
const PURGE_BATCH_SIZE = 100;

/** Clock used to calculate the vault retention cutoff. */
export interface VaultPurgeClock {
  /** Current epoch time in milliseconds. */
  now(): number;
}

/** Inputs used to purge terminal vault runs after their grace period. */
export interface VaultPurgerOptions {
  /** Administrative vault access, isolated from resolver and reader consumers. */
  readonly vault: VaultAdmin;
  /** Clock used to calculate the retention cutoff. */
  readonly clock: VaultPurgeClock;
  /** Number of days to retain entries after a run becomes terminal. */
  readonly purgeAfterDays: number;
}

/**
 * Purges terminal runs whose post-completion grace period has expired.
 *
 * @param options - Vault administrator, clock, and validated vault retention setting.
 * @returns Counts of terminal runs examined and purged, and vault entries removed.
 */
export async function purgeExpired(options: VaultPurgerOptions): Promise<VaultPurgeResult> {
  const { purgeAfterDays } = VaultConfigSchema.parse({
    purgeAfterDays: options.purgeAfterDays,
  });
  const terminalBefore = Math.floor(options.clock.now()) - purgeAfterDays * MILLIS_PER_DAY;
  let examined = 0;
  let purged = 0;
  let entriesPurged = 0;

  for (;;) {
    const runIds = await options.vault.listTerminalRunsBefore({
      terminalBefore,
      limit: PURGE_BATCH_SIZE,
    });
    examined += runIds.length;
    if (runIds.length === 0) {
      break;
    }
    for (const runId of runIds) {
      entriesPurged += await options.vault.purge(runId);
      purged += 1;
    }
  }

  return VaultPurgeResultSchema.parse({ examined, purged, entriesPurged });
}

/** Stateful wrapper for scheduled terminal-run vault purges. */
export class VaultPurger {
  private readonly options: VaultPurgerOptions;

  /** Create a purger using the configured post-completion grace period. */
  constructor(options: VaultPurgerOptions) {
    this.options = {
      ...options,
      purgeAfterDays: VaultConfigSchema.parse({
        purgeAfterDays: options.purgeAfterDays,
      }).purgeAfterDays,
    };
  }

  /** Purge eligible batches and return run and entry counts. */
  purgeExpired(): Promise<VaultPurgeResult> {
    return purgeExpired(this.options);
  }
}
