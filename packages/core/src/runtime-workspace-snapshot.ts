// SPDX-License-Identifier: Apache-2.0
import { join } from "node:path";
import type { LocalKeyProvider } from "@harness/vault";
import { WorkspaceSnapshotter } from "@harness/sandbox";
import type { IdGenerator } from "./ports.js";
import type { RuntimeConfig } from "./runtime-config.js";

/** Creates the filesystem snapshotter used to persist and restore runtime workspaces. */
export function createRuntimeWorkspaceSnapshotter(
  dataDir: string,
  config: RuntimeConfig,
  ids: IdGenerator,
  keys: LocalKeyProvider,
): WorkspaceSnapshotter {
  return new WorkspaceSnapshotter({
    workspaceRoot: join(dataDir, "workspaces"),
    snapshotRoot: join(dataDir, "snapshots"),
    ids,
    snapshotEncryption: config.sandbox?.snapshotEncryption ?? false,
    ...(config.sandbox?.snapshotEncryption === true ? { keyProvider: keys } : {}),
  });
}
