// SPDX-License-Identifier: Apache-2.0
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Id, WorkspaceRef } from "@rovinos/schemas";
import { afterEach, describe, expect, it } from "vitest";
import { purgeWorkspaceSnapshots, WorkspaceSnapshotRetention } from "./snapshot-retention.js";

const runId = Id.parse("00000000000000000000000001");
const firstSnapshotId = Id.parse("00000000000000000000000002");
const secondSnapshotId = Id.parse("00000000000000000000000003");
const roots: string[] = [];

async function createRoot(): Promise<string> {
  const root = await mkdtemp(join(process.cwd(), ".tmp", "snapshot-retention-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("workspace snapshot retention", () => {
  it("purges absent run snapshots and rejects non-directory roots and symlinked run paths", async () => {
    const root = await createRoot();
    await expect(purgeWorkspaceSnapshots(join(root, "missing"), runId)).resolves.toBeUndefined();

    const regularFile = join(root, "not-a-directory");
    await writeFile(regularFile, "synthetic");
    await expect(purgeWorkspaceSnapshots(regularFile, runId)).rejects.toMatchObject({
      code: "workspace_snapshot_invalid",
    });

    const snapshotRoot = join(root, "snapshots");
    const outside = join(root, "outside");
    await mkdir(snapshotRoot);
    await mkdir(outside);
    await symlink(outside, join(snapshotRoot, runId));
    await expect(purgeWorkspaceSnapshots(snapshotRoot, runId)).rejects.toMatchObject({
      code: "workspace_snapshot_invalid",
    });
  });

  it("prunes unretained archives and treats already-removed snapshots idempotently", async () => {
    const root = await createRoot();
    const runDirectory = join(root, runId);
    await mkdir(runDirectory);
    const retainedPath = join(runDirectory, `${firstSnapshotId}.tar.gz`);
    const removedPath = join(runDirectory, `${secondSnapshotId}.tar.gz`);
    await writeFile(retainedPath, "retained");
    await writeFile(removedPath, "expired");
    await writeFile(join(runDirectory, "unrelated.txt"), "not an archive");

    const retention = new WorkspaceSnapshotRetention(root, 1, async () => runDirectory);
    const retainedRef = WorkspaceRef.parse(`ws:${firstSnapshotId}:0123456789abcdef`);
    await retention.prune(runId, [retainedRef]);
    await expect(rm(removedPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(writeFile(retainedPath, "retained")).resolves.toBeUndefined();
    await expect(retention.deleteSnapshot(runId, retainedRef)).resolves.toBeUndefined();
    await expect(retention.deleteSnapshot(runId, retainedRef)).resolves.toBeUndefined();
  });
});
