// SPDX-License-Identifier: Apache-2.0
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { Id } from "@rovinos/schemas";
import * as tar from "tar";
import { afterEach, expect, it, vi } from "vitest";
import { WorkspaceSnapshotter, type RemoteWorkspaceSnapshotPort } from "./snapshot.js";
import { createEmptyWorkspaceArchive } from "./snapshot-empty.js";

const runId = Id.parse("00000000000000000000000001");
const roots: string[] = [];

async function createRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "empty-workspace-snapshot-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

async function archiveEntries(archive: Readable): Promise<string[]> {
  const entries: string[] = [];
  await pipeline(
    archive,
    tar.t({
      onReadEntry: (entry) => {
        entries.push(entry.path.replace(/^\.\//u, "").replace(/\/$/u, ""));
      },
    }),
  );
  return entries.sort();
}

function remoteWorkspace(exists: boolean): {
  readonly port: RemoteWorkspaceSnapshotPort;
  readonly createArchive: ReturnType<typeof vi.fn>;
  readonly restored: string[][];
} {
  const restored: string[][] = [];
  const createArchive = vi.fn(() => createEmptyWorkspaceArchive(runId));
  return {
    createArchive,
    restored,
    port: {
      hasWorkspace: () => Promise.resolve(exists),
      createArchive,
      restoreArchive: async (_runId, archive) => {
        restored.push(await archiveEntries(archive));
      },
    },
  };
}

async function snapshotter(port: RemoteWorkspaceSnapshotPort): Promise<WorkspaceSnapshotter> {
  const root = await createRoot();
  const workspaceRoot = join(root, "workspaces");
  const snapshotRoot = join(root, "snapshots");
  await mkdir(workspaceRoot);
  await mkdir(snapshotRoot);
  let next = 1;
  return new WorkspaceSnapshotter({
    workspaceRoot,
    snapshotRoot,
    ids: { next: () => Id.parse(`000000000000000000000000${String(10 + next++)}`) },
    remoteWorkspace: port,
  });
}

it("archives the standard empty layout and removes its scratch copy", async () => {
  const scratchRoot = await createRoot();

  const entries = await archiveEntries(await createEmptyWorkspaceArchive(runId, scratchRoot));

  expect(entries).toEqual(expect.arrayContaining(["project", ".harness/offload"]));
  await vi.waitFor(async () => {
    expect(await readdir(scratchRoot)).toEqual([]);
  });
});

it("checkpoints a remote run whose workspace does not exist yet and restores it empty", async () => {
  const remote = remoteWorkspace(false);
  const workspaces = await snapshotter(remote.port);

  const ref = await workspaces.snapshot(runId);
  await workspaces.restore(runId, ref);

  expect(remote.createArchive).not.toHaveBeenCalled();
  expect(remote.restored).toEqual([expect.arrayContaining(["project", ".harness/offload"])]);
});

it("still archives an existing remote workspace through the runner", async () => {
  const remote = remoteWorkspace(true);
  const workspaces = await snapshotter(remote.port);

  await workspaces.snapshot(runId);

  expect(remote.createArchive).toHaveBeenCalledOnce();
});
