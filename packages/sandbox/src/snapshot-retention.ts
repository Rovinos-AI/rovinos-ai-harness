// SPDX-License-Identifier: Apache-2.0
import { lstat, readdir, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { Id, WorkspaceRef } from "@rovinos/schemas";
import { WorkspaceSnapshotError, workspaceSnapshotRefParts } from "./snapshot-archive.js";

function codeOf(error: unknown): string | undefined {
  return error instanceof Error && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}

/** Deletes all workspace archives associated with one purged run. */
export async function purgeWorkspaceSnapshots(snapshotRoot: string, runId: string): Promise<void> {
  const validatedRunId = Id.parse(runId);
  const rootInfo = await lstat(snapshotRoot).catch((error: unknown) => {
    if (codeOf(error) === "ENOENT") {
      return undefined;
    }
    throw new WorkspaceSnapshotError();
  });
  if (rootInfo === undefined) {
    return;
  }
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    throw new WorkspaceSnapshotError();
  }
  const root = await realpath(snapshotRoot).catch(() => {
    throw new WorkspaceSnapshotError();
  });
  const path = join(root, validatedRunId);
  const info = await lstat(path).catch((error: unknown) => {
    if (codeOf(error) === "ENOENT") {
      return undefined;
    }
    throw new WorkspaceSnapshotError();
  });
  if (info !== undefined && (!info.isDirectory() || info.isSymbolicLink())) {
    throw new WorkspaceSnapshotError();
  }
  await rm(path, { recursive: true, force: true });
}

/** Applies event-store retention to workspace snapshot files. */
export class WorkspaceSnapshotRetention {
  constructor(
    private readonly snapshotRoot: string,
    private readonly keep: number,
    private readonly ensureRunDirectory: (runId: Id) => Promise<string>,
  ) {}

  async prune(runId: string, retainedRefs: readonly WorkspaceRef[]): Promise<void> {
    const directory = await this.ensureRunDirectory(Id.parse(runId));
    const retainedIds = new Set(
      retainedRefs
        .slice(-this.keep)
        .map((ref) => workspaceSnapshotRefParts(WorkspaceRef.parse(ref)).snapshotId),
    );
    for (const name of await readdir(directory)) {
      if (!/^[0-9A-HJKMNP-TV-Z]{26}\.tar\.gz$/u.test(name)) {
        continue;
      }
      const path = join(directory, name);
      const info = await lstat(path);
      const snapshotId = name.slice(0, -".tar.gz".length);
      if (info.isFile() && !info.isSymbolicLink() && !retainedIds.has(Id.parse(snapshotId))) {
        await rm(path, { force: true });
      }
    }
  }

  async deleteSnapshot(runId: string, ref: WorkspaceRef): Promise<void> {
    const validatedRunId = Id.parse(runId);
    const { snapshotId } = workspaceSnapshotRefParts(WorkspaceRef.parse(ref));
    const directory = await this.ensureRunDirectory(validatedRunId);
    const path = join(directory, `${snapshotId}.tar.gz`);
    const info = await lstat(path).catch((error: unknown) => {
      if (codeOf(error) === "ENOENT") {
        return undefined;
      }
      throw new WorkspaceSnapshotError();
    });
    if (info !== undefined && (!info.isFile() || info.isSymbolicLink())) {
      throw new WorkspaceSnapshotError();
    }
    await rm(path, { force: true });
  }

  purgeRun(runId: string): Promise<void> {
    return purgeWorkspaceSnapshots(this.snapshotRoot, runId);
  }
}
