// SPDX-License-Identifier: Apache-2.0
import { join } from "node:path";
import type { LocalKeyProvider } from "@rovinos/vault";
import { WorkspaceSnapshotter } from "@rovinos/sandbox";
import type { RemoteWorkspaceSnapshotPort } from "@rovinos/sandbox";
import type { IdGenerator } from "./ports.js";
import type { RuntimeConfig } from "./runtime-config.js";

/** Creates the filesystem snapshotter used to persist and restore runtime workspaces. */
export function createRuntimeWorkspaceSnapshotter(options: {
  readonly dataDir: string;
  readonly config: RuntimeConfig;
  readonly ids: IdGenerator;
  readonly keys: LocalKeyProvider;
  readonly remoteWorkspace?: RemoteWorkspaceSnapshotPort;
}): WorkspaceSnapshotter {
  return new WorkspaceSnapshotter({
    workspaceRoot: join(options.dataDir, "workspaces"),
    snapshotRoot: join(options.dataDir, "snapshots"),
    ids: options.ids,
    snapshotEncryption: options.config.sandbox?.snapshotEncryption ?? false,
    keyProvider: options.keys,
    ...(options.remoteWorkspace === undefined ? {} : { remoteWorkspace: options.remoteWorkspace }),
    ...(options.config.store?.snapshotKeep === undefined
      ? {}
      : { snapshotKeep: options.config.store.snapshotKeep }),
  });
}
