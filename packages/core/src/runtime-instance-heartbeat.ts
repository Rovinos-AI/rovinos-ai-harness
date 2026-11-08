// SPDX-License-Identifier: Apache-2.0
import { join, resolve } from "node:path";
import { openSqliteInstanceHeartbeat } from "@rovinos/store-sqlite";
import type { SqliteInstanceHeartbeat } from "@rovinos/store-sqlite";
import { DeploymentStartupError } from "./runtime-deployment.js";
import type { RuntimeComposition, RuntimeConfig, RuntimeOverrides } from "./runtime-config.js";
import { resolveVaultDataDir } from "./runtime-data-dir.js";
import { SystemIdGenerator } from "./runtime-ids.js";

/** Opens heartbeat locks for local SQLite state in a single-instance deployment. */
export async function openRuntimeInstanceHeartbeat(options: {
  readonly config: RuntimeConfig;
  readonly overrides: RuntimeOverrides;
  readonly dataDir: string;
  readonly clock: RuntimeComposition["clock"];
}): Promise<RuntimeComposition["instanceHeartbeat"]> {
  if (options.config.deployment?.mode === "multi" || options.overrides.readOnlyStore === true) {
    return undefined;
  }
  const sqlitePaths = new Set<string>();
  if (options.config.store?.dialect !== "postgres" && options.overrides.store === undefined) {
    sqlitePaths.add(resolve(join(options.dataDir, "harness.db")));
  }
  if (options.config.vault?.backend !== "postgres" && options.overrides.transientVault !== true) {
    sqlitePaths.add(resolve(join(resolveVaultDataDir(process.env, options.dataDir), "vault.db")));
  }
  if (sqlitePaths.size === 0) {
    return undefined;
  }
  const heartbeats: SqliteInstanceHeartbeat[] = [];
  const instanceIds = new SystemIdGenerator(options.clock);
  try {
    for (const databasePath of sqlitePaths) {
      const heartbeat = await openSqliteInstanceHeartbeat({
        databasePath,
        instanceId: instanceIds.next(),
        now: () => options.clock.now(),
      });
      if (heartbeat === undefined) {
        throw new DeploymentStartupError("deployment_single_instance_violation");
      }
      heartbeats.push(heartbeat);
    }
  } catch (error) {
    await Promise.all(heartbeats.map((heartbeat) => heartbeat.close().catch(() => undefined)));
    throw error;
  }
  return {
    signal: AbortSignal.any(heartbeats.map(({ signal }) => signal)),
    close: async () => {
      await Promise.all(heartbeats.map((heartbeat) => heartbeat.close()));
    },
  };
}
