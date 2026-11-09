// SPDX-License-Identifier: Apache-2.0
import { InMemoryWorkspace, type WorkspacePort } from "@rovinos/context";

/** Capture workspace writes while preserving the in-memory workspace's read behavior. */
export function createCapturedWorkspace(): {
  readonly workspace: WorkspacePort;
  readonly files: Map<string, Uint8Array>;
} {
  const memory = new InMemoryWorkspace();
  const files = new Map<string, Uint8Array>();
  const workspace: WorkspacePort = {
    write: async (path, data) => {
      await memory.write(path, data);
      files.set(path, data.slice());
    },
    writeBatch: async (entries) => {
      await memory.writeBatch(entries);
      for (const { path, data } of entries) {
        files.set(path, data.slice());
      }
    },
    read: (path, range) => memory.read(path, range),
  };
  return { workspace, files };
}
